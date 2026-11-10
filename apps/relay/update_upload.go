package relay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func ServerUpdateVersion(name string) string {
	suffix := "-" + runtime.GOOS + "-" + runtime.GOARCH + ".tar.gz"
	version := strings.TrimSuffix(strings.TrimPrefix(name, "codexer-server-"), suffix)
	if len(version) > 80 || !stableTag.MatchString("v"+version) || name != "codexer-server-"+version+suffix {
		fail(400, "invalid-server-update-name")
	}
	return version
}

// Link a complete, synced request into the inbox without replacing another job.
func writeUpdateRequest(dir string, job M) {
	f, e := os.CreateTemp(dir, ".request-*.tmp")
	if e != nil {
		fail(500, "server-update-storage-error")
	}
	defer func() { f.Close(); os.Remove(f.Name()) }()
	if _, e = f.Write([]byte(js(job))); e != nil {
		fail(500, "server-update-storage-error")
	}
	if f.Sync() != nil || f.Close() != nil {
		fail(500, "server-update-storage-error")
	}
	if e = os.Link(f.Name(), filepath.Join(dir, "request.json")); os.IsExist(e) {
		fail(409, "update-in-progress")
	} else if e != nil {
		fail(500, "server-update-storage-error")
	}
}

func (u *Updates) Upload(name, expected string, length int64, reader io.Reader, authorize func() func()) M {
	version := ServerUpdateVersion(name)
	if !hex64.MatchString(expected) {
		fail(400, "invalid-server-update-checksum")
	}
	if length > MaxServerUpdateBytes {
		fail(413, "server-update-too-large")
	}
	func() {
		u.mu.Lock()
		defer u.mu.Unlock()
		status := ReadJSON(u.Status)
		if u.Dir == "" || !boolean(status["enabled"]) || num(status["protocol"]) != 2 || !boolean(status["uploadSupported"]) {
			fail(409, "upload-updater-not-installed")
		}
		if u.uploading || updateRunning(u.localJob()) {
			fail(409, "update-in-progress")
		}
		if !Newer(version, u.Version) {
			fail(409, "update-not-newer")
		}
		u.uploading = true
	}()
	defer func() { u.mu.Lock(); u.uploading = false; u.mu.Unlock() }()
	f, e := os.CreateTemp(u.Dir, ".upload-*.tmp")
	if e != nil {
		fail(500, "server-update-storage-error")
	}
	defer func() { f.Close(); os.Remove(f.Name()) }()
	hash := sha256.New()
	size, e := io.Copy(io.MultiWriter(f, hash), io.LimitReader(reader, MaxServerUpdateBytes+1))
	var tooLarge *http.MaxBytesError
	if size > MaxServerUpdateBytes || errors.As(e, &tooLarge) {
		fail(413, "server-update-too-large")
	}
	if e != nil || size < 128 || length >= 0 && size != length {
		fail(400, "server-update-upload-incomplete")
	}
	if hex.EncodeToString(hash.Sum(nil)) != expected {
		fail(400, "checksum-mismatch")
	}
	if f.Sync() != nil || f.Close() != nil {
		fail(500, "server-update-storage-error")
	}
	if InspectServerUpdateArchive(f.Name(), version, runtime.GOOS, runtime.GOARCH) != nil {
		fail(400, "invalid-server-bundle")
	}
	release := authorize()
	defer release()
	u.mu.Lock()
	defer u.mu.Unlock()
	if updateRunning(u.localJob()) {
		fail(409, "update-in-progress")
	}
	id := uuid()
	target := filepath.Join(u.Dir, id+".tar.gz")
	if os.Rename(f.Name(), target) != nil {
		fail(500, "server-update-storage-error")
	}
	keep := false
	defer func() {
		if !keep {
			os.Remove(target)
		}
	}()
	job := M{"id": id, "tag": "v" + version, "method": "upload", "source": "upload", "action": "update", "phase": "queued", "updatedAt": now(), "sha256": expected, "size": size}
	writeUpdateRequest(u.Dir, job)
	keep = true
	return job
}

func (s *Server) serverUpdateUploadRoute() {
	s.route("PUT /v1/admin/system/update-package", "publish:server:write", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		if !s.beginJob() {
			fail(503, "relay-closing")
		}
		defer s.wg.Done()
		reader := http.MaxBytesReader(w, r.Body, MaxServerUpdateBytes)
		stop := context.AfterFunc(s.ctx, func() { reader.Close() })
		defer stop()
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Minute))
		defer http.NewResponseController(w).SetReadDeadline(time.Time{})
		return s.updates.Upload(r.URL.Query().Get("name"), r.URL.Query().Get("sha256"), r.ContentLength, reader, func() func() {
			s.exclusive.RLock()
			ok := false
			defer func() {
				if !ok {
					s.exclusive.RUnlock()
				}
			}()
			s.principal(r, "publish:server:write")
			if r.Context().Err() != nil || s.ctx.Err() != nil {
				fail(400, "server-update-upload-incomplete")
			}
			ok = true
			return s.exclusive.RUnlock
		})
	})
}
