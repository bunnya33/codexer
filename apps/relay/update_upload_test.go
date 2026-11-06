package relay

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func updateArchive(t *testing.T, version, targetOS, arch string, extra *tar.Header) []byte {
	t.Helper()
	var data bytes.Buffer
	gz := gzip.NewWriter(&data)
	tw := tar.NewWriter(gz)
	for _, v := range []struct {
		name string
		data []byte
	}{
		{"codexer/server-bundle.json", []byte(js(M{"kind": "codexer-server-bundle", "runtime": "go", "version": version, "os": targetOS, "arch": arch}))},
		{"codexer/VERSION", []byte(version + "\n")},
		{"codexer/codexer", bytes.Repeat([]byte{1}, 1024*1024)},
	} {
		if e := tw.WriteHeader(&tar.Header{Name: v.name, Mode: 0644, Size: int64(len(v.data))}); e != nil {
			t.Fatal(e)
		}
		if _, e := tw.Write(v.data); e != nil {
			t.Fatal(e)
		}
	}
	if extra != nil {
		if e := tw.WriteHeader(extra); e != nil {
			t.Fatal(e)
		}
	}
	if e := tw.Close(); e != nil {
		t.Fatal(e)
	}
	if e := gz.Close(); e != nil {
		t.Fatal(e)
	}
	return data.Bytes()
}
func uploadUpdates(t *testing.T) *Updates {
	t.Helper()
	dir := t.TempDir()
	status := filepath.Join(dir, "status.json")
	if e := AtomicJSON(status, M{"enabled": true, "protocol": 2, "gitSupported": true, "uploadSupported": true}, 0600); e != nil {
		t.Fatal(e)
	}
	u := NewUpdates("0.3.38", dir, status)
	u.Checked = now()
	u.Method = "release"
	u.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
		t.Error("manual upload attempted network access")
		return nil, io.EOF
	})
	return u
}
func uploadName() string {
	return "codexer-server-0.3.39-" + runtime.GOOS + "-" + runtime.GOARCH + ".tar.gz"
}
func uploadHash(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }
func uploadAuthorized() func()      { return func() {} }

type pausedUpdateReader struct {
	reader           io.Reader
	started, release chan struct{}
	once             sync.Once
}

func (r *pausedUpdateReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	<-r.release
	return r.reader.Read(p)
}

func TestServerUploadBlocksConcurrentUpdates(t *testing.T) {
	u := uploadUpdates(t)
	data := updateArchive(t, "0.3.39", runtime.GOOS, runtime.GOARCH, nil)
	reader := &pausedUpdateReader{reader: bytes.NewReader(data), started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan any, 1)
	go func() {
		defer func() {
			if e := recover(); e != nil {
				done <- e
			}
		}()
		done <- u.Upload(uploadName(), uploadHash(data), int64(len(data)), reader, uploadAuthorized)
	}()
	<-reader.started
	for _, fn := range []func(){func() { u.Request("v0.3.39", "update", "") }, func() { u.Settings(M{"method": "git"}) }, func() {
		u.Upload(uploadName(), uploadHash(data), int64(len(data)), bytes.NewReader(data), uploadAuthorized)
	}} {
		expectFault(t, "update-in-progress", fn)
	}
	close(reader.release)
	if job, ok := (<-done).(M); !ok || job["phase"] != "queued" {
		t.Fatal("upload did not finish", job)
	}
}

func TestServerUploadOfflineQueueAndManualRestart(t *testing.T) {
	u := uploadUpdates(t)
	data := updateArchive(t, "0.3.39", runtime.GOOS, runtime.GOARCH, nil)
	job := u.Upload(uploadName(), uploadHash(data), int64(len(data)), bytes.NewReader(data), uploadAuthorized)
	if job["source"] != "upload" || job["phase"] != "queued" {
		t.Fatal(job)
	}
	u.Checked = 0
	u.Method = ""
	if info := u.Info(false); obj(info["job"])["source"] != "upload" || info["uploadSupported"] != true {
		t.Fatal("offline polling", info)
	}
	u.Checked = now()
	u.Method = "release"
	stored, e := os.ReadFile(filepath.Join(u.Dir, str(job["id"])+".tar.gz"))
	if e != nil || !bytes.Equal(stored, data) {
		t.Fatal("queued archive mismatch")
	}
	expectFault(t, "update-in-progress", func() {
		u.Upload(uploadName(), uploadHash(data), int64(len(data)), bytes.NewReader(data), uploadAuthorized)
	})
	os.Remove(filepath.Join(u.Dir, "request.json"))
	job["phase"] = "built"
	job["updatedAt"] = now() + 1
	AtomicJSON(u.Status, M{"enabled": true, "protocol": 2, "uploadSupported": true, "gitSupported": true, "job": job}, 0600)
	u.Settings(M{"method": "git"})
	expectFault(t, "update-step-not-ready", func() { u.Request("v0.3.39", "restart", uuid()) })
	restart := u.Request("v0.3.39", "restart", str(job["id"]))
	if restart["method"] != "upload" || restart["source"] != "upload" || restart["sha256"] != uploadHash(data) {
		t.Fatal("uploaded job lost on restart", restart)
	}
}
func TestServerUploadRejectsInvalidInputAndCleansTemporaryFiles(t *testing.T) {
	data := updateArchive(t, "0.3.39", runtime.GOOS, runtime.GOARCH, nil)
	for _, test := range []struct {
		name, code string
		change     func(*Updates) (string, string, int64, io.Reader)
	}{
		{"old helper", "upload-updater-not-installed", func(u *Updates) (string, string, int64, io.Reader) {
			AtomicJSON(u.Status, M{"enabled": true, "protocol": 2}, 0600)
			return uploadName(), uploadHash(data), int64(len(data)), bytes.NewReader(data)
		}},
		{"wrong platform", "invalid-server-update-name", func(*Updates) (string, string, int64, io.Reader) {
			return "codexer-server-0.3.39-other-other.tar.gz", uploadHash(data), int64(len(data)), bytes.NewReader(data)
		}},
		{"downgrade", "update-not-newer", func(u *Updates) (string, string, int64, io.Reader) {
			u.Version = "0.3.39"
			return uploadName(), uploadHash(data), int64(len(data)), bytes.NewReader(data)
		}},
		{"hash mismatch", "checksum-mismatch", func(*Updates) (string, string, int64, io.Reader) {
			return uploadName(), strings.Repeat("0", 64), int64(len(data)), bytes.NewReader(data)
		}},
		{"incomplete", "server-update-upload-incomplete", func(*Updates) (string, string, int64, io.Reader) {
			return uploadName(), uploadHash(data), int64(len(data) + 1), bytes.NewReader(data)
		}},
		{"too large", "server-update-too-large", func(*Updates) (string, string, int64, io.Reader) {
			return uploadName(), uploadHash(data), MaxServerUpdateBytes + 1, bytes.NewReader(data)
		}},
		{"revoked login", "unauthorized", func(*Updates) (string, string, int64, io.Reader) {
			return uploadName(), uploadHash(data), int64(len(data)), bytes.NewReader(data)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			u := uploadUpdates(t)
			name, hash, size, reader := test.change(u)
			authorize := uploadAuthorized
			if test.name == "revoked login" {
				authorize = func() func() { fail(401, "unauthorized"); return nil }
			}
			expectFault(t, test.code, func() { u.Upload(name, hash, size, reader, authorize) })
			entries, _ := os.ReadDir(u.Dir)
			for _, entry := range entries {
				if entry.Name() != "status.json" {
					t.Fatal("partial upload survived", entry.Name())
				}
			}
			if u.uploading {
				t.Fatal("upload lock not released")
			}
		})
	}
}
func TestServerBundleInspectionBoundaries(t *testing.T) {
	data := updateArchive(t, "0.3.39", runtime.GOOS, runtime.GOARCH, nil)
	for _, test := range []struct {
		name          string
		data          []byte
		version, arch string
	}{
		{"valid", data, "0.3.39", runtime.GOARCH},
		{"version", data, "0.3.40", runtime.GOARCH},
		{"platform", data, "0.3.39", "other"},
		{"truncated", data[:len(data)-4], "0.3.39", runtime.GOARCH},
		{"traversal", updateArchive(t, "0.3.39", runtime.GOOS, runtime.GOARCH, &tar.Header{Name: "codexer/../escape", Typeflag: tar.TypeReg}), "0.3.39", runtime.GOARCH},
		{"symlink", updateArchive(t, "0.3.39", runtime.GOOS, runtime.GOARCH, &tar.Header{Name: "codexer/link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}), "0.3.39", runtime.GOARCH},
		{"duplicate", updateArchive(t, "0.3.39", runtime.GOOS, runtime.GOARCH, &tar.Header{Name: "codexer/VERSION", Typeflag: tar.TypeReg}), "0.3.39", runtime.GOARCH},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "bundle")
			os.WriteFile(p, test.data, 0600)
			e := InspectServerUpdateArchive(p, test.version, runtime.GOOS, test.arch)
			if (e == nil) != (test.name == "valid") {
				t.Fatal(e)
			}
		})
	}
}
func TestServerUploadRouteRequiresAdmin(t *testing.T) {
	store, s, user, _ := fixture(t)
	s.updates = uploadUpdates(t)
	admin := store.CreateUser("publisher", "test-password-12345", "admin")
	token := str(store.CreateSession(str(admin["id"]), "")["session"])
	userToken := str(store.CreateSession(user.ID, "")["session"])
	data := updateArchive(t, "0.3.39", runtime.GOOS, runtime.GOARCH, nil)
	for _, test := range []struct {
		token  string
		status int
	}{{"", 401}, {userToken, 403}, {token, 200}} {
		r := httptest.NewRequest("PUT", "/v1/admin/system/update-package?name="+uploadName()+"&sha256="+uploadHash(data), bytes.NewReader(data))
		r.Header.Set("Authorization", "Bearer "+test.token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
