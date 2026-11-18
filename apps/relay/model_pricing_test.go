package relay

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestModelPricingPermissionsPersistenceAndConditionalRead(t *testing.T) {
	dir := t.TempDir()
	open := func() (*Store, *Server) {
		store, err := Open("", dir)
		if err != nil {
			t.Fatal(err)
		}
		server, err := New(store, Options{})
		if err != nil {
			store.Close()
			t.Fatal(err)
		}
		return store, server
	}
	store, server := open()
	defer func() { server.Close(); store.Close() }()
	token := func(name, role string) string {
		user := store.CreateUser(name, "test-password-12345", role)
		return str(store.CreateSession(str(user["id"]), "")["session"])
	}
	admin, user := token("pricing-admin", "admin"), token("pricing-reader", "user")
	call := func(method, path, bearer, body string, status int) M {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: got %d, want %d: %s", method, path, w.Code, status, w.Body)
		}
		var value M
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	const path = "/v1/admin/model-pricing"
	const control = "/v1/devices?modelPricingRevision="
	call("GET", path, "", "", 401)
	call("GET", path, user, "", 403)
	call("PUT", path, user, "{}", 403)
	call("GET", control, "", "", 401)
	initial := call("GET", path, admin, "", 200)
	revision := str(initial["revision"])
	if !strings.HasPrefix(revision, "default-") || server.schemas["modelPricing"].Validate(initial) != nil {
		t.Fatal("invalid built-in catalog")
	}
	if str(obj(call("GET", control, user, "", 200)["modelPricing"])["revision"]) != revision {
		t.Fatal("initial catalog missing in the control response")
	}
	for _, endpoint := range []string{"/v1/devices", control + revision} {
		if _, ok := call("GET", endpoint, user, "", 200)["modelPricing"]; ok {
			t.Fatal("unchanged or unsolicited catalog sent", endpoint)
		}
	}
	request := func(models string) string {
		return `{"revision":"` + revision + `","catalog":{"version":1,"currency":"USD","unit":"perMillionTokens","asOf":"2026-11-18","source":null,"models":` + models + `}}`
	}
	const valid = `{"id":"gpt-6.2-sol","input":2,"cachedInput":null,"output":10}`
	for _, models := range []string{
		`[` + valid + `,` + valid + `]`,
		`[` + strings.Replace(valid, `"input":2`, `"input":-1`, 1) + `]`,
		`[` + strings.Replace(valid, `"cachedInput":null,`, "", 1) + `]`,
	} {
		call("PUT", path, admin, request(models), 400)
	}
	saved := call("PUT", path, admin, request("[]"), 200)
	savedRevision := str(saved["revision"])
	call("PUT", path, admin, request("["+valid+"]"), 409)
	server.Close()
	store.Close()
	store, server = open()
	updated := obj(call("GET", control+revision, user, "", 200)["modelPricing"])
	remoteRows, ok := obj(updated["catalog"])["models"].([]any)
	if str(updated["revision"]) != savedRevision || !ok || len(remoteRows) != 0 {
		t.Fatal("custom empty catalog should survive a restart and replace defaults")
	}
	if _, ok := call("GET", control+savedRevision, user, "", 200)["modelPricing"]; ok {
		t.Fatal("saved revision should skip the catalog")
	}
}
