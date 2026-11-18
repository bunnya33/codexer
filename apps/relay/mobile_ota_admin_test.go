package relay

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMobileOTAAdminPublishesAndUnpublishesScriptFormat(t *testing.T) {
	const (
		version  = "0.3.73"
		platform = "android"
		endpoint = "/v1/admin/mobile-ota"
		source   = "http://relay.test/v1/mobile-ota/manifest?relayVersion=" + version
	)
	directory := t.TempDir()
	store, err := Open("", directory)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server, err := New(store, Options{DataDir: directory, Version: version})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	token := func(role string) string {
		account := store.CreateUser(role+"-test", "test-password-12345", role)
		return str(store.CreateSession(str(account["id"]), "")["session"])
	}
	admin, user := token("admin"), token("user")
	runtime := strings.Repeat("a", 40)
	activePath := filepath.Join(version, platform, runtime+".json")
	call := func(method, path, token string, data []byte, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		r.Header.Set("Expo-Platform", platform)
		r.Header.Set("Expo-Runtime-Version", runtime)
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, w.Code, want, w.Body.String())
		}
		return w
	}
	call(http.MethodGet, endpoint, "", nil, 401)
	call(http.MethodPut, endpoint, user, nil, 403)
	keyFor := func(scope string) string {
		t.Helper()
		body := []byte(js(M{"name": scope, "scopes": []string{scope}, "expiresInDays": 7}))
		result := call(http.MethodPost, "/v1/admin/publishing/keys", admin, body, 200)
		var credential struct{ Code string }
		if err := json.Unmarshal(result.Body.Bytes(), &credential); err != nil || credential.Code == "" {
			t.Fatal("unable to obtain test publishing credential", err)
		}
		return credential.Code
	}
	reader, writer, serverWriter := keyFor("clients:read"), keyFor("clients:write"), keyFor("server:write")
	call(http.MethodGet, endpoint, reader, nil, 200)
	call(http.MethodGet, endpoint, writer, nil, 403)
	call(http.MethodPut, endpoint, reader, nil, 403)
	call(http.MethodPut, endpoint, serverWriter, nil, 403)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	createdAt := time.Now().UTC().Truncate(time.Millisecond)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: createdAt.Add(-time.Hour), NotAfter: createdAt.Add(time.Hour)}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	asset := []byte("Hermes bundle fixture")
	digest := sha256.Sum256(asset)
	hash := hex.EncodeToString(digest[:])
	assetPath := "assets/" + hash
	manifest := func(id, label string, at time.Time) otaSignedManifest {
		t.Helper()
		raw, err := json.Marshal(M{
			"id": id, "runtimeVersion": runtime, "createdAt": at,
			"metadata": M{"relayUpdateUrl": source, "releaseLabel": label},
			"launchAsset": M{
				"url":  "http://relay.test/v1/mobile-ota/" + assetPath,
				"hash": base64.RawURLEncoding.EncodeToString(digest[:]),
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(raw)
		sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
		if err != nil {
			t.Fatal(err)
		}
		return otaSignedManifest{Manifest: raw, Signature: base64.StdEncoding.EncodeToString(sig)}
	}
	legacyID, releaseID := uuid(), uuid()
	legacy := manifest(legacyID, "", createdAt)
	root := filepath.Join(directory, "mobile-ota")
	if err := os.MkdirAll(filepath.Join(root, filepath.Dir(activePath)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := AtomicJSON(filepath.Join(root, activePath), legacy, 0o644); err != nil {
		t.Fatal(err)
	}
	expectActive := func(id string) {
		t.Helper()
		w := call(http.MethodGet, endpoint, admin, nil, 200)
		if !strings.Contains(w.Body.String(), id) {
			t.Fatalf("missing update %s in catalog %s", id, w.Body.String())
		}
		w = call(http.MethodGet, source, "", nil, 200)
		if !strings.Contains(w.Body.String(), id) || w.Header().Get("Expo-Signature") == "" {
			t.Fatalf("missing signed public update: %s", w.Body.String())
		}
	}
	expectActive(legacyID)

	release := manifest(releaseID, "2026.11.18.1", createdAt.Add(time.Second))
	pack := func(update otaSignedManifest, manifestPath, resourceName string, resource []byte) []byte {
		t.Helper()
		envelope, err := json.Marshal(update)
		if err != nil {
			t.Fatal(err)
		}
		var buffer bytes.Buffer
		compressed := gzip.NewWriter(&buffer)
		archive := tar.NewWriter(compressed)
		for name, data := range map[string][]byte{
			filepath.ToSlash(manifestPath): envelope,
			"certificate.pem":              pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}),
			resourceName:                   resource,
		} {
			if err := archive.WriteHeader(&tar.Header{Name: name, Size: int64(len(data)), Mode: 0o644}); err != nil {
				t.Fatal(err)
			}
			if _, err := archive.Write(data); err != nil {
				t.Fatal(err)
			}
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		if err := compressed.Close(); err != nil {
			t.Fatal(err)
		}
		return buffer.Bytes()
	}

	invalidSignature := release
	invalidSignature.Signature = legacy.Signature
	call(http.MethodPut, endpoint, admin, pack(invalidSignature, activePath, assetPath, asset), 400)
	call(http.MethodPut, endpoint, admin, pack(release, activePath, assetPath, []byte("changed asset")), 400)
	call(http.MethodPut, endpoint, admin, pack(release, activePath, "../"+hash, asset), 400)
	call(http.MethodPut, endpoint, admin, pack(release, strings.Replace(activePath, version, "0.3.72", 1), assetPath, asset), 409)
	expectActive(legacyID)

	valid := pack(release, activePath, assetPath, asset)
	name := "frogcoder-ota-" + version + "-" + platform + "-" + releaseID + ".tar.gz"
	archiveDigest := sha256.Sum256(valid)
	call(http.MethodPut, endpoint+"?name="+name+"&sha256="+strings.Repeat("0", 64), writer, valid, 400)
	call(http.MethodPut, endpoint+"?name=wrong.tar.gz&sha256="+hex.EncodeToString(archiveDigest[:]), writer, valid, 400)
	expectActive(legacyID)
	call(http.MethodPut, endpoint+"?name="+name+"&sha256="+hex.EncodeToString(archiveDigest[:]), writer, valid, 200)
	if err := os.Remove(filepath.Join(root, filepath.FromSlash(assetPath))); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPut, endpoint, admin, valid, 200)
	call(http.MethodPut, endpoint, admin, pack(legacy, activePath, assetPath, asset), 409)
	expectActive(releaseID)
	if w := call(http.MethodGet, "/v1/mobile-ota/"+assetPath, "", nil, 200); !bytes.Equal(w.Body.Bytes(), asset) {
		t.Fatal(w.Body.String())
	}

	target := endpoint + "/" + platform + "/" + runtime + "/"
	call(http.MethodDelete, target+legacyID, admin, nil, 409)
	call(http.MethodDelete, target+releaseID, writer, nil, 403)
	call(http.MethodDelete, target+releaseID, user, nil, 403)
	call(http.MethodDelete, target+releaseID, admin, nil, 200)
	call(http.MethodGet, source, "", nil, 204)
	call(http.MethodGet, "/v1/mobile-ota/"+assetPath, "", nil, 200)
}
