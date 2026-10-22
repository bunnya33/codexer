package relay

import (
	"bytes"
	"crypto/sha256"
	"debug/pe"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func installerFixture(size int) []byte {
	var image bytes.Buffer
	dos := make([]byte, 128)
	dos[0] = 'M'
	dos[1] = 'Z'
	binary.LittleEndian.PutUint32(dos[60:], 128)
	image.Write(dos)
	image.WriteString("PE\x00\x00")
	optional := pe.OptionalHeader32{Magic: 0x10b, NumberOfRvaAndSizes: 16}
	binary.Write(&image, binary.LittleEndian, pe.FileHeader{Machine: pe.IMAGE_FILE_MACHINE_I386, SizeOfOptionalHeader: uint16(binary.Size(optional)), Characteristics: pe.IMAGE_FILE_EXECUTABLE_IMAGE})
	binary.Write(&image, binary.LittleEndian, optional)
	if size > image.Len() {
		image.Write(make([]byte, size-image.Len()))
	}
	return image.Bytes()
}
func TestAgentInstallerPublicationDownloadAndRestart(t *testing.T) {
	dir := t.TempDir()
	store, err := Open("", dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s, err := New(store, Options{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	admin := store.CreateUser("publisher", "test-password-12345", "admin")
	user := store.CreateUser("downloader", "test-password-12345", "user")
	adminToken := str(store.CreateSession(str(admin["id"]), "")["session"])
	userToken := str(store.CreateSession(str(user["id"]), "")["session"])
	call := func(method, path, token string, data io.Reader) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, data)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	endpoint := "/v1/admin/pc-agent/release?name=Agent-Setup.exe&version=0.2.6"
	if w := call("GET", "/v1/pc-agent/release", userToken, nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"release":null`) {
		t.Fatal(w.Code, w.Body.String())
	}
	for token, status := range map[string]int{"": 401, userToken: 403} {
		if w := call("PUT", endpoint, token, bytes.NewReader(installerFixture(512))); w.Code != status {
			t.Fatal("upload permission", w.Code)
		}
	}
	data := installerFixture(9 * 1024 * 1024)
	digest := sha256.Sum256(data)
	if w := call("PUT", endpoint, adminToken, bytes.NewReader(data)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	first := s.agentReleases.current()
	if first.Size != int64(len(data)) || first.SHA256 != hex.EncodeToString(digest[:]) || first.Version != "0.2.6" {
		t.Fatal("metadata mismatch")
	}
	path := "/v1/pc-agent/releases/" + first.ID + "/download"
	for token, status := range map[string]int{"": 401, adminToken: 403} {
		if w := call("GET", path, token, nil); w.Code != status {
			t.Fatal("download permission", w.Code)
		}
	}
	w := call("GET", path, userToken, nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || w.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("download mismatch", w.Code)
	}
	r := httptest.NewRequest("GET", path, nil)
	r.Header.Set("Authorization", "Bearer "+userToken)
	r.Header.Set("Range", "bytes=0-127")
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 206 || !bytes.Equal(w.Body.Bytes(), data[:128]) {
		t.Fatal("range download")
	}
	for _, test := range []struct {
		path   string
		body   []byte
		status int
	}{
		{endpoint, []byte(strings.Repeat("invalid", 128)), 400},
		{"/v1/admin/pc-agent/release?name=..%2Fbad.exe&version=0.2.7", data[:512], 400},
		{"/v1/admin/pc-agent/release?name=bad.zip&version=0.2.7", data[:512], 400},
		{"/v1/admin/pc-agent/release?name=bad.exe&version=oops", data[:512], 400},
	} {
		if got := call("PUT", test.path, adminToken, bytes.NewReader(test.body)); got.Code != test.status {
			t.Fatal(got.Code, got.Body.String())
		}
		if s.agentReleases.current().ID != first.ID {
			t.Fatal("failed upload replaced release")
		}
	}
	for _, length := range []int64{maxAgentInstallerBytes + 1, 513} {
		r := httptest.NewRequest("PUT", endpoint, bytes.NewReader(data[:512]))
		r.ContentLength = length
		r.Header.Set("Authorization", "Bearer "+adminToken)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		want := 400
		if length > maxAgentInstallerBytes {
			want = 413
		}
		if w.Code != want {
			t.Fatal("size limit", w.Code)
		}
	}
	// An in-flight upload leaves the old version readable and rejects a second writer.
	reader, writer := io.Pipe()
	pending := make(chan *httptest.ResponseRecorder, 1)
	go func() { pending <- call("PUT", endpoint, adminToken, reader) }()
	if _, err = writer.Write(data[:128]); err != nil {
		t.Fatal(err)
	}
	if w := call("PUT", endpoint, adminToken, bytes.NewReader(data[:512])); w.Code != 409 {
		t.Fatal("concurrent upload", w.Code)
	}
	if w := call("GET", path, userToken, nil); w.Code != 200 {
		t.Fatal("old release not available during upload")
	}
	writer.CloseWithError(io.ErrUnexpectedEOF)
	if w := <-pending; w.Code != 400 {
		t.Fatal("partial upload accepted", w.Code)
	}
	if s.agentReleases.current().ID != first.ID {
		t.Fatal("partial upload replaced release")
	}
	// Expired/revoked upload sessions cannot publish even after bytes have arrived.
	reader, writer = io.Pipe()
	go func() { pending <- call("PUT", endpoint, adminToken, reader) }()
	writer.Write(data[:128])
	store.Logout(hash(adminToken))
	writer.Write(data[128:512])
	writer.Close()
	if w := <-pending; w.Code != 401 {
		t.Fatal("revoked uploader published", w.Code)
	}
	adminToken = str(store.CreateSession(str(admin["id"]), "")["session"])
	if w := call("PUT", strings.Replace(endpoint, "0.2.6", "0.2.7", 1), adminToken, bytes.NewReader(data[:512])); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	latest := s.agentReleases.current()
	if latest.ID == first.ID || latest.Version != "0.2.7" {
		t.Fatal("latest not replaced")
	}
	if w := call("GET", path, userToken, nil); w.Code != 404 {
		t.Fatal("stale version not rejected")
	}
	entries, _ := os.ReadDir(s.agentReleases.directory)
	if len(entries) != 2 {
		t.Fatalf("unfinished/old files retained: %d", len(entries))
	}
	s.Close()
	s, err = New(store, Options{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.agentReleases.current(); got.ID != latest.ID || got.SHA256 != latest.SHA256 {
		t.Fatal("restart lost release")
	}
	w = call("GET", "/v1/pc-agent/releases/"+latest.ID+"/download", userToken, nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data[:512]) {
		t.Fatal("restart download mismatch")
	}
	var manifest agentRelease
	b, _ := os.ReadFile(filepath.Join(dir, "agent-releases", "latest.json"))
	if json.Unmarshal(b, &manifest) != nil || manifest.ID != latest.ID {
		t.Fatal("manifest not persisted")
	}
}
