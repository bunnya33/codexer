package relay

import (
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"github.com/gorilla/websocket"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed protocol/preview-bootstrap.html
var previewBootstrap string

//go:embed protocol/preview-runtime.js
var previewRuntime string

//go:embed protocol/preview.css
var previewCSS string
var hex64 = regexp.MustCompile(`^[a-f0-9]{64}$`)
var loopbackURL = regexp.MustCompile(`(?i)^https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)`)
var htmlHead = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
var htmlAttrs = regexp.MustCompile(`(?i)(\b(?:src|href|action|poster)\s*=\s*)(['"])(/[^'"]*|https?://(?:localhost|127\.0\.0\.1|\[::1\])[^'"]*)(['"])`)
var inlineScript = regexp.MustCompile(`(?is)<script\b([^>]*)>(.*?)</script>`)
var jsURLs = regexp.MustCompile(`(\b(?:from|import)\s*|\bimport\s*\(\s*|\b(?:fetch|Worker)\s*\(\s*|\bnew\s+URL\s*\(\s*)(['"])(/[^'"\n]*)(['"])`)
var cssURLs = regexp.MustCompile(`url\(\s*(['"]?)(/[^)'"\s]+)(['"]?)\s*\)`)

func rewritePreview(text, kind, prefix, origin, path string) string {
	mapURL := func(v string) string {
		if strings.HasPrefix(v, prefix) {
			return v
		}
		if strings.HasPrefix(v, origin+"/") {
			return prefix + strings.TrimPrefix(v, origin+"/")
		}
		if strings.HasPrefix(v, "/") && !strings.HasPrefix(v, "//") {
			return prefix + v[1:]
		}
		return v
	}
	rewriteJS := func(t string) string {
		return jsURLs.ReplaceAllStringFunc(t, func(v string) string {
			m := jsURLs.FindStringSubmatch(v)
			if m[2] != m[4] {
				return v
			}
			return m[1] + m[2] + mapURL(m[3]) + m[4]
		})
	}
	rewriteCSS := func(t string) string {
		return cssURLs.ReplaceAllStringFunc(t, func(v string) string {
			m := cssURLs.FindStringSubmatch(v)
			if m[1] != m[3] {
				return v
			}
			return "url(" + m[1] + mapURL(m[2]) + m[3] + ")"
		})
	}
	if strings.Contains(kind, "javascript") || strings.Contains(kind, "ecmascript") {
		return rewriteJS(text)
	}
	if strings.Contains(kind, "text/css") {
		return rewriteCSS(text)
	}
	if !strings.Contains(kind, "text/html") {
		return text
	}
	text = htmlAttrs.ReplaceAllStringFunc(text, func(v string) string {
		m := htmlAttrs.FindStringSubmatch(v)
		if m[2] != m[4] {
			return v
		}
		return m[1] + m[2] + mapURL(m[3]) + m[4]
	})
	text = inlineScript.ReplaceAllStringFunc(text, func(v string) string {
		m := inlineScript.FindStringSubmatch(v)
		return "<script" + m[1] + ">" + rewriteJS(m[2]) + "</script>"
	})
	text = rewriteCSS(text)
	bootstrap := strings.NewReplacer("@@BASE@@", html.EscapeString(prefix+strings.TrimPrefix(path, "/")), "@@PREFIX@@", scriptJSON(prefix), "@@ORIGIN@@", scriptJSON(origin), "@@PATH@@", scriptJSON(path)).Replace(previewBootstrap)
	return injectHead(text, bootstrap)
}
func injectHead(text, head string) string {
	at := htmlHead.FindStringIndex(text)
	if at == nil {
		return head + text
	}
	return text[:at[1]] + head + text[at[1]:]
}
func previewDocument(text, channel string, state M) string {
	assets := "https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://fonts.bunny.net"
	csp := "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' " + assets + "; style-src 'self' 'unsafe-inline' " + assets + "; img-src 'self' data: blob: " + assets + "; font-src 'self' data: " + assets + "; media-src data: blob: " + assets + "; connect-src 'self' ws: wss: " + assets + "; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"
	var value any
	if state != nil {
		value = state
	}
	head := `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="` + csp + `"><style>` + previewCSS + `</style><script>(` + strings.ReplaceAll(previewRuntime, "</script", "<\\/script") + `)(` + scriptJSON(channel) + `,` + scriptJSON(value) + `);</script>`
	return injectHead(text, head)
}

type Preview struct {
	Device, Thread, Origin, Channel string
	Principal                       *Principal
	Expires                         int64
	State                           M
	mu                              sync.Mutex
	Cookies                         map[string]string
}

func (s *Server) previewFor(token string) *Preview {
	if !hex64.MatchString(token) {
		fail(400, "invalid-request")
	}
	s.mu.Lock()
	p := s.previews[token]
	s.mu.Unlock()
	if p == nil || p.Expires <= now() {
		fail(410, "preview-expired")
	}
	if s.Store.SessionHash(p.Principal.Hash, "") == nil || !s.Store.Owns(p.Device, p.Principal) {
		fail(401, "preview-revoked")
	}
	if !s.Store.InCatalog(p.Device, p.Thread, false) {
		fail(404, "thread-not-in-catalog")
	}
	a := s.agent(p.Device)
	if a == nil {
		fail(409, "device-offline")
	}
	a.mu.Lock()
	supported := a.previews
	a.mu.Unlock()
	if !supported {
		fail(409, "agent-update-required")
	}
	return p
}
func (s *Server) acceptPreview(device string, m M) {
	s.mu.Lock()
	p := s.pending[str(m["requestId"])]
	s.mu.Unlock()
	if p == nil || p.Kind != "preview" || p.Device != device {
		return
	}
	select {
	case p.Reply <- response{Value: obj(m["event"])}:
	default:
		p.Reject(Fault{429, "preview-backpressure"})
	}
}
func (s *Server) previewRequest(p *Preview, token string) *Pending {
	v := &Pending{Device: p.Device, Thread: p.Thread, Kind: "preview", ID: uuid(), Token: token, Principal: p.Principal, Reply: make(chan response, 32)}
	s.addPending(v, 128, 24)
	return v
}
func (s *Server) previewRoutes() {
	s.route("POST /v1/devices/{deviceId}/threads/{threadId}/previews", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.deviceAccess(r, p)
		b := body(r)
		raw, channel := str(b["url"]), str(b["channel"])
		u, e := url.Parse(raw)
		if e != nil || !loopbackURL.MatchString(raw) || u.User != nil || jsLength(raw) > 2048 || channel == "" || jsLength(channel) > 160 {
			fail(400, "invalid-preview-url")
		}
		data := make([]byte, 32)
		if _, e = rand.Read(data); e != nil {
			panic(e)
		}
		token := hex.EncodeToString(data)
		v := &Preview{Device: r.PathValue("deviceId"), Thread: r.PathValue("threadId"), Origin: u.Scheme + "://" + u.Host, Channel: channel, Principal: p, Expires: now() + 1800000, Cookies: map[string]string{}}
		if state, ok := b["state"].(map[string]any); ok {
			state = M{"modelContent": state["modelContent"], "privateContent": state["privateContent"]}
			if len(js(state)) <= 16384 {
				v.State = state
			}
		}
		s.mu.Lock()
		count := 0
		for t, x := range s.previews {
			if x.Expires <= now() {
				delete(s.previews, t)
			} else if x.Principal.Hash == p.Hash {
				count++
			}
		}
		if len(s.previews) >= 1000 || count >= 20 {
			s.mu.Unlock()
			fail(429, "previews-busy")
		}
		s.previews[token] = v
		s.mu.Unlock()
		func() {
			defer func() {
				if e := recover(); e != nil {
					s.mu.Lock()
					delete(s.previews, token)
					s.mu.Unlock()
					panic(e)
				}
			}()
			s.previewFor(token)
		}()
		path := u.EscapedPath()
		if path == "" {
			path = "/"
		}
		if u.RawQuery != "" {
			path += "?" + u.RawQuery
		}
		if u.Fragment != "" {
			path += "#" + u.Fragment
		}
		w.Header().Set("Cache-Control", "no-store")
		return M{"path": "/v1/previews/" + token + path, "expiresAt": v.Expires}
	})
	s.route("DELETE /v1/previews/{token}", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		token := r.PathValue("token")
		s.mu.Lock()
		v := s.previews[token]
		if v == nil || v.Principal.Hash != p.Hash {
			s.mu.Unlock()
			fail(404, "preview-not-found")
		}
		delete(s.previews, token)
		pending := []*Pending{}
		for id, v := range s.pending {
			if v.Token == token {
				delete(s.pending, id)
				pending = append(pending, v)
			}
		}
		s.mu.Unlock()
		for _, v := range pending {
			v.Reject(Fault{410, "preview-closed"})
		}
		return M{"closed": true}
	})
	s.mux.HandleFunc("GET /v1/previews/{token}/__socket", s.previewSocket)
	for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		s.mux.HandleFunc(method+" /v1/previews/{token}/{path...}", s.previewHTTP)
	}
}
func (s *Server) previewHTTP(w http.ResponseWriter, r *http.Request) {
	p := s.previewFor(r.PathValue("token"))
	if !strings.Contains(" GET HEAD POST PUT PATCH DELETE OPTIONS ", " "+r.Method+" ") {
		fail(405, "method-not-allowed")
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	if e != nil || len(b) > 1024*1024 {
		fail(413, "body-too-large")
	}
	token := r.PathValue("token")
	prefix := "/v1/previews/" + token + "/"
	path := "/" + strings.TrimPrefix(r.URL.EscapedPath(), prefix)
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	pending := s.previewRequest(p, token)
	a := s.agent(p.Device)
	defer func() { s.removePending(pending.ID); a.Send(M{"type": "preview.cancel", "requestId": pending.ID}) }()
	headers := M{}
	for _, k := range []string{"accept", "content-type", "range"} {
		if v := r.Header.Get(k); v != "" {
			headers[k] = v
		}
	}
	p.mu.Lock()
	cookies := []string{}
	for k, v := range p.Cookies {
		cookies = append(cookies, k+"="+v)
	}
	p.mu.Unlock()
	if len(cookies) > 0 {
		headers["cookie"] = strings.Join(cookies, "; ")
	}
	m := M{"type": "preview.request", "requestId": pending.ID, "threadId": p.Thread, "origin": p.Origin, "path": path, "method": r.Method, "headers": headers}
	if len(b) > 0 {
		m["body"] = base64.StdEncoding.EncodeToString(b)
	}
	if !a.Send(m) {
		fail(409, "device-offline")
	}
	timeout := time.NewTimer(25 * time.Second)
	defer timeout.Stop()
	expiry := time.NewTimer(time.Duration(max(int64(1), p.Expires-now())) * time.Millisecond)
	defer expiry.Stop()
	status := 502
	responseHeaders := M{}
	chunks := make([]byte, 0)
	stream := false
	started := false
	size := 0
	sendHeaders := func() {
		if started {
			return
		}
		kind := str(responseHeaders["content-type"])
		if kind == "" {
			kind = "application/octet-stream"
		}
		w.Header().Set("Content-Type", kind)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-forms; default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' ws: wss: https:; frame-src 'none'; object-src 'none'")
		if loc := str(responseHeaders["location"]); loc != "" {
			base, _ := url.Parse(p.Origin + path)
			u, e := base.Parse(loc)
			if e != nil || u.Scheme+"://"+u.Host != p.Origin {
				fail(502, "preview-external-redirect")
			}
			w.Header().Set("Location", prefix+strings.TrimPrefix(u.EscapedPath(), "/")+querySuffix(u))
		}
		for _, k := range []string{"content-range", "accept-ranges"} {
			if v := str(responseHeaders[k]); v != "" {
				w.Header().Set(k, v)
			}
		}
		p.mu.Lock()
		for _, cookie := range strings.Split(str(responseHeaders["set-cookie"]), "\n") {
			pair := strings.SplitN(cookie, ";", 2)[0]
			kv := strings.SplitN(pair, "=", 2)
			if len(kv) == 2 && kv[0] != "" && len(p.Cookies) < 100 {
				p.Cookies[kv[0]] = kv[1]
			}
		}
		p.mu.Unlock()
		w.WriteHeader(status)
		started = true
	}
	defer func() {
		if e := recover(); e != nil {
			if started {
				panic(http.ErrAbortHandler)
			}
			panic(e)
		}
	}()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			fail(503, "relay-closing")
		case <-expiry.C:
			fail(410, "preview-expired")
		case <-timeout.C:
			fail(504, "preview-timeout")
		case err := <-pending.Failure:
			panic(err)
		case v := <-pending.Reply:
			select {
			case err := <-pending.Failure:
				panic(err)
			default:
			}
			if v.Err != nil {
				panic(v.Err)
			}
			event := v.Value
			switch event["type"] {
			case "headers":
				status = int(num(event["status"]))
				responseHeaders = obj(event["headers"])
				if strings.Contains(str(responseHeaders["content-type"]), "text/event-stream") {
					stream = true
					timeout.Stop()
					sendHeaders()
				}
			case "data":
				b, e := base64.StdEncoding.DecodeString(str(event["data"]))
				if e != nil {
					fail(502, "invalid-preview-response")
				}
				size += len(b)
				if size > 32*1024*1024 {
					fail(413, "preview-response-too-large")
				}
				if stream {
					_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Second))
					if _, e = w.Write(b); e != nil {
						return
					}
					if f, ok := w.(http.Flusher); ok {
						f.Flush()
					}
				} else {
					chunks = append(chunks, b...)
				}
			case "end":
				if !stream {
					kind := str(responseHeaders["content-type"])
					if strings.Contains(kind, "text/html") || strings.Contains(kind, "javascript") || strings.Contains(kind, "ecmascript") || strings.Contains(kind, "text/css") {
						text := rewritePreview(string(chunks), kind, prefix, p.Origin, path)
						if strings.Contains(kind, "text/html") {
							text = previewDocument(text, p.Channel, p.State)
						}
						chunks = []byte(text)
					}
					sendHeaders()
					_, _ = w.Write(chunks)
				}
				return
			case "error":
				status := 502
				if event["code"] == "preview-not-in-thread" {
					status = 404
				}
				fail(status, str(event["code"]))
			}
		}
	}
}
func querySuffix(u *url.URL) string {
	v := ""
	if u.RawQuery != "" {
		v += "?" + u.RawQuery
	}
	if u.Fragment != "" {
		v += "#" + u.Fragment
	}
	return v
}
func (s *Server) previewSocket(w http.ResponseWriter, r *http.Request) {
	p := s.previewFor(r.PathValue("token"))
	path := r.URL.Query().Get("path")
	if jsLength(path) > 8192 || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		fail(400, "invalid-request")
	}
	v := s.previewRequest(p, r.PathValue("token"))
	protocols := []string{}
	for _, x := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		if x = strings.TrimSpace(x); x != "" {
			protocols = append(protocols, x)
		}
	}
	if len(protocols) > 8 {
		s.removePending(v.ID)
		fail(400, "invalid-request")
	}
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }, Subprotocols: protocols, ReadBufferSize: 4096, WriteBufferSize: 4096}
	ws, e := up.Upgrade(w, r, nil)
	if e != nil {
		s.removePending(v.ID)
		return
	}
	ws.SetReadLimit(64 * 1024)
	a := s.agent(p.Device)
	if a == nil {
		ws.Close()
		s.removePending(v.ID)
		return
	}
	a.Send(M{"type": "preview.ws.open", "requestId": v.ID, "threadId": p.Thread, "origin": p.Origin, "path": path, "protocols": protocols})
	if !s.beginJob() {
		ws.Close()
		s.removePending(v.ID)
		return
	}
	go func() {
		defer s.wg.Done()
		defer ws.Close()
		defer s.removePending(v.ID)
		defer a.Send(M{"type": "preview.cancel", "requestId": v.ID})
		defer func() { recover() }()
		data := make(chan M, 16)
		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				kind, b, e := ws.ReadMessage()
				if e != nil {
					return
				}
				m := M{"type": "preview.ws.data", "requestId": v.ID, "data": base64.StdEncoding.EncodeToString(b), "binary": kind == websocket.BinaryMessage}
				select {
				case data <- m:
				default:
					ws.Close()
					return
				}
			}
		}()
		opening := time.NewTimer(10 * time.Second)
		defer opening.Stop()
		expiry := time.NewTimer(time.Duration(max(int64(1), p.Expires-now())) * time.Millisecond)
		defer expiry.Stop()
		ready := false
		waiting := []M{}
		for {
			select {
			case <-done:
				return
			case <-s.ctx.Done():
				return
			case <-opening.C:
				return
			case <-expiry.C:
				return
			case m := <-data:
				if ready {
					if !a.Send(m) {
						return
					}
				} else {
					if len(waiting) >= 16 {
						return
					}
					waiting = append(waiting, m)
				}
			case <-v.Failure:
				ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "preview-unavailable"), time.Now().Add(time.Second))
				return
			case message := <-v.Reply:
				select {
				case <-v.Failure:
					ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "preview-unavailable"), time.Now().Add(time.Second))
					return
				default:
				}
				if message.Err != nil {
					ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "preview-unavailable"), time.Now().Add(time.Second))
					return
				}
				event := message.Value
				switch event["type"] {
				case "ws.open":
					ready = true
					opening.Stop()
					for _, m := range waiting {
						a.Send(m)
					}
					waiting = nil
				case "ws.data":
					b, e := base64.StdEncoding.DecodeString(str(event["data"]))
					if e != nil {
						return
					}
					kind := websocket.TextMessage
					if boolean(event["binary"]) {
						kind = websocket.BinaryMessage
					}
					ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
					if ws.WriteMessage(kind, b) != nil {
						return
					}
				case "ws.close", "error":
					return
				}
			}
		}
	}()
}

// RewritePreviewContent is also used by the browser contract tests.
func RewritePreviewContent(text, kind, prefix, origin, path string) string {
	return rewritePreview(text, kind, prefix, origin, path)
}
