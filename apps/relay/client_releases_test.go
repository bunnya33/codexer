package relay

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

type clientReleaseBlockedDownload struct {
	*httptest.ResponseRecorder
	started chan struct{}
	resume  chan struct{}
}

func (w *clientReleaseBlockedDownload) Write(data []byte) (int, error) {
	select {
	case <-w.started:
	default:
		close(w.started)
	}
	<-w.resume
	return w.ResponseRecorder.Write(data)
}

func TestClientReleaseHistoryDeletionAndLegacyMigration(t *testing.T) {
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
	call := func(method, path, token string, data []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		return w
	}
	upload := func(target, version string) clientRelease {
		w := call("PUT", "/v1/admin/client-releases/"+target+"?name=Agent.exe&version="+version, adminToken, installerFixture(1024))
		var result struct {
			Release clientRelease `json:"release"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		return result.Release
	}
	list := func() []clientRelease {
		w := call("GET", "/v1/admin/client-releases", adminToken, nil)
		var result struct {
			Packages []clientRelease `json:"packages"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		return result.Packages
	}
	deletePath := func(v clientRelease) string { return "/v1/admin/client-releases/" + v.Target + "/" + v.ID }
	downloadPath := func(v clientRelease) string { return "/v1/client-releases/" + v.Target + "/" + v.ID + "/download" }
	first := upload("agent-windows-x64-setup", "0.2.12")
	// Simulate the previous server's latest.json-only directory.
	server.Close()
	if err := os.Remove(filepath.Join(directory, "client-releases", first.ID+".json")); err != nil {
		t.Fatal(err)
	}
	server, err = New(store, Options{DataDir: directory})
	if err != nil {
		t.Fatal(err)
	}
	if got := list(); len(got) != 1 || got[0].ID != first.ID {
		t.Fatal(got)
	}

	blocked := &clientReleaseBlockedDownload{httptest.NewRecorder(), make(chan struct{}), make(chan struct{})}
	r := httptest.NewRequest("GET", downloadPath(first), nil)
	r.Header.Set("Authorization", "Bearer "+userToken)
	done := make(chan struct{})
	go func() { defer close(done); server.Handler().ServeHTTP(blocked, r) }()
	<-blocked.started
	second := upload("agent-windows-x64-setup", "0.2.13")
	other := upload("control-windows-x64", "0.2.12")
	if w := call("DELETE", deletePath(first), adminToken, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "client-release-in-use") {
		t.Fatal(w.Code, w.Body.String())
	}
	close(blocked.resume)
	<-done
	if blocked.Code != 200 || !bytes.Equal(blocked.Body.Bytes(), installerFixture(1024)) {
		t.Fatal("replacement interrupted download")
	}
	if len(list()) != 3 {
		t.Fatal("history was discarded")
	}
	if w := call("GET", downloadPath(first), userToken, nil); w.Code != 404 {
		t.Fatal("historical package still advertised", w.Code)
	}
	for _, test := range []struct {
		method, path, token string
		status              int
	}{
		{"GET", "/v1/admin/client-releases", userToken, 403},
		{"DELETE", deletePath(first), "", 401},
		{"DELETE", deletePath(first), userToken, 403},
		{"DELETE", strings.Replace(deletePath(first), first.Target, other.Target, 1), adminToken, 404},
	} {
		if w := call(test.method, test.path, test.token, nil); w.Code != test.status {
			t.Fatal(test, w.Code, w.Body.String())
		}
	}
	server.clientReleases.upload.Lock()
	w := call("DELETE", deletePath(first), adminToken, nil)
	server.clientReleases.upload.Unlock()
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("DELETE", deletePath(first), adminToken, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, suffix := range []string{"", ".json"} {
		if _, err := os.Stat(filepath.Join(directory, "client-releases", first.ID+suffix)); !os.IsNotExist(err) {
			t.Fatal("history not removed", err)
		}
	}
	if w := call("GET", downloadPath(second), userToken, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := call("DELETE", deletePath(first), adminToken, nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
	// A surviving historical package must not become current after removing the published package.
	third := upload("agent-windows-x64-setup", "0.2.14")
	if w := call("DELETE", deletePath(third), adminToken, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("GET", "/v1/client-releases/"+third.Target, userToken, nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"release":null`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("GET", downloadPath(third), userToken, nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if w := call("GET", downloadPath(other), userToken, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	server.Close()
	server, err = New(store, Options{DataDir: directory})
	if err != nil {
		t.Fatal(err)
	}
	if len(list()) != 2 || server.clientReleases.current(second.Target) != nil || server.clientReleases.current(other.Target).ID != other.ID {
		t.Fatal("restart changed catalog")
	}

	// A metadata write failure must leave the published payload and catalog intact.
	latestPath := filepath.Join(directory, "client-releases", "latest.json")
	latest, err := os.ReadFile(latestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(latestPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(latestPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(latestPath, "block"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := call("DELETE", deletePath(other), adminToken, nil); w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("PUT", "/v1/admin/client-releases/"+other.Target+"?name=Agent.exe&version=0.2.15", adminToken, installerFixture(1024)); w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("GET", downloadPath(other), userToken, nil); w.Code != http.StatusOK || len(list()) != 2 {
		t.Fatal("storage error changed catalog", w.Code)
	}
	if err := os.Remove(filepath.Join(latestPath, "block")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(latestPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(latestPath, latest, 0600); err != nil {
		t.Fatal(err)
	}
	server.Close()
	server, err = New(store, Options{DataDir: directory})
	if err != nil || len(list()) != 2 {
		t.Fatal("failed upload left orphan catalog", err)
	}
}

func TestClientReleaseMetadataCorrection(t *testing.T) {
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
	call := func(method, path, token string, data []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if token == deviceToken {
			r.Header.Set("x-device-id", deviceID)
		}
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		return w
	}
	var apk bytes.Buffer
	archive := zip.NewWriter(&apk)
	entry, _ := archive.Create("AndroidManifest.xml")
	io.WriteString(entry, strings.Repeat("manifest", 30))
	archive.Close()
	upload := func(version string) clientRelease {
		w := call("PUT", "/v1/admin/client-releases/control-android?name=Control.apk&version="+version+"&buildNumber=4&notes=release", adminToken, apk.Bytes())
		var result struct {
			Release clientRelease `json:"release"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		return result.Release
	}
	endpoint := func(v clientRelease) string { return "/v1/admin/client-releases/" + v.Target + "/" + v.ID }
	change := func(v clientRelease, version string, build int64) []byte {
		data, _ := json.Marshal(M{"version": version, "buildNumber": build, "expectedVersion": v.Version, "expectedBuildNumber": v.BuildNumber})
		return data
	}
	first, current := upload("0.1.3"), upload("0.1.4")
	for _, test := range []struct {
		token  string
		status int
	}{{"", 401}, {userToken, 403}, {deviceToken, 401}} {
		if w := call("PATCH", endpoint(current), test.token, change(current, "0.1.4", 5)); w.Code != test.status {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, field := range []M{
		{"version": "bad", "buildNumber": 5}, {"version": "0.1.4", "buildNumber": 0},
		{"version": "0.1.4", "buildNumber": -1}, {"version": "0.1.4", "buildNumber": 1.5},
		{"version": "0.1.4", "buildNumber": "5"}, {"version": "0.1.4", "buildNumber": 2147483648},
		{"version": "0.1.4"}, {"buildNumber": 5}, {"version": 14, "buildNumber": 5},
	} {
		field["expectedVersion"], field["expectedBuildNumber"] = current.Version, current.BuildNumber
		data, _ := json.Marshal(field)
		if w := call("PATCH", endpoint(current), adminToken, data); w.Code != 400 {
			t.Fatal(field, w.Code, w.Body.String())
		}
	}
	if w := call("PATCH", strings.Replace(endpoint(current), current.Target, "agent-windows-x64-setup", 1), adminToken, change(current, "0.1.4", 5)); w.Code != 404 {
		t.Fatal(w.Code)
	}
	server.clientReleases.upload.Lock()
	w := call("PATCH", endpoint(current), adminToken, change(current, "0.1.4", 5))
	server.clientReleases.upload.Unlock()
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}

	// Correct metadata while a download is active; neither bytes nor immutable identity change.
	blocked := &clientReleaseBlockedDownload{httptest.NewRecorder(), make(chan struct{}), make(chan struct{})}
	r := httptest.NewRequest("GET", "/v1/client-releases/"+current.Target+"/"+current.ID+"/download", nil)
	r.Header.Set("Authorization", "Bearer "+userToken)
	done := make(chan struct{})
	go func() { defer close(done); server.Handler().ServeHTTP(blocked, r) }()
	<-blocked.started
	w = call("PATCH", endpoint(current), adminToken, change(current, "0.1.5", 5))
	close(blocked.resume)
	<-done
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if blocked.Code != 200 || !bytes.Equal(blocked.Body.Bytes(), apk.Bytes()) {
		t.Fatal("metadata edit changed active download")
	}
	expected := current
	expected.Version, expected.BuildNumber = "0.1.5", 5
	if got := server.clientReleases.current(current.Target); got == nil || *got != expected {
		t.Fatal("metadata changed unrelated fields", got)
	}
	if w := call("GET", "/v1/client-releases/"+current.Target, userToken, nil); !strings.Contains(w.Body.String(), `"buildNumber":5`) {
		t.Fatal(w.Body.String())
	}
	if w := call("PATCH", endpoint(current), adminToken, change(current, "0.1.6", 6)); w.Code != 409 || !strings.Contains(w.Body.String(), "client-release-changed") {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("PATCH", endpoint(first), adminToken, change(first, "9.0.0", 2147483647)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := server.clientReleases.current(current.Target); *got != expected {
		t.Fatal("editing history republished it")
	}
	server.Close()
	server, err = New(store, Options{DataDir: directory})
	if err != nil {
		t.Fatal(err)
	}
	if got := server.clientReleases.current(current.Target); *got != expected {
		t.Fatal("current edit lost after restart")
	}
	if got := server.clientReleases.releases[first.ID]; got.Version != "9.0.0" || got.BuildNumber != 2147483647 {
		t.Fatal("history edit lost after restart")
	}
	for _, v := range []clientRelease{first, current} {
		if data, err := os.ReadFile(filepath.Join(directory, "client-releases", v.ID)); err != nil || !bytes.Equal(data, apk.Bytes()) {
			t.Fatal("payload changed", err)
		}
	}

	// The current catalog and per-package index must roll back together on I/O failure.
	latestPath := filepath.Join(directory, "client-releases", "latest.json")
	latest, err := os.ReadFile(latestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(latestPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(latestPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(latestPath, "block"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := call("PATCH", endpoint(expected), adminToken, change(expected, "0.1.6", 6)); w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := server.clientReleases.current(current.Target); *got != expected {
		t.Fatal("failed save changed current metadata")
	}
	var persisted clientRelease
	data, err := os.ReadFile(filepath.Join(directory, "client-releases", current.ID+".json"))
	if err != nil || json.Unmarshal(data, &persisted) != nil || persisted != expected {
		t.Fatal("failed save changed package index", err)
	}
	if err := os.Remove(filepath.Join(latestPath, "block")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(latestPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(latestPath, latest, 0600); err != nil {
		t.Fatal(err)
	}
	server.Close()
	server, err = New(store, Options{DataDir: directory})
	if err != nil {
		t.Fatal(err)
	}
	if got := server.clientReleases.current(current.Target); *got != expected {
		t.Fatal("failed save survived restart")
	}
	if w := call("DELETE", endpoint(expected), adminToken, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := call("PATCH", endpoint(expected), adminToken, change(expected, "0.1.6", 6)); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
