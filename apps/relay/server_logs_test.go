package relay

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgconn"
)

func logEntries(l *serverLogs) []serverLogEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]serverLogEntry{}, l.entries...)
}

func TestServerLogsAdminAccessFiltersAndPaging(t *testing.T) {
	store, s, p, device := fixture(t)
	admin := str(store.CreateUser("log-admin", "test-password-12345", "admin")["id"])
	token := str(store.CreateSession(admin, "")["session"])
	request := func(token, query string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/v1/admin/system/logs"+query, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	for _, test := range []struct {
		token  string
		status int
	}{{"", 401}, {sessionToken(store, p), 403}, {str(store.CreateSession(p.ID, device)["session"]), 401}} {
		if w := request(test.token, ""); w.Code != test.status {
			t.Fatal(w.Code, test.status)
		}
	}
	for i := range 5 {
		s.logs.add(serverLogEntry{Level: "warn", Category: "protocol", Code: "invalid-message", logContext: logContext{DeviceID: device, Seq: int64(i)}})
	}
	s.logs.add(serverLogEntry{Level: "error", Category: "http", Code: "server-error"})
	w := request(token, "?level=warn&category=protocol&code=invalid&deviceId="+device+"&limit=2")
	var page struct {
		Entries    []serverLogEntry
		NextCursor int64
		Retained   int
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Entries) != 2 || page.Entries[0].Seq != 4 || page.NextCursor != page.Entries[1].ID || page.Retained != 6 {
		t.Fatal(w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), token) {
		t.Fatal("cache or credential leak")
	}
	w = request(token, fmt.Sprintf("?level=warn&limit=2&before=%d", page.NextCursor))
	json.Unmarshal(w.Body.Bytes(), &page)
	if len(page.Entries) != 2 || page.Entries[0].Seq != 2 {
		t.Fatal(w.Body)
	}
	for _, query := range []string{"?level=debug", "?category=unknown", "?before=-1", "?before=oops", "?limit=0", "?limit=201", "?code=" + strings.Repeat("x", 101)} {
		if w := request(token, query); w.Code != 400 {
			t.Fatal(query, w.Body)
		}
	}
}

func TestServerLogsRotationReloadConcurrencyAndFallback(t *testing.T) {
	directory := t.TempDir()
	l := newServerLogs(directory)
	l.maxBytes = 1200
	for range 50 {
		l.add(serverLogEntry{Level: "warn", Category: "connection", Code: "transport-error"})
	}
	for _, name := range []string{"server-logs.jsonl", "server-logs.jsonl.1"} {
		info, e := os.Stat(filepath.Join(directory, name))
		if e != nil || info.Size() > 1200 {
			t.Fatal(info, e)
		}
	}
	reloaded := newServerLogs(directory)
	entries := logEntries(reloaded)
	if len(entries) < 2 || entries[len(entries)-1].ID != 50 || !reloaded.persistent {
		t.Fatal("restart lost recent logs")
	}
	reloaded.add(serverLogEntry{Level: "info", Category: "connection", Code: "device-connected"})
	if reloaded.serial != 51 {
		t.Fatal("cursor reused after restart")
	}
	memory := newServerLogs("")
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for range 600 {
				memory.add(serverLogEntry{Level: "error", Category: "background", Code: "background-operation-failed"})
			}
		})
	}
	wg.Wait()
	entries = logEntries(memory)
	if len(entries) != serverLogCapacity || entries[0].ID != 401 || entries[len(entries)-1].ID != 2400 {
		t.Fatal("retention or concurrent IDs")
	}
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	os.WriteFile(blocked, []byte("file"), 0600)
	failed := newServerLogs(blocked)
	failed.add(serverLogEntry{Level: "error", Category: "http", Code: "server-error"})
	if failed.persistent || len(logEntries(failed)) != 1 {
		t.Fatal("disk failure must retain memory diagnostics")
	}
	oversized := t.TempDir()
	os.WriteFile(filepath.Join(oversized, "server-logs.jsonl"), []byte(strings.Repeat("x", serverLogFileBytes+1)), 0600)
	repaired := newServerLogs(oversized)
	repaired.add(serverLogEntry{Code: "device-connected"})
	info, _ := os.Stat(repaired.path)
	if info.Size() > serverLogFileBytes {
		t.Fatal("oversized old file kept growing")
	}
}

func TestServerLogsRejectedDeviceMessageAndClose(t *testing.T) {
	store, s, p, device := fixture(t)
	s.logs = newServerLogs(t.TempDir())
	token := str(store.CreateSession(p.ID, device)["session"])
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	ws, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.URL, "http")+"/v1/ws/device", http.Header{"Authorization": {"Bearer " + token}, "X-Device-Id": {device}})
	if e != nil {
		t.Fatal(e)
	}
	defer ws.Close()
	readMessage(t, ws)
	snapshot := state(t, device)
	thread := obj(obj(snapshot["threads"])["thread-test"])
	thread["id"] = "private-record-token"
	thread["title"] = 777
	snapshot["threads"] = M{"private-record-token": thread}
	ws.WriteJSON(M{"type": "device.snapshot", "snapshot": snapshot})
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, e = ws.ReadMessage()
	if !websocket.IsCloseError(e, 1008) {
		t.Fatal(e)
	}
	entries := logEntries(s.logs)
	var rejection *serverLogEntry
	for i := range entries {
		if entries[i].Category == "protocol" && entries[i].Code == "invalid-message" {
			rejection = &entries[i]
		}
	}
	if rejection == nil || rejection.DeviceID != device || rejection.ConnectionID == "" || rejection.MessageType != "device.snapshot" || rejection.MessageBytes == 0 {
		t.Fatal(entries)
	}
	if !strings.Contains(js(rejection.Issues), "/snapshot/threads/*/title") {
		t.Fatal("missing exact invalid field", js(rejection.Issues))
	}
	closeCount := 0
	for _, entry := range entries {
		if entry.ConnectionID == rejection.ConnectionID && entry.CloseCode == 1008 {
			closeCount++
		}
	}
	if closeCount != 1 {
		t.Fatal("close must log once", entries)
	}
	all := js(entries)
	for _, secret := range []string{token, "private-record-token", "/test", "test-pc"} {
		if strings.Contains(all, secret) {
			t.Fatal("private data in structured log", secret)
		}
	}
	bytes, _ := os.ReadFile(s.logs.path)
	if strings.Contains(string(bytes), "private-record-token") {
		t.Fatal("private record key persisted")
	}
}

func TestServerLogsProtocolConstraintsAndMalformedTypes(t *testing.T) {
	_, s, _, device := fixture(t)
	for _, kind := range []any{M{"secret": "value"}, []any{"secret"}, nil} {
		if len(s.protocolIssues(M{"type": kind})) == 0 {
			t.Fatal("missing failure")
		}
	}
	longSnapshot := state(t, device)
	longSnapshot["hostname"] = strings.Repeat("🙂", 200)
	longMessage := M{"type": "device.snapshot", "snapshot": longSnapshot}
	expectFault(t, "invalid-message", func() { s.Validate("device", longMessage) })
	if issues := s.protocolIssues(longMessage); len(issues) != 1 || issues[0].Path != "/snapshot/hostname" || !strings.HasPrefix(issues[0].Rule, "maxLength:") {
		t.Fatal("missing UTF-16 length reason", issues)
	}
	snapshot := state(t, device)
	threads := obj(snapshot["threads"])
	for i := range 21 {
		thread := clone(obj(threads["thread-test"]))
		thread["id"] = fmt.Sprint(i)
		threads[fmt.Sprint(i)] = thread
	}
	m := M{"type": "device.snapshot", "snapshot": snapshot}
	expectFault(t, "invalid-message", func() { s.Validate("device", m) })
	issues := s.protocolIssues(m)
	if len(issues) != 1 || issues[0].Path != "/snapshot/threads" || issues[0].Rule != "maxProperties:20" {
		t.Fatal(issues)
	}
	m = M{"type": "device.event", "event": M{"change": M{"type": "thread.updated", "thread": M{"id": "private", "turns": []any{}, "tokenUsage": M{"inputTokens": 1, "cachedInputTokens": 2, "outputTokens": 1, "reasoningOutputTokens": 0}}}}}
	expectFault(t, "invalid-message", func() { s.Validate("device", m) })
	issues = s.protocolIssues(m)
	if issues[0].Rule != "tokenCountsWithinTotals" {
		t.Fatal(issues)
	}
}

func TestServerLogsDelayedCloseOriginAndHeartbeat(t *testing.T) {
	_, s, _, _ := fixture(t)
	makePeer := func() *Peer {
		return &Peer{s: s, done: make(chan struct{}), source: "device", connectionID: uuid(), connectedAt: now() - 11*60*1000}
	}
	p := makePeer()
	p.readClosed(&websocket.CloseError{Code: 1008, Text: "private-server-message"})
	p.Close(1001, "connection-closed")
	q := makePeer()
	q.Close(1001, "heartbeat-timeout")
	entries := logEntries(s.logs)
	if len(entries) != 2 || entries[0].Initiator != "peer" || entries[0].Code != "peer-closed" || entries[0].DurationMS < 11*60*1000 || entries[1].Initiator != "server" || entries[1].Level != "warn" {
		t.Fatal(entries)
	}
	if strings.Contains(js(entries), "private-server-message") {
		t.Fatal("remote reason leaked")
	}
}

func TestServerLogsHTTPBackgroundAndSQLStateSanitization(t *testing.T) {
	_, s, _, _ := fixture(t)
	s.mux.HandleFunc("GET /test-diagnostic/{id}", func(http.ResponseWriter, *http.Request) {
		panic(&pgconn.PgError{Code: "23505", Message: "password=private-error"})
	})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/test-diagnostic/private-path?token=private-query", nil))
	s.safe(func() { panic(errors.New("private-background-token")) })
	s.Handler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/ws/device", nil))
	entries := logEntries(s.logs)
	if len(entries) != 3 || entries[0].HTTPStatus != 500 || entries[0].SQLState != "23505" || entries[0].Route != "GET /test-diagnostic/{id}" || entries[1].Category != "background" || entries[2].Code != "unauthorized" {
		t.Fatal(entries)
	}
	if strings.Contains(js(entries), "private-") {
		t.Fatal("exception, path, or query leaked")
	}
	s.mux.HandleFunc("GET /test-peer-error", func(http.ResponseWriter, *http.Request) { fail(502, "private-rejected-token") })
	s.Handler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/test-peer-error", nil))
	entries = logEntries(s.logs)
	if entries[3].Code != "server-error" || entries[3].HTTPStatus != 502 {
		t.Fatal("untrusted HTTP fault code persisted")
	}
}

func TestServerLogsReservedCloseCodeAndUnknownPeerReason(t *testing.T) {
	_, s, _, _ := fixture(t)
	var peer *Peer
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer = s.peer(w, r, nil)
		peer.Close(1006, "write-error")
	}))
	defer h.Close()
	ws, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.URL, "http"), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(time.Second))
	_, _, e = ws.ReadMessage()
	if !websocket.IsCloseError(e, 1006) {
		t.Fatal("reserved code sent as invalid close frame", e)
	}
	if closeReason("secret-peer-payload") != "peer-closed" {
		t.Fatal("untrusted remote close text retained")
	}
	entries := logEntries(s.logs)
	if len(entries) != 1 || entries[0].CloseCode != 1006 || entries[0].Code != "write-error" {
		t.Fatal(entries)
	}
}
