package relay

import (
	"crypto/sha256"
	"encoding/base64"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Additive tables work with both SQLite and PostgreSQL and survive program rollback.
const publishSchema = `
CREATE TABLE IF NOT EXISTS publish_requests(device_hash TEXT PRIMARY KEY,user_code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,scopes TEXT NOT NULL,challenge TEXT NOT NULL,requester TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,last_poll_at BIGINT NOT NULL DEFAULT 0,user_id TEXT REFERENCES users(id),status TEXT NOT NULL DEFAULT 'pending');
CREATE INDEX IF NOT EXISTS publish_request_expiry ON publish_requests(expires_at);
CREATE TABLE IF NOT EXISTS publish_grants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,scopes TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,last_used_at BIGINT NOT NULL,revoked_at BIGINT);
CREATE TABLE IF NOT EXISTS publish_tokens(hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES publish_grants(id),kind TEXT NOT NULL,expires_at BIGINT NOT NULL,used_at BIGINT);
CREATE INDEX IF NOT EXISTS publish_token_grant ON publish_tokens(grant_id);
CREATE TABLE IF NOT EXISTS publish_audit(id TEXT PRIMARY KEY,at BIGINT NOT NULL,grant_id TEXT,user_id TEXT,action TEXT NOT NULL,target TEXT NOT NULL,outcome TEXT NOT NULL,code TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS publish_audit_time ON publish_audit(at);
`

const publishAccessMs int64 = 10 * 60 * 1000
const publishRefreshMs int64 = 30 * 24 * 60 * 60 * 1000
const publishGrantMs int64 = 90 * 24 * 60 * 60 * 1000

var publishProof = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var publishUserCode = regexp.MustCompile(`^[A-F0-9]{4}-[A-F0-9]{4}$`)

func loopbackHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	return strings.EqualFold(host, "localhost") || net.ParseIP(strings.Trim(host, "[]")) != nil && net.ParseIP(strings.Trim(host, "[]")).IsLoopback()
}

func (s *Server) publishingProxy(remote string) bool {
	if loopbackHost(remote) {
		return true
	}
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, value := range s.Options.TrustedProxies {
		if configured := net.ParseIP(value); configured != nil && configured.Equal(ip) {
			return true
		}
		if _, network, e := net.ParseCIDR(value); e == nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

// Never infer a public origin from untrusted forwarding headers. A TLS proxy is
// supported only on loopback with an explicitly configured HTTPS public origin.
func (s *Server) publishTransport(r *http.Request) string {
	wOrigin := "https://" + r.Host
	if r.TLS != nil {
		return wOrigin
	}
	if loopbackHost(r.Host) && loopbackHost(r.RemoteAddr) && r.Header.Get("X-Forwarded-Proto") == "" && r.Header.Get("Forwarded") == "" {
		return "http://" + r.Host
	}
	u, err := url.Parse(s.Options.PublicURL)
	if err == nil && u.Scheme == "https" && u.User == nil && (u.Path == "" || u.Path == "/") && u.RawQuery == "" && u.Fragment == "" && strings.EqualFold(u.Host, r.Host) && s.publishingProxy(r.RemoteAddr) && r.Header.Get("X-Forwarded-Proto") == "https" {
		return u.Scheme + "://" + u.Host
	}
	fail(403, "publishing-requires-https")
	return ""
}

func publishScopes(v any) string {
	raw, ok := v.([]any)
	if !ok || len(raw) == 0 || len(raw) > 4 {
		fail(400, "invalid-publishing-scopes")
	}
	selected := map[string]bool{}
	for _, x := range raw {
		k, ok := x.(string)
		if !ok || !(k == "server:read" || k == "server:write" || k == "clients:read" || k == "clients:write") || selected[k] {
			fail(400, "invalid-publishing-scopes")
		}
		selected[k] = true
	}
	out := []string{}
	for _, k := range []string{"server:read", "server:write", "clients:read", "clients:write"} {
		if selected[k] {
			out = append(out, k)
		}
	}
	return strings.Join(out, " ")
}
func scopeList(v any) []string { return strings.Fields(str(v)) }

func (s *Store) publishAudit(p *Principal, action, target, outcome, code string) {
	grant, user := "", ""
	if p != nil {
		grant, user = p.Grant, p.ID
	}
	if runes := []rune(target); len(runes) > 180 {
		target = string(runes[:180])
	}
	s.Q("INSERT INTO publish_audit(id,at,grant_id,user_id,action,target,outcome,code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", uuid(), now(), grant, user, action, target, outcome, code)
	s.Q("DELETE FROM publish_audit WHERE id IN (SELECT id FROM publish_audit ORDER BY at DESC,id DESC LIMIT 100000 OFFSET 10000)")
}

func (s *Store) publishPrincipal(value, scope string) *Principal {
	row := s.One("SELECT g.id,g.user_id,g.scopes,t.expires_at FROM publish_tokens t JOIN publish_grants g ON g.id=t.grant_id JOIN users u ON u.id=g.user_id WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>$2 AND g.expires_at>$2 AND g.revoked_at IS NULL AND u.revoked_at IS NULL AND u.role='admin' AND u.password_hash IS NOT NULL", hash(value), now())
	if row == nil {
		fail(401, "unauthorized")
	}
	if scope != "any" && !strings.Contains(" "+str(row["scopes"])+" ", " "+scope+" ") {
		fail(403, "publishing-scope-denied")
	}
	return &Principal{ID: str(row["user_id"]), Kind: "publisher", Grant: str(row["id"]), Hash: hash(value), Expires: num(row["expires_at"])}
}

func (s *Store) publishTokens(grant M) M {
	at := now()
	s.Q("DELETE FROM publish_tokens WHERE expires_at<=$1", at)
	access, refresh := "cdxp_a_"+token(32), "cdxp_r_"+token(32)
	expiry, refreshExpiry := min(at+publishAccessMs, num(grant["expires_at"])), min(at+publishRefreshMs, num(grant["expires_at"]))
	s.Q("INSERT INTO publish_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',$3)", hash(access), grant["id"], expiry)
	s.Q("INSERT INTO publish_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'refresh',$3)", hash(refresh), grant["id"], refreshExpiry)
	s.Q("UPDATE publish_grants SET last_used_at=$2 WHERE id=$1", grant["id"], at)
	return M{"accessToken": access, "refreshToken": refresh, "expiresAt": expiry, "refreshExpiresAt": refreshExpiry, "grantExpiresAt": grant["expires_at"], "grantId": grant["id"], "scopes": scopeList(grant["scopes"]), "username": grant["username"]}
}

func (s *Server) publishRoutes() {
	s.route("POST /v1/publish/authorize", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		origin := s.publishTransport(r)
		if !s.originAllowed(r) {
			fail(403, "origin-denied")
		}
		b := body(r)
		name, proof := strings.TrimSpace(str(b["name"])), str(b["challenge"])
		if name == "" || jsLength(name) > 100 || strings.ContainsAny(name, "\r\n\x00") || !publishProof.MatchString(proof) {
			fail(400, "invalid-publishing-request")
		}
		scopes := publishScopes(b["scopes"])
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		s.auth.Lock()
		defer s.auth.Unlock()
		s.Store.Q("DELETE FROM publish_requests WHERE expires_at<=$1", now())
		if num(s.Store.One("SELECT COUNT(*) AS n FROM publish_requests WHERE requester=$1", host)["n"]) >= 10 || num(s.Store.One("SELECT COUNT(*) AS n FROM publish_requests")["n"]) >= 1000 {
			fail(429, "rate-limited")
		}
		device := token(32)
		code := strings.ToUpper(hash(token(32))[:8])
		code = code[:4] + "-" + code[4:]
		s.Store.Q("INSERT INTO publish_requests(device_hash,user_code,name,scopes,challenge,requester,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", hash(device), code, name, scopes, proof, host, now(), now()+600000)
		w.Header().Set("Cache-Control", "no-store")
		return M{"deviceCode": device, "userCode": code, "verificationUri": origin + "/admin/?publish=" + code, "expiresIn": 600, "interval": 5}
	})
	s.route("GET /v1/admin/publishing/request", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.publishTransport(r)
		code := strings.ToUpper(r.URL.Query().Get("code"))
		if !publishUserCode.MatchString(code) {
			fail(400, "invalid-authorization-code")
		}
		row := s.Store.One("SELECT user_code,name,scopes,created_at,expires_at,status FROM publish_requests WHERE user_code=$1 AND expires_at>$2", code, now())
		if row == nil {
			fail(404, "authorization-request-expired")
		}
		return M{"code": row["user_code"], "name": row["name"], "scopes": scopeList(row["scopes"]), "createdAt": row["created_at"], "expiresAt": row["expires_at"], "status": row["status"]}
	})
	s.route("POST /v1/admin/publishing/approve", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.publishTransport(r)
		if !s.originAllowed(r) {
			fail(403, "origin-denied")
		}
		b := body(r)
		code := strings.ToUpper(str(b["code"]))
		if !publishUserCode.MatchString(code) {
			fail(400, "invalid-authorization-code")
		}
		status := "denied"
		if b["approve"] == true {
			status = "approved"
		} else if b["approve"] != false {
			fail(400, "invalid-request")
		}
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		s.principal(r, "admin")
		row := s.Store.One("UPDATE publish_requests SET status=$2,user_id=$3 WHERE user_code=$1 AND status='pending' AND expires_at>$4 RETURNING name", code, status, p.ID, now())
		if row == nil {
			fail(409, "authorization-request-unavailable")
		}
		s.Store.publishAudit(p, "authorization-"+status, str(row["name"]), "succeeded", "")
		return M{"status": status}
	})
	s.route("POST /v1/publish/token", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		s.publishTransport(r)
		if !s.originAllowed(r) {
			fail(403, "origin-denied")
		}
		b := body(r)
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		s.auth.Lock()
		defer s.auth.Unlock()
		var result M
		problem := ""
		s.Store.Tx(func(t *Store) {
			if b["grantType"] == "device_code" {
				device, verifier := str(b["deviceCode"]), str(b["verifier"])
				if !publishProof.MatchString(device) || !publishProof.MatchString(verifier) {
					problem = "invalid-publishing-credential"
					return
				}
				row := t.One("SELECT * FROM publish_requests WHERE device_hash=$1 FOR UPDATE", hash(device))
				proof := sha256.Sum256([]byte(verifier))
				if row == nil || num(row["expires_at"]) <= now() || str(row["challenge"]) != base64.RawURLEncoding.EncodeToString(proof[:]) {
					problem = "authorization-expired-or-invalid"
					return
				}
				if num(row["last_poll_at"]) > now()-5000 {
					problem = "slow-down"
					return
				}
				t.Q("UPDATE publish_requests SET last_poll_at=$2 WHERE device_hash=$1", hash(device), now())
				if row["status"] == "pending" {
					problem = "authorization-pending"
					return
				}
				if row["status"] != "approved" {
					problem = "authorization-denied-or-consumed"
					return
				}
				user := t.One("SELECT name FROM users WHERE id=$1 AND role='admin' AND revoked_at IS NULL AND password_hash IS NOT NULL", row["user_id"])
				if user == nil {
					problem = "authorization-denied-or-consumed"
					return
				}
				t.Q("UPDATE publish_requests SET status='consumed' WHERE device_hash=$1", hash(device))
				id, at := uuid(), now()
				t.Q("INSERT INTO publish_grants(id,user_id,name,scopes,created_at,expires_at,last_used_at) VALUES($1,$2,$3,$4,$5,$6,$5)", id, row["user_id"], row["name"], row["scopes"], at, at+publishGrantMs)
				result = t.publishTokens(M{"id": id, "expires_at": at + publishGrantMs, "scopes": row["scopes"], "username": user["name"]})
				t.publishAudit(&Principal{ID: str(row["user_id"]), Grant: id}, "authorization-issued", str(row["name"]), "succeeded", "")
			} else if b["grantType"] == "refresh_token" {
				refresh := str(b["refreshToken"])
				if !strings.HasPrefix(refresh, "cdxp_r_") || len(refresh) != 50 {
					problem = "invalid-publishing-credential"
					return
				}
				row := t.One("SELECT t.used_at,t.expires_at AS token_expiry,g.*,u.name AS username,u.revoked_at AS user_revoked,u.password_hash,u.role FROM publish_tokens t JOIN publish_grants g ON g.id=t.grant_id JOIN users u ON u.id=g.user_id WHERE t.hash=$1 AND t.kind='refresh' FOR UPDATE", hash(refresh))
				if row == nil || row["revoked_at"] != nil || row["user_revoked"] != nil || row["password_hash"] == nil || row["role"] != "admin" || num(row["expires_at"]) <= now() || num(row["token_expiry"]) <= now() {
					problem = "invalid-publishing-credential"
					return
				}
				if row["used_at"] != nil {
					t.Q("UPDATE publish_grants SET revoked_at=$2 WHERE id=$1", row["id"], now())
					t.publishAudit(&Principal{ID: str(row["user_id"]), Grant: str(row["id"])}, "refresh-reuse", "", "rejected", "refresh-reused")
					problem = "refresh-reused-reauthorize"
					return
				}
				t.Q("UPDATE publish_tokens SET used_at=$2 WHERE hash=$1", hash(refresh), now())
				result = t.publishTokens(row)
			} else {
				problem = "invalid-grant-type"
			}
		})
		w.Header().Set("Cache-Control", "no-store")
		if problem != "" {
			status := 400
			if problem == "slow-down" {
				status = 429
			}
			fail(status, problem)
		}
		return result
	})
	s.route("GET /v1/publish/me", "publish:any", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		if p.Grant == "" {
			fail(403, "publishing-credential-required")
		}
		row := s.Store.One("SELECT g.*,u.name AS username FROM publish_grants g JOIN users u ON u.id=g.user_id WHERE g.id=$1", p.Grant)
		return M{"grantId": p.Grant, "scopes": scopeList(row["scopes"]), "expiresAt": p.Expires, "grantExpiresAt": row["expires_at"], "username": row["username"]}
	})
	s.route("POST /v1/publish/revoke", "publish:any", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		if p.Grant == "" {
			fail(403, "publishing-credential-required")
		}
		s.exclusive.Lock()
		defer s.exclusive.Unlock()
		s.principal(r, "publish:any")
		s.Store.Q("UPDATE publish_grants SET revoked_at=$2 WHERE id=$1", p.Grant, now())
		s.Store.publishAudit(p, "authorization-revoked", "self", "succeeded", "")
		return M{"ok": true}
	})
	s.route("GET /v1/admin/publishing", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		rows := s.Store.Q("SELECT g.id,g.name,g.scopes,g.created_at,g.expires_at,g.last_used_at,g.revoked_at,u.name AS username FROM publish_grants g JOIN users u ON u.id=g.user_id ORDER BY g.created_at DESC LIMIT 500")
		return M{"grants": rows, "audit": s.Store.Q("SELECT * FROM publish_audit ORDER BY at DESC,id DESC LIMIT 200")}
	})
	s.route("DELETE /v1/admin/publishing/{grantId}", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		if !s.originAllowed(r) {
			fail(403, "origin-denied")
		}
		s.exclusive.Lock()
		defer s.exclusive.Unlock()
		s.principal(r, "admin")
		id := r.PathValue("grantId")
		if !uuidPattern.MatchString(id) {
			fail(400, "invalid-request")
		}
		row := s.Store.One("UPDATE publish_grants SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING name", id, now())
		if row == nil {
			fail(404, "authorization-not-found")
		}
		s.Store.publishAudit(p, "authorization-revoked", id, "succeeded", "")
		return M{"ok": true}
	})
}
