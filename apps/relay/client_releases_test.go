package relay

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientReleaseCatalogIsolationAuthenticationAndRestart(t *testing.T) {
	directory := t.TempDir()
	store, err := Open("", directory)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server, err := New(store, Options{DataDir: directory})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { server.Close() }()
	admin := store.CreateUser("publisher", "test-password-12345", "admin")
	user := store.CreateUser("reader", "test-password-12345", "user")
	adminToken := str(store.CreateSession(str(admin["id"]), "")["session"])
	userToken := str(store.CreateSession(str(user["id"]), "")["session"])
	deviceID := store.Register(str(user["id"]), uuid(), "PC", "win32")
	deviceToken := str(store.CreateSession(str(user["id"]), deviceID)["session"])
	call := func(method, path, token, device string, data []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if device != "" {
			r.Header.Set("x-device-id", device)
		}
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		return w
	}
	endpoint := "/v1/admin/client-releases/agent-windows-x64-setup?name=Agent.exe&version=0.2.12"
	if w := call("PUT", endpoint, userToken, "", installerFixture(1024)); w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("PUT", endpoint, adminToken, "", installerFixture(1024)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("GET", "/v1/client-releases/agent-windows-x64-setup", "", "", nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := call("GET", "/v1/client-releases/agent-windows-x64-setup", deviceToken, "", nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	response := call("GET", "/v1/client-releases/agent-windows-x64-setup", deviceToken, deviceID, nil)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	var result struct {
		Release clientRelease `json:"release"`
	}
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Release.Version != "0.2.12" {
		t.Fatal(response.Body.String())
	}
	path := "/v1/client-releases/agent-windows-x64-setup/" + result.Release.ID + "/download"
	if w := call("GET", path, userToken, "", nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), installerFixture(1024)) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("GET", strings.Replace(path, "agent-windows-x64-setup", "control-windows-x64", 1), userToken, "", nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if w := call("GET", "/v1/client-releases/control-windows-x64", userToken, "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"release":null`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("PUT", endpoint, adminToken, "", []byte("bad")); w.Code != 400 {
		t.Fatal(w.Code)
	}
	server.Close()
	server, err = New(store, Options{DataDir: directory})
	if err != nil {
		t.Fatal(err)
	}
	if w := call("GET", path, userToken, "", nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var apk bytes.Buffer
	archive := zip.NewWriter(&apk)
	entry, _ := archive.Create("AndroidManifest.xml")
	io.WriteString(entry, strings.Repeat("manifest", 30))
	archive.Close()
	if w := call("PUT", "/v1/admin/client-releases/control-android?name=Control.apk&version=0.1.4&buildNumber=5", adminToken, "", apk.Bytes()); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, query := range []string{"name=bad.exe&version=0.1.4&buildNumber=5", "name=Control.apk&version=0.1.4&buildNumber=0", "name=Control.apk&version=0.1.4&buildNumber=oops", "name=Control.apk&version=0.1.4&buildNumber=2147483648"} {
		if w := call("PUT", "/v1/admin/client-releases/control-android?"+query, adminToken, "", apk.Bytes()); w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
	if w := call("PUT", "/v1/admin/client-releases/control-android?name=Control.apk&version=0.1.4&buildNumber=6", adminToken, "", installerFixture(1024)); w.Code != 400 {
		t.Fatal(w.Code)
	}
}
