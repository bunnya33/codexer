package relay

import (
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var uuidPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func (s *Server) routes() {
	s.route("GET /health", "", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		return M{"ok": true, "protocolVersion": 1, "version": s.Options.Version}
	})
	s.route("OPTIONS /v1/{path...}", "", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		if r.Header.Get("Origin") == "" || !s.originAllowed(r) {
			fail(403, "origin-denied")
		}
		w.WriteHeader(204)
		return nil
	})
	for path, role := range map[string]string{"/v1/auth/login": "user", "/v1/admin/auth/login": "admin", "/v1/agents/login": "user"} {
		path, role := path, role
		s.route("POST "+path, "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
			if !s.originAllowed(r) {
				fail(403, "origin-denied")
			}
			b := body(r)
			username := strings.TrimSpace(requestString(b, "username"))
			password := requestString(b, "password")
			if username == "" || jsLength(username) > 100 || len(password) < 1 || jsLength(password) > 128 {
				fail(400, "invalid-request")
			}
			s.auth.Lock()
			defer s.auth.Unlock()
			p := s.Store.CheckPassword(username, password, role)
			if p == nil {
				fail(401, "invalid-credentials")
			}
			device := ""
			if path == "/v1/agents/login" {
				installation, name, platform := requestString(b, "installationId"), strings.TrimSpace(requestString(b, "name")), requestString(b, "platform")
				if !uuidPattern.MatchString(installation) || name == "" || jsLength(name) > 200 || !(platform == "win32" || platform == "darwin" || platform == "linux") {
					fail(400, "invalid-request")
				}
				device = s.Store.Register(p.ID, installation, name, platform)
				if a := s.agent(device); a != nil {
					s.CloseSessions(func(p *Principal) bool { return p.Device == device }, "agent-login-replaced")
				}
			}
			result := s.Store.CreateSession(p.ID, device)
			result["userId"] = p.ID
			if device != "" {
				result["deviceId"] = device
			} else {
				result["role"] = role
				result["username"] = username
			}
			return result
		})
	}
	s.route("POST /v1/auth/logout", "member", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.Store.Logout(p.Hash)
		s.CloseSessions(func(v *Principal) bool { return v.Hash == p.Hash }, "logged-out")
		return M{"loggedOut": true}
	})
	s.route("GET /v1/me", "member", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		return M{"role": p.Kind, "userId": p.ID}
	})
	s.route("POST /v1/auth/active", "member", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		value := s.Store.TouchSession(p.Hash)
		if value == nil {
			fail(401, "unauthorized")
		}
		return value
	})
	s.route("POST /v1/ws/tickets", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any { return s.Store.Ticket(p) })
	s.route("GET /v1/admin/auth-settings", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		return M{"idleTimeoutMinutes": s.Store.IdleTimeout()}
	})
	s.route("PUT /v1/admin/auth-settings", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		b := body(r)
		value, ok := b["idleTimeoutMinutes"].(float64)
		if len(b) != 1 || !ok || float64(int64(value)) != value {
			fail(400, "invalid-request")
		}
		return s.Store.Settings(num(b["idleTimeoutMinutes"]))
	})
	for path, role := range map[string]string{"/v1/users": "user", "/v1/admin/accounts": "admin"} {
		path, role := path, role
		s.route("GET "+path, "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
			result := M{"users": s.Store.Users(role)}
			if role == "admin" {
				result["currentUserId"] = p.ID
			}
			return result
		})
		s.route("POST "+path, "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
			b := body(r)
			return s.Store.CreateUser(requestString(b, "username"), requestString(b, "password"), role)
		})
		s.route("DELETE "+path+"/{userId}", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
			id := r.PathValue("userId")
			if !s.Store.DisableUser(id, role, p.ID) {
				if role == "admin" {
					fail(404, "admin-not-found")
				}
				fail(404, "user-not-found-or-admin")
			}
			s.CloseSessions(func(v *Principal) bool { return v.ID == id }, "account-disabled")
			return M{"revoked": true}
		})
		s.route("PUT "+path+"/{userId}/password", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
			id := r.PathValue("userId")
			if !s.Store.ResetUser(id, requestString(body(r), "password"), role) {
				fail(404, role+"-not-found")
			}
			s.CloseSessions(func(v *Principal) bool { return v.ID == id }, "password-reset")
			return M{"reset": true}
		})
	}
	s.route("GET /v1/admin/overview", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		users, admins := s.Store.Users("user"), s.Store.Users("admin")
		enabled := func(rows []M) int {
			n := 0
			for _, v := range rows {
				if v["revoked_at"] == nil && boolean(v["login_enabled"]) {
					n++
				}
			}
			return n
		}
		s.mu.Lock()
		devices := len(s.agents)
		clients := 0
		for p := range s.clients {
			if p.Principal() != nil {
				clients++
			}
		}
		s.mu.Unlock()
		return M{"users": len(users), "admins": len(admins), "enabledUsers": enabled(users), "enabledAdmins": enabled(admins), "onlineDevices": devices, "onlineClients": clients, "uptime": int(time.Since(s.metrics.start).Seconds())}
	})
	s.route("GET /v1/admin/metrics", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		return s.MetricSnapshot()
	})
	s.route("GET /v1/devices", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		devices := s.Store.Devices(p)
		for _, d := range devices {
			d["online"] = s.agent(str(d["id"])) != nil
		}
		return M{"devices": devices}
	})
	s.route("DELETE /v1/devices/{deviceId}", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.deviceAccess(r, p)
		id := r.PathValue("deviceId")
		s.lane(id, func() {
			s.Store.Q("UPDATE devices SET revoked_at=$2 WHERE id=$1", id, now())
			if a := s.agent(id); a != nil {
				a.Close(4003, "revoked")
			}
			s.FailPending(id, "device-revoked")
		})
		return M{"revoked": true}
	})
	s.route("GET /v1/agent/{deviceId}/session", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		if s.Store.Session(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), r.PathValue("deviceId")) == nil {
			fail(401, "unauthorized")
		}
		return M{"active": true}
	})
	for _, name := range []string{"snapshot", "catalog"} {
		name := name
		s.route("GET /v1/devices/{deviceId}/"+name, "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
			s.deviceAccess(r, p)
			var result M
			s.lane(r.PathValue("deviceId"), func() {
				if name == "snapshot" {
					result = s.Store.Snapshot(r.PathValue("deviceId"))
				} else {
					result = s.Store.Catalog(r.PathValue("deviceId"))
				}
			})
			if result == nil {
				if name == "catalog" {
					fail(404, "catalog-not-ready")
				}
				fail(404, "snapshot-not-found")
			}
			if name == "catalog" {
				return M{"catalog": result}
			}
			return M{"snapshot": result, "online": s.agent(r.PathValue("deviceId")) != nil}
		})
	}
	s.route("POST /v1/devices/{deviceId}/commands", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.deviceAccess(r, p)
		command := body(r)
		raw, _ := io.ReadAll(r.Body)
		s.Validate("command", command)
		if str(command["deviceId"]) != r.PathValue("deviceId") {
			fail(400, "device-mismatch")
		}
		var result M
		s.lane(r.PathValue("deviceId"), func() { s.deviceAccess(r, p); result = s.Submit(command, raw) })
		return result
	})
	s.route("GET /v1/devices/{deviceId}/commands/{commandId}", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.deviceAccess(r, p)
		c := s.Store.Command(r.PathValue("deviceId"), r.PathValue("commandId"))
		if c == nil {
			fail(404, "command-not-found")
		}
		return M{"commandId": r.PathValue("commandId"), "status": c["status"], "result": c["result"]}
	})
	s.mux.HandleFunc("GET /v1/ws/device", s.deviceSocket)
	s.mux.HandleFunc("GET /v1/ws/client", s.clientSocket)
	s.transferRoutes()
	s.previewRoutes()
	s.weixinRoutes()
	s.updateRoutes()
	s.mux.HandleFunc("GET /admin", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/admin/", 302) })
	s.mux.HandleFunc("/v1/", http.NotFound)
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.NotFound(w, r)
			return
		}
		s.static(w, r)
	})
}
