package relay

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
)

const maxAttachmentBytes = 20 * 1024 * 1024
const uploadChunkBytes = 512 * 1024

type upload struct {
	ID, Owner, Device, Thread, Name, MIME, SHA256 string
	Size, Offset, Expires                         int64
}

func (u upload) reference() M {
	return M{"id": u.ID, "name": u.Name, "size": u.Size, "mimeType": u.MIME, "sha256": u.SHA256}
}

type uploadStore struct {
	mu        sync.Mutex
	directory string
	temporary bool
}

func newUploadStore(directory string) (*uploadStore, error) {
	var err error
	temporary := directory == ""
	if temporary {
		directory, err = os.MkdirTemp("", "codexer-uploads-")
	} else {
		directory = filepath.Join(directory, "uploads")
		err = os.MkdirAll(directory, 0700)
	}
	if err != nil {
		return nil, err
	}
	return &uploadStore{directory: directory, temporary: temporary}, nil
}
func (s *uploadStore) path(id, suffix string) string {
	if !hex64.MatchString(id) {
		fail(400, "invalid-attachment")
	}
	return filepath.Join(s.directory, id+suffix)
}
func (s *uploadStore) load(id string) upload {
	var u upload
	b, err := os.ReadFile(s.path(id, ".json"))
	if err != nil || json.Unmarshal(b, &u) != nil || u.ID != id || u.Expires <= now() {
		fail(404, "attachment-unavailable")
	}
	return u
}
func (s *uploadStore) save(u upload) {
	b, err := json.Marshal(u)
	if err != nil {
		panic(err)
	}
	tmp := s.path(u.ID, ".json.tmp")
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		panic(err)
	}
	if err = os.Rename(tmp, s.path(u.ID, ".json")); err != nil {
		panic(err)
	}
}
func (s *uploadStore) remove(id string) {
	_ = os.Remove(s.path(id, ".json"))
	_ = os.Remove(s.path(id, ".data"))
	_ = os.Remove(s.path(id, ".json.tmp"))
}
func (s *uploadStore) cleanupLocked() (total int64, devices map[string]int64, count int) {
	devices = map[string]int64{}
	entries, err := os.ReadDir(s.directory)
	if err != nil {
		panic(err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		var u upload
		b, err := os.ReadFile(filepath.Join(s.directory, entry.Name()))
		if err != nil || json.Unmarshal(b, &u) != nil || !hex64.MatchString(u.ID) {
			continue
		}
		if u.Expires <= now() {
			s.remove(u.ID)
			continue
		}
		total += u.Size
		devices[u.Device] += u.Size
		count++
	}
	return
}
func (s *uploadStore) cleanup() { s.mu.Lock(); defer s.mu.Unlock(); s.cleanupLocked() }
func (s *uploadStore) close() {
	if s.temporary {
		_ = os.RemoveAll(s.directory)
	}
}
func (s *Server) uploadRoutes() {
	base := "/v1/devices/{deviceId}/threads/{threadId}/attachments"
	s.route("POST "+base, "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		m := body(r)
		name, mime, size := str(m["name"]), str(m["mimeType"]), num(m["size"])
		if name == "" || jsLength(name) > 255 || strings.ContainsAny(name, "/\\") || strings.IndexFunc(name, unicode.IsControl) >= 0 || name == "." || name == ".." || size < 0 || size > maxAttachmentBytes || m["size"] == nil || jsLength(mime) > 255 || strings.IndexFunc(mime, unicode.IsControl) >= 0 {
			fail(400, "invalid-attachment")
		}
		if f, ok := m["size"].(float64); !ok || f != float64(size) {
			fail(400, "invalid-attachment")
		}
		var result M
		s.lane(r.PathValue("deviceId"), func() {
			device, thread := r.PathValue("deviceId"), r.PathValue("threadId")
			s.authorizeThread(p, device, thread, false)
			snapshot := s.Store.Snapshot(device)
			if snapshot == nil || obj(obj(snapshot["runtime"])["capabilities"])["attachments"] != true {
				fail(409, "agent-update-required")
			}
			s.uploads.mu.Lock()
			defer s.uploads.mu.Unlock()
			total, devices, count := s.uploads.cleanupLocked()
			if total+size > 1024*1024*1024 || devices[device]+size > 256*1024*1024 || count >= 2000 {
				fail(413, "attachment-storage-full")
			}
			random := make([]byte, 32)
			if _, err := rand.Read(random); err != nil {
				panic(err)
			}
			u := upload{ID: hex.EncodeToString(random), Owner: p.ID, Device: device, Thread: thread, Name: name, MIME: mime, Size: size, Expires: now() + 86400000}
			f, err := os.OpenFile(s.uploads.path(u.ID, ".data"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				panic(err)
			}
			f.Close()
			if size == 0 {
				hash := sha256.Sum256(nil)
				u.SHA256 = hex.EncodeToString(hash[:])
			}
			s.uploads.save(u)
			result = M{"id": u.ID}
		})
		return result
	})
	s.route("PUT "+base+"/{attachmentId}", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		r.Body = http.MaxBytesReader(w, r.Body, 750*1024)
		m := body(r)
		bytes, err := base64.StdEncoding.DecodeString(str(m["base64"]))
		if err != nil || len(bytes) > uploadChunkBytes || base64.StdEncoding.EncodeToString(bytes) != str(m["base64"]) {
			fail(400, "invalid-attachment-chunk")
		}
		var result M
		s.lane(r.PathValue("deviceId"), func() {
			device, thread := r.PathValue("deviceId"), r.PathValue("threadId")
			s.authorizeThread(p, device, thread, false)
			s.uploads.mu.Lock()
			defer s.uploads.mu.Unlock()
			u := s.uploads.load(r.PathValue("attachmentId"))
			if u.Owner != p.ID || u.Device != device || u.Thread != thread {
				fail(404, "attachment-unavailable")
			}
			offset, ok := m["offset"].(float64)
			if !ok || offset != float64(u.Offset) || u.Offset+int64(len(bytes)) > u.Size || len(bytes) == 0 && u.Size != 0 {
				fail(409, "attachment-offset-mismatch")
			}
			f, err := os.OpenFile(s.uploads.path(u.ID, ".data"), os.O_RDWR, 0600)
			if err != nil {
				panic(err)
			}
			defer f.Close()
			// Rewrite an unacknowledged trailing chunk after an interrupted request.
			if err = f.Truncate(u.Offset); err != nil {
				panic(err)
			}
			if _, err = f.WriteAt(bytes, u.Offset); err != nil {
				panic(err)
			}
			u.Offset += int64(len(bytes))
			if err = f.Sync(); err != nil {
				panic(err)
			}
			if u.Offset == u.Size {
				if _, err = f.Seek(0, 0); err != nil {
					panic(err)
				}
				hash := sha256.New()
				if _, err = io.Copy(hash, f); err != nil {
					panic(err)
				}
				u.SHA256 = hex.EncodeToString(hash.Sum(nil))
			}
			s.uploads.save(u)
			result = M{"offset": u.Offset}
			if u.SHA256 != "" {
				result["attachment"] = u.reference()
			}
		})
		return result
	})
	s.route("DELETE "+base+"/{attachmentId}", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.lane(r.PathValue("deviceId"), func() {
			s.authorizeThread(p, r.PathValue("deviceId"), r.PathValue("threadId"), true)
			s.uploads.mu.Lock()
			defer s.uploads.mu.Unlock()
			u := s.uploads.load(r.PathValue("attachmentId"))
			if u.Owner != p.ID || u.Device != r.PathValue("deviceId") || u.Thread != r.PathValue("threadId") {
				fail(404, "attachment-unavailable")
			}
			s.uploads.remove(u.ID)
		})
		return M{"ok": true}
	})
	s.route("GET /v1/agent/{deviceId}/threads/{threadId}/attachments/{attachmentId}", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		device, thread := r.PathValue("deviceId"), r.PathValue("threadId")
		principal := s.Store.Session(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), device)
		if principal == nil {
			fail(401, "unauthorized")
		}
		u := func() upload {
			s.uploads.mu.Lock()
			defer s.uploads.mu.Unlock()
			return s.uploads.load(r.PathValue("attachmentId"))
		}()
		if u.Device != device || u.Thread != thread || u.Owner != principal.ID || !s.Store.InCatalog(device, thread, false) || u.SHA256 == "" {
			fail(404, "attachment-unavailable")
		}
		if r.URL.Query().Get("info") == "1" {
			return u.reference()
		}
		f, err := os.Open(s.uploads.path(u.ID, ".data"))
		if err != nil {
			fail(404, "attachment-unavailable")
		}
		defer f.Close()
		// Always download as binary; an uploaded HTML/SVG file cannot run on the Relay origin.
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=\"download\"; filename*=UTF-8''"+strings.ReplaceAll(url.PathEscape(u.Name), "'", "%27"))
		downloadHeaders(w)
		http.ServeContent(w, r, u.Name, time.Time{}, f)
		return nil
	})
}
