package relay

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func (f *publishingFixture) key(scopes []any) M {
	f.t.Helper()
	status, result := f.call("POST", "/v1/admin/publishing/keys", f.admin, M{"name": "Local publisher", "scopes": scopes, "expiresInDays": 30})
	if status != 200 {
		f.t.Fatal(status, result)
	}
	return result
}

func testPublishingKey(t *testing.T, database string) {
	f := newPublishingFixture(t, database)
	key := f.key([]any{"clients:read", "clients:write"})
	code, id := str(key["code"]), str(key["grantId"])
	if !strings.HasPrefix(code, "cdxp_k_") || len(code) != 50 || num(key["expiresAt"]) < now()+29*86400000 {
		t.Fatal(key)
	}
	token := f.store.One("SELECT * FROM publish_tokens WHERE grant_id=$1", id)
	if token["hash"] != hash(code) || token["kind"] != "key" || strings.Contains(js(token), code) {
		t.Fatal("plaintext persisted", token)
	}
	for i := 0; i < 2; i++ {
		if status, me := f.call("GET", "/v1/publish/me", code, nil); status != 200 || me["grantId"] != id || strings.Contains(js(me), code) {
			t.Fatal(status, me)
		}
	}
	if status, list := f.call("GET", "/v1/admin/publishing", f.admin, nil); status != 200 || strings.Contains(js(list), code) || !strings.Contains(js(list), `"credential_type":"key"`) {
		t.Fatal(status, list)
	}
	// The grant is reusable but cannot become an administrator or mint more keys.
	for _, path := range []string{"/v1/me", "/v1/admin/accounts", "/v1/admin/publishing", "/v1/admin/system/version"} {
		if status, _ := f.call("GET", path, code, nil); status != 403 {
			t.Fatal(path, status)
		}
	}
	if status, _ := f.call("POST", "/v1/admin/publishing/keys", code, M{}); status != 403 {
		t.Fatal(status)
	}
	if status, _ := f.call("POST", "/v1/publish/token", "", M{"grantType": "refresh_token", "refreshToken": code}); status != 400 {
		t.Fatal(status)
	}
	if status, _ := f.call("DELETE", "/v1/admin/publishing/"+id, f.admin, nil); status != 200 {
		t.Fatal(status)
	}
	if status, _ := f.call("GET", "/v1/publish/me", code, nil); status != 401 {
		t.Fatal("revoked key accepted", status)
	}
	key = f.key([]any{"server:read"})
	f.store.Q("UPDATE publish_grants SET expires_at=$2 WHERE id=$1", key["grantId"], now()-1)
	if status, _ := f.call("GET", "/v1/publish/me", str(key["code"]), nil); status != 401 {
		t.Fatal("expired grant", status)
	}
	key = f.key([]any{"server:read"})
	f.store.Q("UPDATE publish_tokens SET expires_at=$2 WHERE grant_id=$1", key["grantId"], now()-1)
	if status, _ := f.call("GET", "/v1/publish/me", str(key["code"]), nil); status != 401 {
		t.Fatal("expired key", status)
	}
	key = f.key([]any{"server:read"})
	admin := f.store.One("SELECT id FROM users WHERE name='publisher-admin'")
	if status, _ := f.call("PUT", "/v1/admin/accounts/"+str(admin["id"])+"/password", f.admin, M{"password": "new-test-password-456"}); status != 200 {
		t.Fatal(status)
	}
	if status, _ := f.call("GET", "/v1/publish/me", str(key["code"]), nil); status != 401 {
		t.Fatal("reset did not revoke key", status)
	}
}
func TestPublishingKeyLifecycle(t *testing.T) { testPublishingKey(t, "") }
func TestPostgresPublishingKeyLifecycle(t *testing.T) {
	raw, _ := postgresFixture(t)
	testPublishingKey(t, raw)
}

func TestPublishingKeyHTTPAndValidation(t *testing.T) {
	f := newPublishingFixture(t, "")
	body := M{"name": "HTTP publisher", "scopes": []any{"clients:read", "clients:write"}, "expiresInDays": 90}
	r := httptest.NewRequest("POST", "http://public.test/v1/admin/publishing/keys", strings.NewReader(js(body)))
	r.Header.Set("Authorization", "Bearer "+f.admin)
	r.Header.Set("Origin", "http://public.test")
	w := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body.String())
	}
	var key M
	json.Unmarshal(w.Body.Bytes(), &key)
	code := str(key["code"])
	// Upload an actual fixture over HTTP through the existing scoped update route.
	data := installerFixture(1024)
	r = httptest.NewRequest("PUT", "http://public.test/v1/admin/client-releases/agent-windows-x64-setup?name=Agent-1.0.0.exe&version=1.0.0&sha256="+hash(string(data)), bytes.NewReader(data))
	r.Header.Set("Authorization", "Bearer "+code)
	w = httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	if w.Code != 200 || f.server.clientReleases.current("agent-windows-x64-setup") == nil {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, credential := range []string{"", f.user} {
		if status, _ := f.call("POST", "/v1/admin/publishing/keys", credential, body); status != 401 && status != 403 {
			t.Fatal(status)
		}
	}
	for _, invalid := range []M{
		{"name": "", "scopes": []any{"server:read"}},
		{"name": "PC", "scopes": []any{}},
		{"name": "PC", "scopes": []any{"admin"}},
		{"name": "PC", "scopes": []any{"server:read", "server:read"}},
		{"name": "PC", "scopes": []any{"server:read"}, "expiresInDays": 0},
		{"name": "PC", "scopes": []any{"server:read"}, "expiresInDays": 91},
		{"name": "PC", "scopes": []any{"server:read"}, "expiresInDays": 1.5},
		{"name": "PC", "scopes": []any{"server:read"}, "expiresInDays": "30"},
	} {
		if status, _ := f.call("POST", "/v1/admin/publishing/keys", f.admin, invalid); status != 400 {
			t.Fatal(status, invalid)
		}
	}
	r = httptest.NewRequest("POST", "http://public.test/v1/admin/publishing/keys", strings.NewReader(js(body)))
	r.Header.Set("Authorization", "Bearer "+f.admin)
	r.Header.Set("Origin", "http://evil.test")
	w = httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross origin key creation", w.Code)
	}
}
