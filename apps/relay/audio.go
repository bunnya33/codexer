package relay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type AudioPlayback struct {
	Device, Thread, Path, Version, Name, MIME string
	Principal                                 *Principal
	Size, Expires                             int64
	ctx                                       context.Context
	cancel                                    context.CancelFunc
}

func audioMIME(name string) string {
	return map[string]string{
		".mp3": "audio/mpeg", ".wav": "audio/wav", ".wave": "audio/wav",
		".m4a": "audio/mp4", ".m4b": "audio/mp4", ".aac": "audio/aac",
		".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
		".flac": "audio/flac", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".webm": "audio/webm",
	}[strings.ToLower(filepath.Ext(name))]
}

var audioRangePattern = regexp.MustCompile(`(?i)^bytes=(\d*)-(\d*)$`)

// A player requests one range at a time. Multipart ranges are deliberately
// rejected so each response needs only one fixed-size Agent chunk in memory.
func audioRange(value string, size int64) (start, end int64, partial, ok bool) {
	if value == "" {
		return 0, size - 1, false, true
	}
	m := audioRangePattern.FindStringSubmatch(strings.TrimSpace(value))
	if m == nil || size == 0 || m[1] == "" && m[2] == "" {
		return 0, 0, true, false
	}
	end = size - 1
	if m[1] == "" {
		length, e := strconv.ParseInt(m[2], 10, 64)
		if e != nil || length <= 0 {
			return 0, 0, true, false
		}
		return max(int64(0), size-length), end, true, true
	}
	start, e := strconv.ParseInt(m[1], 10, 64)
	if e != nil || start >= size {
		return 0, 0, true, false
	}
	if m[2] != "" {
		last, e := strconv.ParseInt(m[2], 10, 64)
		if e != nil || last < start {
			return 0, 0, true, false
		}
		end = min(end, last)
	}
	return start, end, true, true
}

func (s *Server) audioRoutes() {
	s.route("POST /v1/devices/{deviceId}/threads/{threadId}/files/audio", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		b := body(r)
		path, version := str(b["path"]), str(b["version"])
		if path == "" || jsLength(path) > 4096 || !hex64.MatchString(version) {
			fail(400, "invalid-request")
		}
		info := s.requestTransfer(r, p, "file", M{"path": path})
		if info["version"] != version {
			fail(409, "file-changed")
		}
		mime := audioMIME(str(info["name"]))
		if mime == "" {
			fail(400, "unsupported-audio")
		}
		data := make([]byte, 32)
		if _, e := rand.Read(data); e != nil {
			panic(e)
		}
		token := hex.EncodeToString(data)
		expires := now() + 30*60*1000
		ctx, cancel := context.WithDeadline(s.ctx, time.UnixMilli(expires))
		v := &AudioPlayback{Device: r.PathValue("deviceId"), Thread: r.PathValue("threadId"), Path: path, Version: version, Name: str(info["name"]), MIME: mime, Principal: p, Size: num(info["size"]), Expires: expires, ctx: ctx, cancel: cancel}
		s.mu.Lock()
		count := 0
		for key, old := range s.audio {
			if old.Expires <= now() {
				old.cancel()
				delete(s.audio, key)
			} else if old.Principal.Hash == p.Hash {
				count++
			}
		}
		if len(s.audio) >= 1000 || count >= 20 {
			s.mu.Unlock()
			cancel()
			fail(429, "audio-busy")
		}
		s.audio[token] = v
		s.mu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		return M{"path": "/v1/audio/" + token, "expiresAt": expires}
	})
	s.route("DELETE /v1/audio/{token}", "member", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		s.mu.Lock()
		v := s.audio[r.PathValue("token")]
		if v == nil || v.Principal.Hash != p.Hash {
			s.mu.Unlock()
			fail(404, "audio-not-found")
		}
		delete(s.audio, r.PathValue("token"))
		v.cancel()
		s.mu.Unlock()
		return M{"ok": true}
	})
	// GET also handles HEAD; both validate the bound session on every request.
	s.mux.HandleFunc("GET /v1/audio/{token}", s.audioHTTP)
}

func (s *Server) audioHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token := r.PathValue("token")
	if !hex64.MatchString(token) {
		fail(400, "invalid-request")
	}
	s.mu.Lock()
	v := s.audio[token]
	s.mu.Unlock()
	if v == nil || v.Expires <= now() || v.ctx.Err() != nil {
		fail(410, "audio-expired")
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(v.ctx, cancel)
	defer stop()
	defer cancel()
	r = r.Clone(ctx)
	r.SetPathValue("deviceId", v.Device)
	r.SetPathValue("threadId", v.Thread)
	info := s.requestTransfer(r, v.Principal, "file", M{"path": v.Path})
	if str(info["version"]) != v.Version || num(info["size"]) != v.Size || str(info["name"]) != v.Name {
		fail(409, "file-changed")
	}
	rangeHeader := r.Header.Get("Range")
	if r.Method == "HEAD" {
		rangeHeader = ""
	}
	start, end, partial, ok := audioRange(rangeHeader, v.Size)
	downloadHeaders(w)
	w.Header().Set("Content-Type", v.MIME)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
	if !ok {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", v.Size))
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	status := http.StatusOK
	if partial {
		status = http.StatusPartialContent
	}
	if r.Method == "HEAD" || v.Size == 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(v.Size, 10))
		w.WriteHeader(status)
		return
	}
	lease := &Pending{ID: uuid(), Device: v.Device, Thread: v.Thread, Kind: "transfer", Principal: v.Principal, Reply: make(chan response, 1)}
	s.addPending(lease, 4, 2)
	defer s.removePending(lease.ID)
	file := s.requestTransfer(r, v.Principal, "file", M{"path": v.Path, "offset": start, "version": v.Version})
	if partial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, v.Size))
	}
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	w.WriteHeader(status)
	defer func() {
		if recover() != nil {
			panic(http.ErrAbortHandler)
		}
	}()
	for offset := start; offset <= end; {
		select {
		case <-lease.Failure:
			panic(http.ErrAbortHandler)
		case <-ctx.Done():
			panic(http.ErrAbortHandler)
		default:
		}
		if num(file["size"]) != v.Size || str(file["name"]) != v.Name {
			panic(http.ErrAbortHandler)
		}
		bytes, e := base64.StdEncoding.DecodeString(str(file["base64"]))
		if e != nil || len(bytes) == 0 {
			panic(http.ErrAbortHandler)
		}
		bytes = bytes[:min(int64(len(bytes)), end-offset+1)]
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Second))
		if _, e = w.Write(bytes); e != nil {
			return
		}
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		offset += int64(len(bytes))
		if offset <= end {
			file = s.requestTransfer(r, v.Principal, "file", M{"path": v.Path, "offset": offset, "version": v.Version})
		}
	}
}
