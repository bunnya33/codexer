package relay

import (
	"context"
	"crypto/sha256"
	"debug/pe"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

const maxAgentInstallerBytes = 256 * 1024 * 1024

var agentReleaseVersion = regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`)

type agentRelease struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Version    string `json:"version"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	UploadedAt int64  `json:"uploadedAt"`
}
type agentReleaseStore struct {
	mu        sync.RWMutex
	upload    sync.Mutex
	directory string
	temporary bool
	latest    *agentRelease
}

func validAgentInstallerName(name string) bool {
	return name != "" && jsLength(name) <= 180 && strings.HasSuffix(strings.ToLower(name), ".exe") && !strings.ContainsAny(name, `/\<>:"|?*`) && strings.IndexFunc(name, unicode.IsControl) < 0
}
func newAgentReleaseStore(directory string) (*agentReleaseStore, error) {
	var err error
	temporary := directory == ""
	if temporary {
		directory, err = os.MkdirTemp("", "codexer-agent-releases-")
	} else {
		directory = filepath.Join(directory, "agent-releases")
		err = os.MkdirAll(directory, 0700)
	}
	if err != nil {
		return nil, err
	}
	u := &agentReleaseStore{directory: directory, temporary: temporary}
	b, err := os.ReadFile(filepath.Join(directory, "latest.json"))
	if err == nil {
		var latest agentRelease
		if json.Unmarshal(b, &latest) != nil || !uuidPattern.MatchString(latest.ID) || !validAgentInstallerName(latest.Name) || !agentReleaseVersion.MatchString(latest.Version) || !hex64.MatchString(latest.SHA256) || latest.Size < 128 || latest.Size > maxAgentInstallerBytes {
			return nil, errors.New("invalid-agent-release-metadata")
		}
		info, err := os.Stat(filepath.Join(directory, latest.ID+".exe"))
		if err != nil || !info.Mode().IsRegular() || info.Size() != latest.Size {
			return nil, errors.New("agent-release-file-missing")
		}
		u.latest = &latest
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	u.cleanup()
	return u, nil
}
func (u *agentReleaseStore) cleanup() {
	entries, _ := os.ReadDir(u.directory)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && (strings.HasSuffix(name, ".tmp") || strings.HasSuffix(name, ".exe") && (u.latest == nil || name != u.latest.ID+".exe")) {
			_ = os.Remove(filepath.Join(u.directory, name))
		}
	}
}
func (u *agentReleaseStore) close() {
	if u.temporary {
		_ = os.RemoveAll(u.directory)
	}
}
func (u *agentReleaseStore) current() *agentRelease {
	u.mu.RLock()
	defer u.mu.RUnlock()
	if u.latest == nil {
		return nil
	}
	value := *u.latest
	return &value
}
func (s *Server) agentReleaseRoutes() {
	for path, role := range map[string]string{"/v1/pc-agent/release": "user", "/v1/admin/pc-agent/release": "admin"} {
		s.route("GET "+path, role, func(w http.ResponseWriter, r *http.Request, p *Principal) any {
			w.Header().Set("Cache-Control", "no-store")
			return M{"release": s.agentReleases.current()}
		})
	}
	s.route("PUT /v1/admin/pc-agent/release", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		name, version := r.URL.Query().Get("name"), r.URL.Query().Get("version")
		if !validAgentInstallerName(name) || len(version) > 80 || !agentReleaseVersion.MatchString(version) {
			fail(400, "invalid-agent-release")
		}
		if r.ContentLength > maxAgentInstallerBytes {
			fail(413, "agent-installer-too-large")
		}
		u := s.agentReleases
		if !u.upload.TryLock() {
			fail(409, "agent-upload-in-progress")
		}
		defer u.upload.Unlock()
		if !s.beginJob() {
			fail(503, "relay-closing")
		}
		defer s.wg.Done()
		uploadBody := http.MaxBytesReader(w, r.Body, maxAgentInstallerBytes)
		stopClosing := context.AfterFunc(s.ctx, func() { uploadBody.Close() })
		defer stopClosing()
		// Stream to a private temporary file. No partial upload replaces the published installer.
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Minute))
		defer http.NewResponseController(w).SetReadDeadline(time.Time{})
		file, err := os.CreateTemp(u.directory, "upload-*.tmp")
		if err != nil {
			fail(500, "agent-release-storage-error")
		}
		defer func() { file.Close(); os.Remove(file.Name()) }()
		hash := sha256.New()
		size, err := io.Copy(io.MultiWriter(file, hash), uploadBody)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				fail(413, "agent-installer-too-large")
			}
			fail(400, "agent-upload-incomplete")
		}
		if size < 128 || r.ContentLength >= 0 && size != r.ContentLength {
			fail(400, "agent-upload-incomplete")
		}
		image, err := pe.NewFile(file)
		if err != nil {
			fail(400, "invalid-agent-executable")
		}
		valid := image.FileHeader.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE != 0 && image.FileHeader.Characteristics&pe.IMAGE_FILE_DLL == 0 && image.OptionalHeader != nil
		image.Close()
		if !valid {
			fail(400, "invalid-agent-executable")
		}
		if file.Sync() != nil || file.Close() != nil {
			fail(500, "agent-release-storage-error")
		}
		release := &agentRelease{ID: uuid(), Name: name, Version: version, Size: size, SHA256: hex.EncodeToString(hash.Sum(nil)), UploadedAt: now()}
		// Recheck the login at publication time; account changes cannot race this step.
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		s.principal(r, "admin")
		if r.Context().Err() != nil || s.ctx.Err() != nil {
			fail(400, "agent-upload-incomplete")
		}
		u.mu.Lock()
		defer u.mu.Unlock()
		target := filepath.Join(u.directory, release.ID+".exe")
		if os.Rename(file.Name(), target) != nil {
			fail(500, "agent-release-storage-error")
		}
		if AtomicJSON(filepath.Join(u.directory, "latest.json"), release, 0600) != nil {
			os.Remove(target)
			fail(500, "agent-release-storage-error")
		}
		u.latest = release
		u.cleanup()
		return M{"release": release}
	})
	s.route("GET /v1/pc-agent/releases/{releaseId}/download", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		u := s.agentReleases
		u.mu.RLock()
		release := u.latest
		if release == nil || r.PathValue("releaseId") != release.ID {
			u.mu.RUnlock()
			fail(404, "agent-release-unavailable")
		}
		file, err := os.Open(filepath.Join(u.directory, release.ID+".exe"))
		u.mu.RUnlock()
		if err != nil {
			fail(404, "agent-release-unavailable")
		}
		defer file.Close()
		downloadHeaders(w)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=\"PC-Agent-Setup.exe\"; filename*=UTF-8''"+strings.ReplaceAll(url.PathEscape(release.Name), "'", "%27"))
		w.Header().Set("ETag", `"`+release.SHA256+`"`)
		http.ServeContent(w, r, release.Name, time.UnixMilli(release.UploadedAt), file)
		return nil
	})
}
