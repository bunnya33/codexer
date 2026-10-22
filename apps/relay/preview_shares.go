package relay

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"html"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func previewToken() string {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		panic(err)
	}
	return hex.EncodeToString(data)
}

// The persistent key is independent of login sessions and of each visitor's
// temporary preview/cookie jar. A key grants access only to this explicit source.
func (s *Store) PublicPreviewShare(key string) M {
	if !hex64.MatchString(key) {
		return nil
	}
	return s.One("SELECT p.* FROM preview_shares p JOIN devices d ON d.id=p.device_id JOIN users u ON u.id=p.user_id WHERE p.token=$1 AND p.enabled=TRUE AND p.expires_at>$2 AND d.owner_user_id=p.user_id AND d.revoked_at IS NULL AND u.revoked_at IS NULL AND u.role='user'", key, now())
}

const maxPreviewShareMinutes = 365 * 24 * 60

func previewShareMinutes(body M) int64 {
	if _, exists := body["durationMinutes"]; !exists {
		return 30
	}
	value, ok := body["durationMinutes"].(float64)
	if !ok || value < 1 || value > maxPreviewShareMinutes || value != float64(int64(value)) {
		fail(400, "invalid-preview-share-duration")
	}
	return int64(value)
}

type previewShareTimer struct {
	expires int64
	timer   *time.Timer
}

// Keep the earliest timer when a deadline changes. If a share was extended,
// that timer rereads the durable deadline and rearms without dropping visitors.
func (s *Server) armPreviewShare(key string, expires int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing.Load() {
		return
	}
	if old := s.shareTimers[key]; old != nil {
		if old.expires <= expires {
			return
		}
		old.timer.Stop()
	}
	entry := &previewShareTimer{expires: expires}
	s.shareTimers[key] = entry
	entry.timer = time.AfterFunc(time.Duration(max(int64(1), expires-now()))*time.Millisecond, func() {
		if !s.beginJob() {
			return
		}
		defer s.wg.Done()
		s.mu.Lock()
		if s.shareTimers[key] != entry {
			s.mu.Unlock()
			return
		}
		delete(s.shareTimers, key)
		s.mu.Unlock()
		owner := s.Store.One("SELECT device_id FROM preview_shares WHERE token=$1", key)
		s.lane(str(owner["device_id"]), func() {
			if row := s.Store.PublicPreviewShare(key); row != nil {
				s.armPreviewShare(key, num(row["expires_at"]))
			} else {
				s.closePreviewShare(key)
			}
		})
	})
}

func shareSource(kind, source string) (string, string, string) {
	if kind == "audio" {
		if source == "" || jsLength(source) > 4096 || strings.ContainsAny(source, "\x00\r\n") || audioMIME(source) == "" {
			fail(400, "invalid-preview-source")
		}
		return source, "", "/audio"
	}
	if kind == "html" {
		if source == "" || jsLength(source) > 4096 || strings.ContainsAny(source, "\x00\r\n") || !(strings.HasSuffix(strings.ToLower(source), ".html") || strings.HasSuffix(strings.ToLower(source), ".htm")) {
			fail(400, "invalid-preview-source")
		}
		return source, "", "/index.html"
	}
	u, err := url.Parse(source)
	if kind != "server" || err != nil || !loopbackURL.MatchString(source) || u.User != nil || jsLength(source) > 2048 {
		fail(400, "invalid-preview-source")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	port := u.Port()
	if port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			fail(400, "invalid-preview-source")
		}
	}
	if u.Scheme == "http" && port == "80" || u.Scheme == "https" && port == "443" {
		host := u.Hostname()
		u.Host = host
		if strings.Contains(host, ":") {
			u.Host = "[" + host + "]"
		}
	}
	if u.Hostname() == "::1" && u.Port() == "" {
		u.Host = "[::1]"
	}
	origin := u.Scheme + "://" + u.Host
	u.Fragment = ""
	if u.Path == "" {
		u.Path = "/"
	}
	entry := u.RequestURI()
	if u.Hostname() == "localhost" {
		u.Host = "127.0.0.1"
		if port != "" && !(u.Scheme == "http" && port == "80" || u.Scheme == "https" && port == "443") {
			u.Host += ":" + port
		}
	}
	return u.String(), origin, entry
}

func shareResult(row M) M {
	return M{"id": row["id"], "path": "/share/" + str(row["token"]), "enabled": boolean(row["enabled"]) && num(row["expires_at"]) > now(), "kind": row["kind"], "expiresAt": num(row["expires_at"]), "durationMinutes": num(row["duration_minutes"])}
}

func (s *Server) sharePrincipal(key, device, thread string) *Principal {
	row := s.Store.PublicPreviewShare(key)
	if row == nil || str(row["device_id"]) != device || str(row["thread_id"]) != thread {
		fail(410, "preview-share-disabled")
	}
	return &Principal{ID: str(row["user_id"]), Kind: "user", Share: key}
}

func (s *Server) closePreviewShare(key string) {
	s.mu.Lock()
	if timer := s.shareTimers[key]; timer != nil {
		timer.timer.Stop()
		delete(s.shareTimers, key)
	}
	for token, p := range s.previews {
		if p.Principal.Share == key {
			delete(s.previews, token)
		}
	}
	values := []*Pending{}
	for id, p := range s.pending {
		if p.Principal != nil && p.Principal.Share == key {
			delete(s.pending, id)
			values = append(values, p)
		}
	}
	s.mu.Unlock()
	for _, p := range values {
		p.Reject(Fault{410, "preview-share-disabled"})
	}
}

func (s *Server) checkShareSource(r *http.Request, p *Principal, kind, source, origin, entry string) {
	if kind == "html" || kind == "audio" {
		info := s.requestTransfer(r, p, "file", M{"path": source})
		if kind == "audio" && audioMIME(str(info["name"])) == "" {
			fail(400, "unsupported-audio")
		}
		if kind == "html" && num(info["size"]) > 2*1024*1024 {
			fail(413, "preview-html-too-large")
		}
		return
	}
	a := s.agent(r.PathValue("deviceId"))
	if a == nil {
		fail(409, "device-offline")
	}
	a.mu.Lock()
	supported := a.previews
	a.mu.Unlock()
	if !supported {
		fail(409, "agent-update-required")
	}
	v := &Preview{Device: r.PathValue("deviceId"), Thread: r.PathValue("threadId"), Principal: p}
	pending := s.previewRequest(v, "")
	defer func() { s.removePending(pending.ID); a.Send(M{"type": "preview.cancel", "requestId": pending.ID}) }()
	if !a.Send(M{"type": "preview.request", "requestId": pending.ID, "threadId": v.Thread, "origin": origin, "path": entry, "method": "HEAD", "headers": M{}}) {
		fail(409, "device-offline")
	}
	event := s.wait(r.Context(), pending, 25*time.Second)
	if event["type"] == "error" {
		fail(404, str(event["code"]))
	}
	if event["type"] != "headers" {
		fail(502, "invalid-preview-response")
	}
}

func (s *Server) previewShareRoutes() {
	endpoint := "/v1/devices/{deviceId}/threads/{threadId}/preview-shares"
	s.route("GET "+endpoint, "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.deviceAccess(r, p)
		source, _, _ := shareSource(r.URL.Query().Get("kind"), r.URL.Query().Get("source"))
		row := s.Store.One("SELECT * FROM preview_shares WHERE device_id=$1 AND kind=$2 AND source=$3 AND user_id=$4", r.PathValue("deviceId"), r.URL.Query().Get("kind"), source, p.ID)
		w.Header().Set("Cache-Control", "no-store")
		if row == nil {
			return M{"share": nil}
		}
		return M{"share": shareResult(row)}
	})
	s.route("POST "+endpoint, "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		device, thread := r.PathValue("deviceId"), r.PathValue("threadId")
		s.authorizeThread(p, device, thread, false)
		b := body(r)
		minutes := previewShareMinutes(b)
		kind := str(b["kind"])
		source, origin, entry := shareSource(kind, str(b["source"]))
		// localhost and 127.0.0.1 identify the same endpoint; retain the observed
		// spelling when reusing a grant so the Agent's existing allowlist still matches.
		if kind == "server" {
			if known := s.Store.One("SELECT origin FROM preview_shares WHERE device_id=$1 AND kind=$2 AND source=$3 AND user_id=$4 AND thread_id=$5", device, kind, source, p.ID, thread); known != nil {
				origin = str(known["origin"])
			}
		}
		s.checkShareSource(r, p, kind, source, origin, entry)
		var row M
		s.lane(device, func() {
			s.authorizeThread(p, device, thread, false)
			before := s.Store.One("SELECT * FROM preview_shares WHERE device_id=$1 AND kind=$2 AND source=$3", device, kind, source)
			if before == nil && num(s.Store.One("SELECT COUNT(*) AS total FROM preview_shares WHERE user_id=$1", p.ID)["total"]) >= 100 {
				fail(429, "preview-shares-busy")
			}
			key := previewToken()
			if before != nil && b["rotate"] != true {
				key = str(before["token"])
			}
			created := now()
			row = s.Store.One("INSERT INTO preview_shares(id,user_id,device_id,thread_id,kind,source,origin,entry_path,token,enabled,created_at,expires_at,duration_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11,$12) ON CONFLICT(device_id,kind,source) DO UPDATE SET thread_id=EXCLUDED.thread_id,origin=EXCLUDED.origin,entry_path=EXCLUDED.entry_path,token=EXCLUDED.token,enabled=TRUE,expires_at=EXCLUDED.expires_at,duration_minutes=EXCLUDED.duration_minutes RETURNING *", uuid(), p.ID, device, thread, kind, source, origin, entry, key, created, created+minutes*60000, minutes)
			if before != nil && (key != str(before["token"]) || thread != str(before["thread_id"])) {
				s.closePreviewShare(str(before["token"]))
			}
			s.armPreviewShare(key, num(row["expires_at"]))
		})
		w.Header().Set("Cache-Control", "no-store")
		return shareResult(row)
	})
	s.route("DELETE /v1/devices/{deviceId}/preview-shares/{shareId}", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.deviceAccess(r, p)
		s.lane(r.PathValue("deviceId"), func() {
			row := s.Store.One("UPDATE preview_shares SET enabled=FALSE WHERE id=$1 AND user_id=$2 AND device_id=$3 RETURNING token", r.PathValue("shareId"), p.ID, r.PathValue("deviceId"))
			if row == nil {
				fail(404, "preview-share-not-found")
			}
			s.closePreviewShare(str(row["token"]))
		})
		return M{"disabled": true}
	})
	s.mux.HandleFunc("GET /share/{key}", s.sharedPreviewPage)
	s.mux.HandleFunc("GET /share/{key}/{$}", s.sharedPreviewPage)
	s.mux.HandleFunc("GET /share/{key}/audio", s.sharedAudioHTTP)
}

func (s *Server) sharedPreviewPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// The shell is trusted; all remotely supplied HTML remains in an opaque frame.
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	var document string
	status := 200
	func() {
		defer func() {
			if e := recover(); e != nil {
				status = 503
				message := "分享内容暂不可用，请稍后重试。"
				if f, ok := e.(Fault); ok {
					switch f.Code {
					case "preview-share-disabled":
						status = 410
						message = "分享已停用、到期或链接已更新。"
					case "device-offline":
						message = "电脑暂时离线，重新连接后此链接会恢复。"
					case "thread-not-in-catalog":
						message = "分享来源暂不可用。"
					}
				}
				document = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>内容分享</title><style>body{font:16px system-ui;margin:10vh auto;padding:24px;max-width:540px;color:#334155}a{color:#176b91}</style><h1>分享暂不可用</h1><p>` + html.EscapeString(message) + `</p><a href="">重新加载</a>`
			}
		}()
		row := s.Store.PublicPreviewShare(r.PathValue("key"))
		if row == nil {
			fail(410, "preview-share-disabled")
		}
		s.armPreviewShare(r.PathValue("key"), num(row["expires_at"]))
		if row["kind"] == "audio" {
			document = s.sharedAudioPage(w, r, row)
			return
		}
		p := &Principal{ID: str(row["user_id"]), Kind: "user", Share: r.PathValue("key")}
		v := &Preview{Device: str(row["device_id"]), Thread: str(row["thread_id"]), Origin: str(row["origin"]), FilePath: "", Channel: previewToken(), Principal: p, Expires: now() + 86400000, Cookies: map[string]string{}}
		if row["kind"] == "html" {
			v.FilePath = str(row["source"])
		}
		if !s.Store.InCatalog(v.Device, v.Thread, false) {
			fail(404, "thread-not-in-catalog")
		}
		if s.agent(v.Device) == nil {
			fail(409, "device-offline")
		}
		token := previewToken()
		cookieName := "codexer_preview_guest"
		if cookie, err := r.Cookie(cookieName); err == nil && hex64.MatchString(cookie.Value) {
			s.mu.Lock()
			old := s.previews[cookie.Value]
			s.mu.Unlock()
			if old != nil && old.Expires > now() && old.Principal.Share == p.Share && old.Thread == v.Thread {
				token = cookie.Value
				v = old
			}
		}
		s.mu.Lock()
		count := 0
		for key, old := range s.previews {
			if old.Expires <= now() {
				delete(s.previews, key)
			} else if old.Principal.ID == p.ID && old.Principal.Share != "" {
				count++
			}
		}
		_, existing := s.previews[token]
		if !existing && (len(s.previews) >= 1000 || count >= 100) {
			s.mu.Unlock()
			fail(429, "previews-busy")
		}
		s.previews[token] = v
		s.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/share/" + p.Share, HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteLaxMode, MaxAge: 86400})
		frame := "/v1/previews/" + token + str(row["entry_path"])
		document = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>网页分享</title><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe title="分享的网页" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="` + html.EscapeString(frame) + `"></iframe><script>const f=document.querySelector('iframe'),channel=` + scriptJSON(v.Channel) + `;addEventListener('message',e=>{if(e.source!==f.contentWindow||e.data?.channel!==channel)return;if(e.data.type==='state')f.contentWindow.postMessage({channel,type:'state-result',id:e.data.id,ok:true},'*')});const expires=Date.now()+` + strconv.FormatInt(max(int64(0), num(row["expires_at"])-now()), 10) + `;function checkExpiry(){const remaining=expires-Date.now();if(remaining<=0){location.reload();return}setTimeout(checkExpiry,Math.min(remaining,2147483647))}checkExpiry();addEventListener('pageshow',()=>{if(Date.now()>=expires)location.reload()});</script></body></html>`
	}()
	w.WriteHeader(status)
	w.Write([]byte(document))
}

func (s *Server) sharedPreviewError(w http.ResponseWriter, r *http.Request, p *Preview) {
	if e := recover(); e != nil {
		if e == http.ErrAbortHandler || p.Principal.Share == "" || !strings.Contains(r.Header.Get("Accept"), "text/html") {
			panic(e)
		}
		status := 503
		if f, ok := e.(Fault); ok {
			status = f.Status
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
		w.WriteHeader(status)
		w.Write([]byte(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;padding:32px;color:#334155}</style><h2>网页暂不可用</h2><p>请确认电脑在线，网页服务或源页面仍可访问，然后重新加载。有效期内，原分享链接会在恢复后继续生效。</p>`))
	}
}

func (s *Server) sharedHTML(w http.ResponseWriter, r *http.Request, p *Preview) {
	if r.Method != "GET" && r.Method != "HEAD" {
		fail(405, "method-not-allowed")
	}
	if r.PathValue("path") != "index.html" {
		fail(404, "preview-page-not-found")
	}
	r = r.Clone(r.Context())
	r.SetPathValue("deviceId", p.Device)
	r.SetPathValue("threadId", p.Thread)
	info := s.requestTransfer(r, p.Principal, "file", M{"path": p.FilePath})
	size := num(info["size"])
	if size > 2*1024*1024 {
		fail(413, "preview-html-too-large")
	}
	content := make([]byte, 0, size)
	for offset := int64(0); offset < size; {
		file := s.requestTransfer(r, p.Principal, "file", M{"path": p.FilePath, "offset": offset, "version": info["version"]})
		chunk, e := base64.StdEncoding.DecodeString(str(file["base64"]))
		if e != nil || len(chunk) == 0 || num(file["size"]) != size {
			fail(502, "invalid-file-response")
		}
		content = append(content, chunk...)
		offset += int64(len(chunk))
	}
	if !utf8.Valid(content) {
		fail(422, "invalid-preview-html")
	}
	s.sharePrincipal(p.Principal.Share, p.Device, p.Thread)
	local := previewAssetSources(r, r.PathValue("token"))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", previewResponseCSP(local))
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method != "HEAD" {
		w.Write([]byte(previewDocument(string(content), p.Channel, nil, local)))
	}
}
