package relay

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestHTTPPolicyCompatibility(t *testing.T) {
	store, s, p, _ := fixture(t)
	token := sessionToken(store, p)
	for _, path := range []string{"/v1/weixin", "/v1/weixin/missing"} {
		for _, auth := range []string{"", token} {
			req := httptest.NewRequest("GET", path, nil)
			if auth != "" {
				req.Header.Set("Authorization", "Bearer "+auth)
			}
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, req)
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("Weixin state and errors must not be cached")
			}
		}
	}
	for origin, status := range map[string]int{"": 403, "http://example.com": 204, "http://unknown.example": 403} {
		req := httptest.NewRequest("OPTIONS", "http://example.com/v1/me", nil)
		req.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("preflight %q: %d", origin, w.Code)
		}
	}
	req := httptest.NewRequest("POST", "/v1/auth/login", strings.NewReader(strings.Repeat("x", 8*1024*1024+1)))
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	var response M
	json.Unmarshal(w.Body.Bytes(), &response)
	if w.Code != 413 || response["error"] != "request-too-large" {
		t.Fatal("oversized request compatibility")
	}
}

func TestStorageFailureDiagnosticDoesNotLeak(t *testing.T) {
	for _, code := range []string{"22P05", "invalid-secret-code"} {
		err := fmt.Errorf("account-secret: %w", &pgconn.PgError{Code: code, Message: "SELECT private-payload"})
		event := storageFailureEvent(err)
		if event["type"] != "relay.diagnostic" || event["code"] != "relay-storage-error" {
			t.Fatal("storage diagnostic missing")
		}
		if code == "22P05" && event["sqlState"] != code || code != "22P05" && event["sqlState"] != nil {
			t.Fatal("SQLSTATE must be a safe five-character code")
		}
		text := js(event)
		if strings.Contains(text, "secret") || strings.Contains(text, "SELECT") || strings.Contains(text, "payload") {
			t.Fatal("diagnostic leaked exception details")
		}
	}
}

func TestBackgroundMaintenanceMetrics(t *testing.T) {
	store, e := Open("", t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	s, e := New(store, Options{HeartbeatInterval: 10 * time.Millisecond, CleanupInterval: 10 * time.Millisecond})
	if e != nil {
		store.Close()
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close(); store.Close() })
	eventually(t, func() bool {
		m := s.MetricSnapshot()
		lane := obj(obj(obj(m["scheduler"])["lanes"])["maintenance"])
		run := obj(obj(obj(m["queues"])["maintenance"])["run"])
		return num(lane["completed"]) >= 2 && num(run["count"]) >= 2 && num(obj(obj(m["cleanup"])["runs"])["count"]) > 0
	})
}
