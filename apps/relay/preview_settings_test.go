package relay

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPreviewSettingsPermissionsValidationAndPersistence(t *testing.T) {
	directory := t.TempDir()
	store, err := Open("", directory)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(store, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { server.Close(); store.Close() }()
	admin := store.CreateUser("admin", "test-password-12345", "admin")
	user := store.CreateUser("reader", "test-password-12345", "user")
	token := str(store.CreateSession(str(admin["id"]), "")["session"])
	userToken := str(store.CreateSession(str(user["id"]), "")["session"])
	call := func(method, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/v1/admin/preview-settings", strings.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		return w
	}
	if w := call("GET", token, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"maxPreviewMiB":32`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, method := range []string{"GET", "PUT"} {
		for _, test := range []struct {
			token  string
			status int
		}{{"", 401}, {userToken, 403}} {
			if w := call(method, test.token, `{"maxPreviewMiB":16}`); w.Code != test.status {
				t.Fatal(method, w.Code, w.Body.String())
			}
		}
	}
	for _, body := range []string{`{}`, `{"maxPreviewMiB":0}`, `{"maxPreviewMiB":129}`, `{"maxPreviewMiB":1.5}`, `{"maxPreviewMiB":"32"}`, `{"maxPreviewMiB":null}`, `{"maxPreviewMiB":16,"other":true}`} {
		if w := call("PUT", token, body); w.Code != 400 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	for _, body := range []string{`{"maxPreviewMiB":128}`, `{"maxPreviewMiB":1}`, `{"maxPreviewMiB":16}`} {
		if w := call("PUT", token, body); w.Code != 200 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	server.Close()
	store.Close()
	store, err = Open("", directory)
	if err != nil {
		t.Fatal(err)
	}
	server, err = New(store, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if num(store.PreviewSettings()["maxPreviewMiB"]) != 16 {
		t.Fatal("setting lost on restart")
	}
	if w := call("GET", token, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"maxPreviewMiB":16`) {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestFilePreviewUsesCurrentServerSettingAndPreservesDownloads(t *testing.T) {
	store, s, _, _ := fixture(t)
	source := M{"name": "page.html", "size": int64(3 * 1024 * 1024), "previewMaxBytes": int64(512 * 1024 * 1024)}
	if num(s.previewFileInfo(source)["previewMaxBytes"]) != 32*1024*1024 {
		t.Fatal("agent-controlled preview limit")
	}
	s.checkFilePreview(httptest.NewRequest("GET", "/content?preview=1", nil), source)
	store.Q("UPDATE preview_settings SET max_preview_mib=1 WHERE id=1")
	if num(s.previewFileInfo(source)["previewMaxBytes"]) != 1024*1024 {
		t.Fatal("stale metadata limit")
	}
	expectFault(t, "file-preview-too-large", func() { s.checkFilePreview(httptest.NewRequest("GET", "/content?preview=1", nil), source) })
	s.checkFilePreview(httptest.NewRequest("GET", "/content", nil), source)
	s.checkFilePreview(httptest.NewRequest("GET", "/content?preview=1", nil), M{"size": int64(1024 * 1024)})
}
