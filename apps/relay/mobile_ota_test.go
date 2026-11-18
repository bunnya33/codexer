package relay

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMobileOTAMatchesPlatformAndRuntime(t *testing.T) {
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "mobile-ota")
	runtime := strings.Repeat("a", 40)
	hash := strings.Repeat("b", 64)
	manifest := `{"runtimeVersion":"` + runtime + `", "metadata":{}}`
	signature := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 256))
	for name, body := range map[string]string{
		filepath.Join("0.3.71", "ios", runtime+".json"): `{"manifest":` + manifest + `,"signature":"` + signature + `"}`,
		filepath.Join("assets", hash):                   "bundle",
	} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{Options: Options{DataDir: dataDir, Version: "0.3.71"}, mux: http.NewServeMux()}
	s.mobileOTARoutes()
	check := func(platform, version string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "http://relay.test/v1/mobile-ota/manifest?relayVersion="+version, nil)
		r.Header.Set("Expo-Platform", platform)
		r.Header.Set("Expo-Runtime-Version", runtime)
		s.mux.ServeHTTP(w, r)
		return w
	}
	if w := check("ios", "0.3.71"); w.Code != 200 || w.Body.String() != manifest ||
		w.Header().Get("Content-Type") != "application/expo+json" ||
		!strings.Contains(w.Header().Get("Expo-Signature"), "sig=:"+signature+":") {
		t.Fatalf("unexpected manifest response: %d %s", w.Code, w.Body)
	}
	if w := check("android", "0.3.71"); w.Code != 204 || w.Header().Get("Expo-Protocol-Version") != "1" {
		t.Fatalf("unexpected response for Android: %d %s", w.Code, w.Body)
	}
	if w := check("ios", "0.3.70"); w.Code != 204 {
		t.Fatalf("unexpected response for older Relay version: %d", w.Code)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "http://relay.test/v1/mobile-ota/assets/"+hash, nil)
	r.Header.Set("Range", "bytes=0-2")
	s.mux.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "bun" {
		t.Fatalf("unexpected asset response: %d %s", w.Code, w.Body)
	}
}
