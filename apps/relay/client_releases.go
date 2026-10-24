package relay

import (
	"archive/zip"
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
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxClientReleaseBytes int64 = 512 * 1024 * 1024

var clientTargets = map[string]string{
	"agent-windows-x64-setup": ".exe", "agent-windows-x64-portable": ".exe",
	"agent-macos-arm64": ".dmg", "agent-macos-x64": ".dmg",
	"control-windows-x64": ".exe", "control-macos-arm64": ".dmg", "control-macos-x64": ".dmg", "control-android": ".apk",
}
var clientVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

type clientRelease struct {
	ID          string `json:"id"`
	Target      string `json:"target"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	BuildNumber int64  `json:"buildNumber"`
	Notes       string `json:"notes"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	UploadedAt  int64  `json:"uploadedAt"`
}
type clientReleaseStore struct {
	mu        sync.RWMutex
	upload    sync.Mutex
	directory string
	temporary bool
	latest    map[string]*clientRelease
}

func validClientRelease(v *clientRelease) bool {
	ext, ok := clientTargets[v.Target]
	return ok && validAgentInstallerName(strings.TrimSuffix(v.Name, filepath.Ext(v.Name))+".exe") && strings.EqualFold(filepath.Ext(v.Name), ext) && clientVersion.MatchString(v.Version) && len(v.Version) <= 80 && uuidPattern.MatchString(v.ID) && hex64.MatchString(v.SHA256) && v.Size >= 128 && v.Size <= maxClientReleaseBytes && v.BuildNumber >= 0 && v.BuildNumber <= 2147483647 && (v.Target != "control-android" || v.BuildNumber > 0) && jsLength(v.Notes) <= 2000
}
func newClientReleaseStore(directory string) (*clientReleaseStore, error) {
	var err error
	temporary := directory == ""
	if temporary {
		directory, err = os.MkdirTemp("", "codexer-client-releases-")
	} else {
		directory = filepath.Join(directory, "client-releases")
		err = os.MkdirAll(directory, 0700)
	}
	if err != nil {
		return nil, err
	}
	u := &clientReleaseStore{directory: directory, temporary: temporary, latest: map[string]*clientRelease{}}
	data, err := os.ReadFile(filepath.Join(directory, "latest.json"))
	if err == nil {
		if json.Unmarshal(data, &u.latest) != nil || u.latest == nil {
			return nil, errors.New("invalid-client-release-metadata")
		}
		for target, v := range u.latest {
			if v == nil || target != v.Target || !validClientRelease(v) {
				return nil, errors.New("invalid-client-release-metadata")
			}
			info, e := os.Stat(filepath.Join(directory, v.ID))
			if e != nil || !info.Mode().IsRegular() || info.Size() != v.Size {
				return nil, errors.New("client-release-file-missing")
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return u, nil
}
func (u *clientReleaseStore) close() {
	if u.temporary {
		_ = os.RemoveAll(u.directory)
	}
}
func (u *clientReleaseStore) current(target string) *clientRelease {
	u.mu.RLock()
	defer u.mu.RUnlock()
	v := u.latest[target]
	if v == nil {
		return nil
	}
	copy := *v
	return &copy
}
func (s *Server) clientReleasePrincipal(r *http.Request) *Principal {
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, "Bearer ") {
		fail(401, "unauthorized")
	}
	p := s.Store.Session(strings.TrimPrefix(value, "Bearer "), r.Header.Get("x-device-id"))
	if p == nil {
		fail(401, "unauthorized")
	}
	return p
}
func validClientPackage(file *os.File, target string, size int64) bool {
	ext := clientTargets[target]
	if ext == ".exe" {
		image, err := pe.NewFile(file)
		if err != nil {
			return false
		}
		defer image.Close()
		return image.OptionalHeader != nil && image.FileHeader.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE != 0 && image.FileHeader.Characteristics&pe.IMAGE_FILE_DLL == 0
	}
	if ext == ".apk" {
		archive, err := zip.NewReader(file, size)
		if err != nil {
			return false
		}
		for _, entry := range archive.File {
			if entry.Name == "AndroidManifest.xml" && entry.UncompressedSize64 > 0 {
				return true
			}
		}
		return false
	}
	footer := make([]byte, 4)
	_, err := file.ReadAt(footer, size-512)
	return err == nil && string(footer) == "koly"
}
func (s *Server) clientReleaseRoutes() {
	s.route("GET /v1/admin/client-releases", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		u := s.clientReleases
		u.mu.RLock()
		defer u.mu.RUnlock()
		w.Header().Set("Cache-Control", "no-store")
		result := map[string]*clientRelease{}
		for key, value := range u.latest {
			copy := *value
			result[key] = &copy
		}
		return M{"releases": result}
	})
	s.route("GET /v1/client-releases/{target}", "", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.clientReleasePrincipal(r)
		target := r.PathValue("target")
		if _, ok := clientTargets[target]; !ok {
			fail(400, "invalid-client-target")
		}
		w.Header().Set("Cache-Control", "no-store")
		return M{"release": s.clientReleases.current(target)}
	})
	s.route("PUT /v1/admin/client-releases/{target}", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		q := r.URL.Query()
		build, _ := strconv.ParseInt(q.Get("buildNumber"), 10, 64)
		if q.Get("buildNumber") != "" {
			if _, err := strconv.ParseInt(q.Get("buildNumber"), 10, 64); err != nil {
				fail(400, "invalid-client-release")
			}
		}
		release := &clientRelease{ID: uuid(), Target: r.PathValue("target"), Name: q.Get("name"), Version: q.Get("version"), BuildNumber: build, Notes: q.Get("notes"), Size: 128, SHA256: strings.Repeat("0", 64), UploadedAt: now()}
		if !validClientRelease(release) {
			fail(400, "invalid-client-release")
		}
		u := s.clientReleases
		if !u.upload.TryLock() {
			fail(409, "client-upload-in-progress")
		}
		defer u.upload.Unlock()
		if !s.beginJob() {
			fail(503, "relay-closing")
		}
		defer s.wg.Done()
		if r.ContentLength > maxClientReleaseBytes {
			fail(413, "client-installer-too-large")
		}
		upload := http.MaxBytesReader(w, r.Body, maxClientReleaseBytes)
		stop := context.AfterFunc(s.ctx, func() { upload.Close() })
		defer stop()
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Minute))
		defer http.NewResponseController(w).SetReadDeadline(time.Time{})
		file, err := os.CreateTemp(u.directory, "upload-*.tmp")
		if err != nil {
			fail(500, "client-release-storage-error")
		}
		defer func() { file.Close(); os.Remove(file.Name()) }()
		digest := sha256.New()
		size, err := io.Copy(io.MultiWriter(file, digest), upload)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				fail(413, "client-installer-too-large")
			}
			fail(400, "client-upload-incomplete")
		}
		if size < 128 || r.ContentLength >= 0 && size != r.ContentLength {
			fail(400, "client-upload-incomplete")
		}
		if !validClientPackage(file, release.Target, size) {
			fail(400, "invalid-client-package")
		}
		if file.Sync() != nil || file.Close() != nil {
			fail(500, "client-release-storage-error")
		}
		release.Size = size
		release.SHA256 = hex.EncodeToString(digest.Sum(nil))
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		s.principal(r, "admin")
		if r.Context().Err() != nil || s.ctx.Err() != nil {
			fail(400, "client-upload-incomplete")
		}
		u.mu.Lock()
		defer u.mu.Unlock()
		previous := u.latest[release.Target]
		u.latest[release.Target] = release
		destination := filepath.Join(u.directory, release.ID)
		if os.Rename(file.Name(), destination) != nil {
			if previous == nil {
				delete(u.latest, release.Target)
			} else {
				u.latest[release.Target] = previous
			}
			fail(500, "client-release-storage-error")
		}
		if AtomicJSON(filepath.Join(u.directory, "latest.json"), u.latest, 0600) != nil {
			os.Remove(destination)
			if previous == nil {
				delete(u.latest, release.Target)
			} else {
				u.latest[release.Target] = previous
			}
			fail(500, "client-release-storage-error")
		}
		if previous != nil {
			_ = os.Remove(filepath.Join(u.directory, previous.ID))
		}
		return M{"release": release}
	})
	s.route("GET /v1/client-releases/{target}/{releaseId}/download", "", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		s.clientReleasePrincipal(r)
		u := s.clientReleases
		u.mu.RLock()
		v := u.latest[r.PathValue("target")]
		if v == nil || v.ID != r.PathValue("releaseId") {
			u.mu.RUnlock()
			fail(404, "client-release-unavailable")
		}
		file, err := os.Open(filepath.Join(u.directory, v.ID))
		u.mu.RUnlock()
		if err != nil {
			fail(404, "client-release-unavailable")
		}
		defer file.Close()
		downloadHeaders(w)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("ETag", `"`+v.SHA256+`"`)
		w.Header().Set("Content-Disposition", `attachment; filename*=UTF-8''`+strings.ReplaceAll(url.PathEscape(v.Name), "'", "%27"))
		http.ServeContent(w, r, v.Name, time.UnixMilli(v.UploadedAt), file)
		return nil
	})
}
