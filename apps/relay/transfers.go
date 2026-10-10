package relay

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type response struct {
	Value M
	Err   error
}
type Pending struct {
	Device, Thread, Kind, ID, Path, Version, Token string
	Offset                                         *int64
	Principal                                      *Principal
	Reply                                          chan response
	Failure                                        chan error
	rejectOnce                                     sync.Once
}

func (p *Pending) Reject(e error) {
	p.rejectOnce.Do(func() { p.Failure <- e })
}
func (p *Pending) Resolve(m M) {
	select {
	case p.Reply <- response{Value: m}:
	default:
	}
}
func (s *Server) FailPending(device, reason string) {
	s.mu.Lock()
	values := []*Pending{}
	for id, p := range s.pending {
		if p.Device == device {
			delete(s.pending, id)
			values = append(values, p)
		}
	}
	s.mu.Unlock()
	for _, p := range values {
		status := 409
		if reason == "device-revoked" {
			status = 404
		}
		p.Reject(Fault{status, reason})
	}
}
func (s *Server) addPending(p *Pending, total, perDevice int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, d := 0, 0
	for _, v := range s.pending {
		if v.Kind == p.Kind {
			n++
			if v.Device == p.Device {
				d++
			}
		}
	}
	if n >= total || d >= perDevice {
		fail(429, p.Kind+"s-busy")
	}
	p.Failure = make(chan error, 1)
	s.pending[p.ID] = p
}
func (s *Server) removePending(id string) { s.mu.Lock(); delete(s.pending, id); s.mu.Unlock() }
func (s *Server) wait(ctx context.Context, p *Pending, timeout time.Duration) M {
	defer s.removePending(p.ID)
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-p.Failure:
		panic(err)
	case v := <-p.Reply:
		select {
		case err := <-p.Failure:
			panic(err)
		default:
		}
		if v.Err != nil {
			panic(v.Err)
		}
		return v.Value
	case <-ctx.Done():
		fail(499, p.Kind+"-cancelled")
	case <-s.ctx.Done():
		fail(503, "relay-closing")
	case <-timer.C:
		fail(504, p.Kind+"-timeout")
	}
	return nil
}
func (s *Server) authorizeThread(p *Principal, device, thread string, archived bool) {
	if !validID(thread) {
		fail(400, "invalid-request")
	}
	if p == nil || s.Store.SessionHash(p.Hash, "") == nil {
		fail(401, "unauthorized")
	}
	if !s.Store.Owns(device, p) {
		fail(404, "device-not-found")
	}
	if !s.Store.InCatalog(device, thread, archived) {
		fail(404, "thread-not-in-catalog")
	}
}
func (s *Server) requestTransfer(r *http.Request, p *Principal, kind string, fields M) M {
	id, thread := r.PathValue("deviceId"), r.PathValue("threadId")
	pending := &Pending{Device: id, Thread: thread, Kind: kind, ID: uuid(), Principal: p, Reply: make(chan response, 1), Path: str(fields["path"]), Version: str(fields["version"])}
	if kind == "image" {
		pending.Path = str(fields["imageId"])
	}
	if fields["offset"] != nil {
		offset := num(fields["offset"])
		pending.Offset = &offset
	}
	var cached M
	s.lane(id, func() {
		s.authorizeThread(p, id, thread, kind != "file")
		if kind == "image" {
			cached = s.Store.Image(id, thread, str(fields["imageId"]), false)
			if cached != nil {
				return
			}
		}
		a := s.agent(id)
		if a == nil {
			fail(409, "device-offline")
		}
		if kind == "file" {
			a.mu.Lock()
			supported := a.files
			a.mu.Unlock()
			if !supported {
				fail(409, "agent-update-required")
			}
		}
		max := 12
		if kind == "history" {
			max = 20
		}
		s.addPending(pending, max, 4)
		m := M{"type": kind + ".request", "requestId": pending.ID, "threadId": thread}
		for k, v := range fields {
			m[k] = v
		}
		if !a.Send(m) {
			s.removePending(pending.ID)
			fail(409, "device-offline")
		}
	})
	if cached != nil {
		return cached
	}
	timeout := 15 * time.Second
	if kind == "history" {
		timeout = 30 * time.Second
	}
	v := s.wait(r.Context(), pending, timeout)
	s.lane(id, func() { s.authorizeThread(p, id, thread, kind != "file") })
	return v
}
func (s *Server) acceptTransfer(device string, m M) {
	s.mu.Lock()
	p := s.pending[str(m["requestId"])]
	s.mu.Unlock()
	if p == nil || p.Device != device || p.Thread != str(m["threadId"]) {
		return
	}
	if p.Kind == "image" && p.Path != str(m["imageId"]) {
		return
	}
	if str(m["type"]) != "device."+p.Kind {
		return
	}
	switch p.Kind {
	case "history":
		if page := obj(m["page"]); page["threadId"] == p.Thread {
			p.Resolve(page)
		} else {
			code := str(m["code"])
			if code == "" {
				code = "history-unavailable"
			}
			p.Reject(Fault{502, code})
		}
	case "image":
		image := obj(m["image"])
		if m["image"] == nil {
			p.Reject(Fault{404, "image-unavailable"})
			return
		}
		func() {
			defer func() {
				if recover() != nil {
					p.Reject(Fault{400, "invalid-image"})
				}
			}()
			s.Validate("image", image)
			s.Store.SaveImage(device, p.Thread, str(m["imageId"]), image, false)
			p.Resolve(image)
		}()
	case "file":
		if p.Path != str(m["path"]) {
			return
		}
		f := obj(m["file"])
		if m["file"] == nil {
			code := str(m["code"])
			if code == "" {
				code = "file-unavailable"
			}
			status := 404
			if code == "file-too-large" {
				status = 413
			}
			if code == "file-changed" {
				status = 409
			}
			p.Reject(Fault{status, code})
			return
		}
		valid := m["code"] == nil
		if p.Offset == nil {
			valid = valid && f["offset"] == nil && f["base64"] == nil
		} else {
			bytes, e := base64.StdEncoding.DecodeString(str(f["base64"]))
			expected := min(int64(256*1024), num(f["size"])-*p.Offset)
			valid = valid && e == nil && f["offset"] != nil && num(f["offset"]) == *p.Offset && str(f["version"]) == p.Version && f["base64"] != nil && int64(len(bytes)) == expected
		}
		if !valid {
			p.Reject(Fault{502, "invalid-file-response"})
		} else {
			p.Resolve(f)
		}
	}
}
func imageBytes(m M) []byte {
	b, e := base64.StdEncoding.DecodeString(str(m["base64"]))
	mime := ""
	if len(b) >= 24 && string(b[:8]) == "\x89PNG\r\n\x1a\n" {
		mime = "image/png"
	} else if len(b) >= 12 && b[0] == 255 && b[1] == 216 && b[2] == 255 {
		mime = "image/jpeg"
	} else if len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP" {
		mime = "image/webp"
	} else if len(b) >= 10 && (string(b[:6]) == "GIF87a" || string(b[:6]) == "GIF89a") {
		mime = "image/gif"
	}
	if e != nil || len(b) > 4*1024*1024 || base64.StdEncoding.EncodeToString(b) != str(m["base64"]) || mime == "" || mime != m["mimeType"] {
		fail(400, "invalid-image")
	}
	return b
}
func (s *Server) transferRoutes() {
	base := "/v1/devices/{deviceId}/threads/{threadId}"
	s.route("GET "+base+"/turns", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		cursor := r.URL.Query().Get("cursor")
		if jsLength(cursor) > 2048 || r.URL.Query().Has("cursor") && cursor == "" {
			fail(400, "invalid-request")
		}
		return s.requestTransfer(r, p, "history", M{"cursor": nullable(cursor)})
	})
	s.route("POST "+base+"/images", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		m := body(r)
		s.Validate("image", m)
		bytes := imageBytes(m)
		device, thread := r.PathValue("deviceId"), r.PathValue("threadId")
		h := sha256.New()
		h.Write([]byte(device + "\x00" + thread + "\x00"))
		h.Write(bytes)
		id := hex.EncodeToString(h.Sum(nil))
		s.lane(device, func() { s.authorizeThread(p, device, thread, true); s.Store.SaveImage(device, thread, id, m, true) })
		return M{"id": id, "name": m["name"]}
	})
	s.route("GET "+base+"/images/{imageId}", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		image := r.PathValue("imageId")
		if !hex64.MatchString(image) {
			fail(400, "invalid-request")
		}
		m := s.requestTransfer(r, p, "image", M{"imageId": image})
		b := imageBytes(m)
		w.Header().Set("Content-Type", str(m["mimeType"]))
		downloadHeaders(w)
		_, _ = w.Write(b)
		return nil
	})
	s.route("GET /v1/agent/{deviceId}/threads/{threadId}/images/{imageId}", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		device := r.PathValue("deviceId")
		if s.Store.Session(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), device) == nil {
			fail(401, "unauthorized")
		}
		image := s.Store.Image(device, r.PathValue("threadId"), r.PathValue("imageId"), true)
		if image == nil {
			fail(404, "image-not-in-thread")
		}
		return image
	})
	s.route("GET "+base+"/files/info", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		path := r.URL.Query().Get("path")
		if len(path) == 0 || jsLength(path) > 4096 {
			fail(400, "invalid-request")
		}
		w.Header().Set("Cache-Control", "no-store")
		return s.requestTransfer(r, p, "file", M{"path": path})
	})
	s.route("GET "+base+"/files/content", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		path, version := r.URL.Query().Get("path"), r.URL.Query().Get("version")
		if len(path) == 0 || jsLength(path) > 4096 || !hex64.MatchString(version) {
			fail(400, "invalid-request")
		}
		device := r.PathValue("deviceId")
		lease := &Pending{ID: uuid(), Device: device, Kind: "transfer", Reply: make(chan response, 1)}
		s.addPending(lease, 4, 2)
		defer s.removePending(lease.ID)
		first := s.requestTransfer(r, p, "file", M{"path": path, "offset": int64(0), "version": version})
		downloadHeaders(w)
		w.Header().Set("Content-Length", str(first["size"]))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=\"download\"; filename*=UTF-8''"+strings.ReplaceAll(url.PathEscape(str(first["name"])), "'", "%27"))
		w.WriteHeader(200)
		file := first
		for offset := int64(0); offset < num(first["size"]); {
			if file["size"] != first["size"] || file["name"] != first["name"] {
				panic(http.ErrAbortHandler)
			}
			bytes, _ := base64.StdEncoding.DecodeString(str(file["base64"]))
			if _, e := w.Write(bytes); e != nil {
				return nil
			}
			offset += int64(len(bytes))
			if offset < num(first["size"]) {
				func() {
					defer func() {
						if recover() != nil {
							panic(http.ErrAbortHandler)
						}
					}()
					file = s.requestTransfer(r, p, "file", M{"path": path, "offset": offset, "version": version})
				}()
			}
		}
		return nil
	})
}
func downloadHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
}
