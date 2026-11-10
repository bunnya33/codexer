package relay

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type publishingFixture struct {
	t           *testing.T
	store       *Store
	server      *Server
	admin, user string
}

func newPublishingFixture(t *testing.T, database string) *publishingFixture {
	t.Helper()
	dir := t.TempDir()
	store, e := Open(database, dir)
	if e != nil {
		t.Fatal(e)
	}
	admin := store.CreateUser("publisher-admin", "test-password-12345", "admin")
	user := store.CreateUser("publisher-user", "test-password-12345", "user")
	server, e := New(store, Options{Version: "0.3.54", DataDir: dir, UpdateDir: dir})
	if e != nil {
		store.Close()
		t.Fatal(e)
	}
	t.Cleanup(func() { server.Close(); store.Close() })
	return &publishingFixture{t, store, server, str(store.CreateSession(str(admin["id"]), "")["session"]), str(store.CreateSession(str(user["id"]), "")["session"])}
}
func (f *publishingFixture) call(method, path, credential string, value any) (int, M) {
	f.t.Helper()
	var reader io.Reader
	if value != nil {
		reader = strings.NewReader(js(value))
	}
	r := httptest.NewRequest(method, "https://codexer.test"+path, reader)
	if credential != "" {
		r.Header.Set("Authorization", "Bearer "+credential)
	}
	w := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	var result M
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	return w.Code, result
}
func (f *publishingFixture) begin(scopes []any) (M, string) {
	f.t.Helper()
	verifier := token(32)
	digest := sha256.Sum256([]byte(verifier))
	status, result := f.call("POST", "/v1/publish/authorize", "", M{"name": "Office PC", "scopes": scopes, "challenge": base64.RawURLEncoding.EncodeToString(digest[:])})
	if status != 200 {
		f.t.Fatal(status, result)
	}
	return result, verifier
}
func (f *publishingFixture) exchange(request M, verifier string) (int, M) {
	f.store.Q("UPDATE publish_requests SET last_poll_at=0 WHERE device_hash=$1", hash(str(request["deviceCode"])))
	return f.call("POST", "/v1/publish/token", "", M{"grantType": "device_code", "deviceCode": request["deviceCode"], "verifier": verifier})
}
func (f *publishingFixture) grant(scopes []any) M {
	f.t.Helper()
	request, verifier := f.begin(scopes)
	if status, result := f.call("POST", "/v1/admin/publishing/approve", f.admin, M{"code": request["userCode"], "approve": true}); status != 200 {
		f.t.Fatal(status, result)
	}
	status, result := f.exchange(request, verifier)
	if status != 200 {
		f.t.Fatal(status, result)
	}
	return result
}
func testPublishingLifecycle(t *testing.T, database string) {
	f := newPublishingFixture(t, database)
	request, verifier := f.begin([]any{"clients:read", "clients:write"})
	if status, _ := f.call("GET", "/v1/admin/publishing/request?code="+str(request["userCode"]), f.user, nil); status != 403 {
		t.Fatal(status)
	}
	if status, value := f.exchange(request, verifier); status != 400 || value["error"] != "authorization-pending" {
		t.Fatal(status, value)
	}
	if status, value := f.call("GET", "/v1/admin/publishing/request?code="+str(request["userCode"]), f.admin, nil); status != 200 || value["name"] != "Office PC" || value["deviceCode"] != nil {
		t.Fatal(status, value)
	}
	if status, value := f.call("POST", "/v1/admin/publishing/approve", f.admin, M{"code": request["userCode"], "approve": true}); status != 200 {
		t.Fatal(status, value)
	}
	if status, _ := f.exchange(request, token(32)); status != 400 {
		t.Fatal(status)
	}
	status, credential := f.exchange(request, verifier)
	if status != 200 {
		t.Fatal(status, credential)
	}
	access, refresh := str(credential["accessToken"]), str(credential["refreshToken"])
	if status, _ := f.exchange(request, verifier); status != 400 {
		t.Fatal("reused device code", status)
	}
	for _, path := range []string{"/v1/me", "/v1/admin/accounts", "/v1/admin/publishing", "/v1/admin/system/version"} {
		if status, _ := f.call("GET", path, access, nil); status != 403 {
			t.Fatal("escaped scope", path, status)
		}
	}
	if status, _ := f.call("GET", "/v1/admin/client-releases", access, nil); status != 200 {
		t.Fatal(status)
	}
	if status, _ := f.call("GET", "/v1/publish/me", access, nil); status != 200 {
		t.Fatal(status)
	}
	// Bearer material is never persisted in plaintext.
	for _, row := range f.store.Q("SELECT * FROM publish_tokens") {
		if strings.Contains(js(row), access) || strings.Contains(js(row), refresh) {
			t.Fatal("plaintext credential")
		}
	}
	status, next := f.call("POST", "/v1/publish/token", "", M{"grantType": "refresh_token", "refreshToken": refresh})
	if status != 200 || next["refreshToken"] == refresh {
		t.Fatal(status, next)
	}
	status, reuse := f.call("POST", "/v1/publish/token", "", M{"grantType": "refresh_token", "refreshToken": refresh})
	if status != 400 || reuse["error"] != "refresh-reused-reauthorize" {
		t.Fatal(status, reuse)
	}
	if status, _ := f.call("GET", "/v1/publish/me", str(next["accessToken"]), nil); status != 401 {
		t.Fatal("refresh reuse did not revoke family", status)
	}
	grant := f.grant([]any{"clients:read"})
	if status, _ := f.call("DELETE", "/v1/admin/publishing/"+str(grant["grantId"]), f.admin, nil); status != 200 {
		t.Fatal(status)
	}
	if status, _ := f.call("GET", "/v1/admin/client-releases", str(grant["accessToken"]), nil); status != 401 {
		t.Fatal(status)
	}
	grant = f.grant([]any{"clients:read"})
	adminID := f.store.Session(f.admin, "").ID
	if !f.store.ResetUser(adminID, "new-password-12345", "admin") {
		t.Fatal("reset")
	}
	if status, _ := f.call("GET", "/v1/publish/me", str(grant["accessToken"]), nil); status != 401 {
		t.Fatal("password reset did not revoke grant", status)
	}
	if num(f.store.One("SELECT COUNT(*) AS n FROM publish_audit")["n"]) < 5 {
		t.Fatal("audit missing")
	}
}
func TestPublishingLifecycle(t *testing.T) { testPublishingLifecycle(t, "") }
func TestPostgresPublishingLifecycle(t *testing.T) {
	raw, _ := postgresFixture(t)
	testPublishingLifecycle(t, raw)
}

func TestPublishingDenyExpireAndConcurrentConsume(t *testing.T) {
	f := newPublishingFixture(t, "")
	request, verifier := f.begin([]any{"server:read"})
	f.call("POST", "/v1/admin/publishing/approve", f.admin, M{"code": request["userCode"], "approve": false})
	if status, _ := f.exchange(request, verifier); status != 400 {
		t.Fatal(status)
	}
	request, verifier = f.begin([]any{"server:read"})
	f.store.Q("UPDATE publish_requests SET expires_at=$1", now()-1)
	if status, _ := f.exchange(request, verifier); status != 400 {
		t.Fatal(status)
	}
	request, verifier = f.begin([]any{"server:read"})
	f.call("POST", "/v1/admin/publishing/approve", f.admin, M{"code": request["userCode"], "approve": true})
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, _ := f.call("POST", "/v1/publish/token", "", M{"grantType": "device_code", "deviceCode": request["deviceCode"], "verifier": verifier})
			codes <- status
		}()
	}
	wg.Wait()
	close(codes)
	successes := 0
	for code := range codes {
		if code == 200 {
			successes++
		}
	}
	if successes != 1 {
		t.Fatal("one-time exchange", successes)
	}
	grant := f.grant([]any{"clients:read"})
	f.store.Q("UPDATE publish_tokens SET expires_at=$1 WHERE hash=$2", now()-1, hash(str(grant["accessToken"])))
	if status, _ := f.call("GET", "/v1/publish/me", str(grant["accessToken"]), nil); status != 401 {
		t.Fatal(status)
	}
	f.store.Q("UPDATE publish_grants SET expires_at=$1", now()-1)
	if status, _ := f.call("POST", "/v1/publish/token", "", M{"grantType": "refresh_token", "refreshToken": grant["refreshToken"]}); status != 400 {
		t.Fatal(status)
	}
}

func TestPublishingTransportAndOrigin(t *testing.T) {
	f := newPublishingFixture(t, "")
	check := func(target, remote, forward, origin string, tlsOn bool) int {
		r := httptest.NewRequest("POST", target, strings.NewReader(`{"name":"PC","scopes":["server:read"],"challenge":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`))
		r.RemoteAddr = remote
		if !tlsOn {
			r.TLS = nil
		} else {
			r.TLS = &tls.ConnectionState{}
		}
		r.Header.Set("X-Forwarded-Proto", forward)
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		f.server.Handler().ServeHTTP(w, r)
		return w.Code
	}
	if c := check("http://public.test/v1/publish/authorize", "198.51.100.3:5000", "https", "", false); c != 403 {
		t.Fatal(c)
	}
	if c := check("http://localhost/v1/publish/authorize", "198.51.100.3:5000", "", "", false); c != 403 {
		t.Fatal("rebound localhost", c)
	}
	if c := check("http://127.0.0.1/v1/publish/authorize", "127.0.0.1:5000", "", "", false); c != 200 {
		t.Fatal(c)
	}
	if c := check("https://public.test/v1/publish/authorize", "198.51.100.3:5000", "", "https://evil.test", true); c != 403 {
		t.Fatal(c)
	}
	f.server.Options.PublicURL = "https://public.test"
	f.server.Options.Origins = []string{"https://public.test"}
	if c := check("http://public.test/v1/publish/authorize", "127.0.0.1:5000", "https", "https://public.test", false); c != 200 {
		t.Fatal("trusted TLS proxy", c)
	}
	if c := check("http://public.test/v1/publish/authorize", "198.51.100.3:5000", "https", "", false); c != 403 {
		t.Fatal("untrusted proxy", c)
	}
	f.server.Options.TrustedProxies = []string{"198.51.100.3/32"}
	if c := check("http://public.test/v1/publish/authorize", "198.51.100.3:5000", "https", "https://public.test", false); c != 200 {
		t.Fatal("configured proxy", c)
	}
}

type publishingBlockedReader struct {
	data             []byte
	entered, release chan struct{}
	once             sync.Once
}

func (b *publishingBlockedReader) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered); <-b.release })
	if len(b.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b.data)
	b.data = b.data[n:]
	return n, nil
}
func TestPublishingUploadRevocationAndDigest(t *testing.T) {
	f := newPublishingFixture(t, "")
	grant := f.grant([]any{"clients:read", "clients:write"})
	access := str(grant["accessToken"])
	data := installerFixture(1024)
	reader := &publishingBlockedReader{data, make(chan struct{}), make(chan struct{}), sync.Once{}}
	r := httptest.NewRequest("PUT", "https://codexer.test/v1/admin/client-releases/agent-windows-x64-setup?name=Agent-1.0.0.exe&version=1.0.0", reader)
	r.ContentLength = int64(len(data))
	r.Header.Set("Authorization", "Bearer "+access)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); f.server.Handler().ServeHTTP(w, r) }()
	<-reader.entered
	if status, value := f.call("DELETE", "/v1/admin/publishing/"+str(grant["grantId"]), f.admin, nil); status != 200 {
		t.Fatal(status, value)
	}
	close(reader.release)
	<-done
	if w.Code != 401 {
		t.Fatal(w.Code, w.Body.String())
	}
	if f.server.clientReleases.current("agent-windows-x64-setup") != nil {
		t.Fatal("revoked upload published")
	}
	grant = f.grant([]any{"clients:write"})
	r = httptest.NewRequest("PUT", "https://codexer.test/v1/admin/client-releases/agent-windows-x64-setup?name=Agent-1.0.0.exe&version=1.0.0&sha256="+strings.Repeat("0", 64), bytes.NewReader(data))
	r.Header.Set("Authorization", "Bearer "+str(grant["accessToken"]))
	w = httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "checksum-mismatch") {
		t.Fatal(w.Code, w.Body.String())
	}
	if f.server.clientReleases.current("agent-windows-x64-setup") != nil {
		t.Fatal("corrupt upload published")
	}
	for _, version := range []string{"1.0.1", "1.0.0"} {
		r = httptest.NewRequest("PUT", "https://codexer.test/v1/admin/client-releases/agent-windows-x64-setup?name=Agent-"+version+".exe&version="+version, bytes.NewReader(data))
		r.Header.Set("Authorization", "Bearer "+str(grant["accessToken"]))
		w = httptest.NewRecorder()
		f.server.Handler().ServeHTTP(w, r)
		want := 200
		if version == "1.0.0" {
			want = 409
		}
		if w.Code != want {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if f.server.clientReleases.current("agent-windows-x64-setup").Version != "1.0.1" {
		t.Fatal("publisher downgraded catalog")
	}
}
