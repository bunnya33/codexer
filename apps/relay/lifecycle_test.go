package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func readMessage(t *testing.T, ws *websocket.Conn) M {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	var m M
	if e := ws.ReadJSON(&m); e != nil {
		t.Fatal(e)
	}
	return m
}
func connectClient(t *testing.T, s *Server, store *Store, p *Principal) *websocket.Conn {
	t.Helper()
	h := httptest.NewServer(s.Handler())
	t.Cleanup(h.Close)
	ws, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.URL, "http")+"/v1/ws/client", nil)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { ws.Close() })
	ticket := store.Ticket(p)
	ws.WriteJSON(M{"type": "client.authenticate", "ticket": ticket["ticket"]})
	if readMessage(t, ws)["type"] != "client.authenticated" {
		t.Fatal("authentication")
	}
	return ws
}
func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
func TestTransportHeartbeatNeverRenewsBrowserSession(t *testing.T) {
	store, s, p, _ := fixture(t)
	ws := connectClient(t, s, store, p)
	before := store.One("SELECT expires_at,last_active_at FROM sessions WHERE hash=$1", p.Hash)
	ws.WriteControl(websocket.PongMessage, nil, time.Now().Add(time.Second))
	s.heartbeat()
	after := store.One("SELECT expires_at,last_active_at FROM sessions WHERE hash=$1", p.Hash)
	if js(before) != js(after) {
		t.Fatal("heartbeat renewed account activity")
	}
	store.Q("UPDATE sessions SET expires_at=$2 WHERE hash=$1", p.Hash, now()-1)
	s.heartbeat()
	ws.SetReadDeadline(time.Now().Add(time.Second))
	_, _, e := ws.ReadMessage()
	if !websocket.IsCloseError(e, 4003) {
		t.Fatalf("expired socket: %v", e)
	}
}
func TestSubscriptionLimitScopeAndClose(t *testing.T) {
	store, s, p, _ := fixture(t)
	ws := connectClient(t, s, store, p)
	for i := 0; i < 21; i++ {
		id := store.Register(p.ID, uuid(), fmt.Sprint(i), "darwin")
		store.SaveSnapshot(state(t, id))
		ws.WriteJSON(M{"type": "client.subscribe", "deviceId": id})
		m := readMessage(t, ws)
		if i == 20 {
			if m["type"] != "error" || m["code"] != "subscription-limit" {
				t.Fatal(m)
			}
			break
		}
		if m["type"] != "sync.begin" {
			t.Fatal(m)
		}
		for _, kind := range []string{"device.snapshot", "sync.ready", "device.presence"} {
			if readMessage(t, ws)["type"] != kind {
				t.Fatal("sync order")
			}
		}
	}
	if num(obj(s.MetricSnapshot()["connections"])["subscriptions"]) != 20 {
		t.Fatal("subscriptions")
	}
	ws.Close()
	eventually(t, func() bool { return num(obj(s.MetricSnapshot()["connections"])["subscriptions"]) == 0 })
}
func TestPreviewBackpressureAndRevocationAreNeverDropped(t *testing.T) {
	_, s, _, device := fixture(t)
	p := &Pending{ID: uuid(), Device: device, Kind: "preview", Reply: make(chan response, 1)}
	s.addPending(p, 128, 24)
	s.acceptPreview(device, M{"requestId": p.ID, "event": M{"type": "data"}})
	s.acceptPreview(device, M{"requestId": p.ID, "event": M{"type": "data"}})
	select {
	case e := <-p.Failure:
		if e.Error() != "preview-backpressure" {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("lost backpressure")
	}
	q := &Pending{ID: uuid(), Device: device, Kind: "preview", Reply: make(chan response, 1)}
	s.addPending(q, 128, 24)
	q.Reply <- response{Value: M{}}
	s.FailPending(device, "device-revoked")
	select {
	case e := <-q.Failure:
		if e.Error() != "device-revoked" {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("lost cancellation")
	}
}
func TestCleanupCapsRetriesAndKeepsPendingOutbox(t *testing.T) {
	store, _, p, device := fixture(t)
	store.Q("WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<10001) INSERT INTO tickets(hash,expires_at,owner_user_id,session_hash) SELECT CAST(v AS TEXT),1,$1,$2 FROM n", p.ID, p.Hash)
	binding := uuid()
	store.Q("INSERT INTO weixin_bindings(id,user_id,bot_id,peer_id,base_url,token,created_at) VALUES($1,$2,'b','p',$3,'secret',1)", binding, p.ID, weixinBase)
	store.Enqueue(binding, "pending", "completion", "done", device, "")
	store.Q("UPDATE weixin_outbox SET created_at=1")
	if !store.Cleanup(context.Background()) {
		t.Fatal("missing capped result")
	}
	if num(store.One("SELECT COUNT(*) AS total FROM tickets")["total"]) != 1 {
		t.Fatal("batch cap")
	}
	if store.Cleanup(context.Background()) {
		t.Fatal("incorrect cap")
	}
	if num(store.One("SELECT COUNT(*) AS total FROM tickets")["total"]) != 0 || store.One("SELECT id FROM weixin_outbox WHERE state='pending'") == nil {
		t.Fatal("cleanup retention")
	}
}
func TestCommandPersistenceDedupeExpiryAndRestart(t *testing.T) {
	store, s, _, device := fixture(t)
	snapshot := state(t, device)
	store.SaveSnapshot(snapshot)
	peer := &Peer{s: s, queue: make(chan []byte, 8), done: make(chan struct{})}
	s.mu.Lock()
	s.agents[device] = peer
	s.mu.Unlock()
	t.Cleanup(func() { s.mu.Lock(); delete(s.agents, device); s.mu.Unlock() })
	command := M{"commandId": uuid(), "deviceId": device, "expectedEpoch": snapshot["epoch"], "expiresAt": now() + 60000, "payload": M{"type": "turn.start", "threadId": "thread-test", "text": "verbatim\x00text"}}
	if s.Submit(command)["type"] != "command.accepted" {
		t.Fatal("submit")
	}
	raw := <-peer.queue
	if store.Command(device, str(command["commandId"])) == nil {
		t.Fatal("dispatch preceded persistence")
	}
	var sent M
	json.Unmarshal(raw, &sent)
	if obj(obj(sent["command"])["payload"])["text"] != "verbatim\x00text" {
		t.Fatal("control text normalized")
	}
	s.Submit(command)
	if len(peer.queue) != 0 {
		t.Fatal("duplicate dispatch")
	}
	altered := clone(command)
	obj(altered["payload"])["text"] = "changed"
	expectFault(t, "command-id-reused", func() { s.Submit(altered) })
	for _, expiry := range []int64{now(), now() + 310000} {
		bad := clone(command)
		bad["commandId"] = uuid()
		bad["expiresAt"] = expiry
		expectFault(t, "invalid-command-expiry", func() { s.Submit(bad) })
	}
	store.Finish(M{"deviceId": device, "commandId": command["commandId"], "status": "succeeded"})
	if s.Submit(command)["type"] != "command.result" {
		t.Fatal("cached result")
	}
}
func TestConcurrentUpgradesAndShutdown(t *testing.T) {
	_, s, _, _ := fixture(t)
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ws, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.URL, "http")+"/v1/ws/client", nil)
			if e == nil {
				defer ws.Close()
				ws.SetReadDeadline(time.Now().Add(time.Second))
				ws.ReadMessage()
			}
		}()
	}
	s.Close()
	wg.Wait()
	if s.beginJob() {
		t.Fatal("accepted work after shutdown")
	}
}
func TestSnapshotUpdatesOnlyChangedThread(t *testing.T) {
	store, _, _, device := fixture(t)
	m := state(t, device)
	threads := obj(m["threads"])
	other := clone(threads["thread-test"])
	other["id"] = "other"
	threads["other"] = other
	store.SaveSnapshot(m)
	store.Q("CREATE TABLE writes(id TEXT)")
	store.Q("CREATE TRIGGER audit AFTER UPDATE ON snapshot_threads BEGIN INSERT INTO writes VALUES(NEW.thread_id); END")
	thread := clone(threads["thread-test"])
	thread["title"] = "new"
	store.SaveEvent(M{"protocolVersion": 1, "deviceId": device, "epoch": m["epoch"], "seq": 1, "timestamp": now(), "change": M{"type": "thread.updated", "thread": thread}})
	rows := store.Q("SELECT id FROM writes")
	if len(rows) != 1 || rows[0]["id"] != "thread-test" {
		t.Fatal("unrelated thread rewritten")
	}
	if obj(obj(store.Snapshot(device)["threads"])["other"])["title"] != other["title"] {
		t.Fatal("other thread lost")
	}
}
func TestAuthRejectsCoercedBodies(t *testing.T) {
	_, s, _, _ := fixture(t)
	for _, body := range []string{`{"username":123,"password":"anything"}`, `{"username":"user","password":123}`, `[]`, `null`} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/auth/login", strings.NewReader(body)))
		if w.Code != 400 {
			t.Fatalf("accepted malformed auth: %d", w.Code)
		}
	}
}
func TestOldCommandHashCompatibility(t *testing.T) {
	_, s, _, _ := fixture(t)
	raw, e := os.ReadFile("testdata/command-hashes.json")
	if e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Raw  string
		Hash string
	}
	if json.Unmarshal(raw, &cases) != nil {
		t.Fatal("fixture")
	}
	for _, c := range cases {
		var command M
		json.Unmarshal([]byte(c.Raw), &command)
		s.Validate("command", command)
		if commandHash(command, []byte(c.Raw)) != c.Hash {
			t.Fatal("old command hash changed")
		}
	}
}
func TestProtocolStripsUnknownFieldsAndCountsUTF16(t *testing.T) {
	_, s, _, device := fixture(t)
	command := M{"commandId": "c", "deviceId": device, "expectedEpoch": "e", "expiresAt": now() + 60000, "extra": "ignored", "payload": M{"type": "turn.start", "threadId": "t", "text": "hello", "extra": true}}
	s.Validate("command", command)
	if command["extra"] != nil || obj(command["payload"])["extra"] != nil {
		t.Fatal("unknown fields retained")
	}
	command["commandId"] = strings.Repeat("😀", 81)
	expectFault(t, "invalid-message", func() { s.Validate("command", command) })
}

type countedMessage struct{ count *int }

func (m countedMessage) MarshalJSON() ([]byte, error) {
	*m.count++
	return []byte(`{"type":"test"}`), nil
}
func TestBroadcastIsolationBackpressureAndSingleEncoding(t *testing.T) {
	_, s, _, _ := fixture(t)
	count := 0
	peer := func(device string) *Peer {
		return &Peer{s: s, devices: map[string]bool{device: true}, queue: make(chan []byte, 2), done: make(chan struct{})}
	}
	slow, fast, other := peer("a"), peer("a"), peer("b")
	slow.buffered.Store(17 * 1024 * 1024)
	s.mu.Lock()
	for _, p := range []*Peer{slow, fast, other} {
		s.clients[p] = true
	}
	s.mu.Unlock()
	s.Broadcast("a", countedMessage{&count})
	if count != 1 || len(fast.queue) != 1 || len(other.queue) != 0 {
		t.Fatal("broadcast scope/serialization")
	}
	select {
	case <-slow.done:
	default:
		t.Fatal("slow subscriber not closed")
	}
	m := obj(s.metrics.Snapshot()["transport"])
	if num(m["backpressureCloses"]) != 1 || num(m["broadcastRecipients"]) != 1 {
		t.Fatal("broadcast metrics")
	}
}
func TestFIFOCommandsBeforeMaintenance(t *testing.T) {
	store, s, _, device := fixture(t)
	store.Q("INSERT INTO commands VALUES($1,'c','hash','pending',NULL,$2,1)", device, now()-6000)
	gate, entered := make(chan struct{}), make(chan struct{})
	s.enqueueLane(device, func() { close(entered); <-gate })
	<-entered
	s.enqueueLane(device, func() { store.Finish(M{"deviceId": device, "commandId": "c", "status": "succeeded"}) })
	heartbeat := make(chan struct{})
	go func() { s.heartbeat(); close(heartbeat) }()
	eventually(t, func() bool { return s.deviceWaiting.Load() >= 2 })
	close(gate)
	select {
	case <-heartbeat:
	case <-time.After(time.Second):
		t.Fatal("maintenance stalled")
	}
	if store.Command(device, "c")["status"] != "succeeded" {
		t.Fatal("maintenance overtook queued reply")
	}
}
func TestThreadLimitAndRemovalRemainAtomic(t *testing.T) {
	store, _, _, device := fixture(t)
	m := state(t, device)
	template := obj(obj(m["threads"])["thread-test"])
	threads := M{}
	for i := 0; i < 20; i++ {
		thread := clone(template)
		thread["id"] = fmt.Sprint(i)
		threads[fmt.Sprint(i)] = thread
	}
	m["threads"] = threads
	store.SaveSnapshot(m)
	extra := clone(template)
	extra["id"] = "extra"
	event := M{"protocolVersion": 1, "deviceId": device, "epoch": m["epoch"], "seq": 1, "timestamp": now(), "change": M{"type": "thread.updated", "thread": extra}}
	expectFault(t, "thread-limit", func() { store.SaveEvent(event) })
	if num(store.Snapshot(device)["lastSeq"]) != 0 {
		t.Fatal("failed limit changed sequence")
	}
	event["change"] = M{"type": "thread.removed", "threadId": "0"}
	store.SaveEvent(event)
	event["seq"] = 2
	event["change"] = M{"type": "thread.updated", "thread": extra}
	store.SaveEvent(event)
	if len(obj(store.Snapshot(device)["threads"])) != 20 {
		t.Fatal("thread slot not freed")
	}
}
func TestMetricsRecordFailuresWithoutPayloads(t *testing.T) {
	store, s, p, device := fixture(t)
	snapshot := state(t, device)
	store.SaveSnapshot(snapshot)
	event := M{"deviceId": device, "epoch": snapshot["epoch"], "seq": 1, "timestamp": now(), "change": M{"type": "runtime.status", "connected": true}}
	store.SaveEvent(event)
	expectFault(t, "sequence-gap", func() { store.SaveEvent(event) })
	expectAnyFault(t, func() { store.Q("SELECT missing_sensitive_column FROM users") })
	store.Cleanup(context.Background())
	m := s.MetricSnapshot()
	if num(obj(m["events"])["errors"]) != 1 || num(obj(m["database"])["errors"]) != 1 || num(obj(m["database"])["transactionErrors"]) != 1 || num(obj(obj(m["cleanup"])["runs"])["count"]) != 1 {
		t.Fatal("failure metrics")
	}
	encoded := js(m)
	for _, secret := range []string{p.ID, device, "test-password-12345", "missing_sensitive_column", "SELECT"} {
		if strings.Contains(encoded, secret) {
			t.Fatal("metrics payload leak")
		}
	}
}
func TestUnicodeAccountNamespace(t *testing.T) {
	store, _, _, _ := fixture(t)
	user := store.CreateUser("Éxample", "test-password-12345", "user")
	if store.CheckPassword("éXAMPLE", "test-password-12345", "user").ID != user["id"] {
		t.Fatal("unicode lookup")
	}
	expectFault(t, "account-name-taken", func() { store.CreateUser("éxample", "test-password-12345", "user") })
}
