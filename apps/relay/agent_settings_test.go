package relay

import (
	"encoding/json"
	"fmt"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAgentSettingsPermissionsPersistenceAndPush(t *testing.T) {
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
		r := httptest.NewRequest(method, "/v1/admin/agent-settings", strings.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		return w
	}
	if w := call("GET", token, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"threadLimit":20`) {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, test := range []struct {
		token  string
		status int
	}{{"", 401}, {userToken, 403}} {
		if w := call("PUT", test.token, `{"threadLimit":30}`); w.Code != test.status {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, body := range []string{`{}`, `{"threadLimit":0}`, `{"threadLimit":31}`, `{"threadLimit":1.5}`, `{"threadLimit":"30"}`, `{"threadLimit":null}`, `{"threadLimit":25,"other":true}`} {
		if w := call("PUT", token, body); w.Code != 400 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	peer := &Peer{s: server, queue: make(chan []byte, 8), done: make(chan struct{})}
	server.mu.Lock()
	server.agents["fixture"] = peer
	server.mu.Unlock()
	if w := call("PUT", token, `{"threadLimit":30}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var pushed M
	if json.Unmarshal(<-peer.queue, &pushed) != nil || pushed["type"] != "device.settings" || num(pushed["threadLimit"]) != 30 {
		t.Fatal(pushed)
	}
	server.mu.Lock()
	delete(server.agents, "fixture")
	server.mu.Unlock()
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
	if num(store.AgentSettings()["threadLimit"]) != 30 {
		t.Fatal("setting lost on restart")
	}
	if w := call("PUT", token, `{"threadLimit":1}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestExtendedThreadWireAndLegacyProjection(t *testing.T) {
	store, s, p, device := fixture(t)
	store.Q("UPDATE agent_settings SET thread_limit=30 WHERE id=1")
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	session := str(store.CreateSession(p.ID, device)["session"])
	header := http.Header{"Authorization": []string{"Bearer " + session}, "X-Device-Id": []string{device}}
	agent, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.URL, "http")+"/v1/ws/device", header)
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	if got := readMessage(t, agent); got["type"] != "device.welcome" || num(got["threadLimit"]) != 30 {
		t.Fatal(got)
	}
	snapshot := state(t, device)
	threads := M{}
	template := obj(obj(snapshot["threads"])["thread-test"])
	for i := 0; i < 21; i++ {
		thread := clone(template)
		id := fmt.Sprintf("thread-%02d", i)
		thread["id"] = id
		thread["updatedAt"] = i
		threads[id] = thread
	}
	snapshot["threads"] = threads
	agent.WriteJSON(M{"type": "device.snapshot", "snapshot": snapshot})
	eventually(t, func() bool { return len(obj(store.Snapshot(device)["threads"])) == 21 })
	client := func(extended bool) *websocket.Conn {
		suffix := ""
		if extended {
			suffix = "?syncThreads=30"
		}
		ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.URL, "http")+"/v1/ws/client"+suffix, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ws.Close() })
		ws.WriteJSON(M{"type": "client.authenticate", "ticket": store.Ticket(p)["ticket"]})
		readMessage(t, ws)
		ws.WriteJSON(M{"type": "client.subscribe", "deviceId": device})
		readMessage(t, ws)
		got := readMessage(t, ws)
		want := 20
		if extended {
			want = 21
		}
		if got["type"] != "device.snapshot" || len(obj(obj(got["snapshot"])["threads"])) != want {
			t.Fatal("bad client snapshot", got["type"])
		}
		readMessage(t, ws)
		readMessage(t, ws)
		return ws
	}
	legacy, modern := client(false), client(true)
	extra := clone(template)
	extra["id"] = "new-thread"
	extra["title"] = "中文 😀"
	extra["updatedAt"] = 100
	event := M{"protocolVersion": 1, "deviceId": device, "epoch": snapshot["epoch"], "seq": 1, "timestamp": now(), "change": M{"type": "thread.updated", "thread": extra}}
	agent.WriteJSON(M{"type": "device.event", "event": event})
	modernEvent := readMessage(t, modern)
	if modernEvent["type"] != "device.event" {
		t.Fatal(modernEvent)
	}
	oldSnapshot := readMessage(t, legacy)
	oldThreads := obj(obj(oldSnapshot["snapshot"])["threads"])
	if oldSnapshot["type"] != "device.snapshot" || len(oldThreads) != 20 || oldThreads["new-thread"] == nil || num(obj(oldSnapshot["snapshot"])["lastSeq"]) != 1 {
		t.Fatal("legacy projection lost changed thread")
	}
	// Runtime-only events have no thread field, and projected clients still advance.
	event["seq"] = 2
	event["change"] = M{"type": "runtime.status", "connected": true}
	agent.WriteJSON(M{"type": "device.event", "event": event})
	if readMessage(t, modern)["type"] != "device.event" {
		t.Fatal("modern runtime event")
	}
	if got := readMessage(t, legacy); num(obj(got["snapshot"])["lastSeq"]) != 2 {
		t.Fatal("legacy sequence lost", got)
	}
	for _, extended := range []bool{false, true} {
		path := "/v1/devices/" + device + "/snapshot"
		want := 20
		if extended {
			path += "?syncThreads=30"
			want = 22
		}
		req := httptest.NewRequest("GET", path, nil)
		token := str(store.CreateSession(p.ID, "")["session"])
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, req)
		var result M
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(obj(obj(result["snapshot"])["threads"])) != want {
			t.Fatal("bad REST preview projection", w.Code, w.Body.String())
		}
	}
	// Cross back below 20 without leaving the old client with a missing preview.
	for i := 0; i < 2; i++ {
		event["seq"] = 3 + i
		event["change"] = M{"type": "thread.removed", "threadId": fmt.Sprintf("thread-%02d", i)}
		agent.WriteJSON(M{"type": "device.event", "event": event})
		readMessage(t, modern)
		if got := readMessage(t, legacy); got["type"] != "device.snapshot" {
			t.Fatal(got)
		}
	}
	event["seq"] = 5
	event["change"] = M{"type": "runtime.status", "connected": true}
	agent.WriteJSON(M{"type": "device.event", "event": event})
	readMessage(t, modern)
	if readMessage(t, legacy)["type"] != "device.event" {
		t.Fatal("legacy never resumed incremental events")
	}
	if legacyReplaySafe(snapshot, []M{event}) {
		t.Fatal("oversized state must use projected snapshot")
	}
	agent.SetWriteDeadline(time.Now().Add(time.Second))
}
