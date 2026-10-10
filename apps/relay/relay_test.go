package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Store, *Server, *Principal, string) {
	t.Helper()
	store, e := Open("", t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	user := store.CreateUser("user", "test-password-12345", "user")
	id := str(user["id"])
	session := store.CreateSession(id, "")
	p := store.Session(str(session["session"]), "")
	device := store.Register(id, uuid(), "PC", "darwin")
	s, e := New(store, Options{Version: "0.3.0"})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close(); store.Close() })
	return store, s, p, device
}
func state(t *testing.T, device string) M {
	t.Helper()
	b, e := os.ReadFile("testdata/snapshot.json")
	if e != nil {
		t.Fatal(e)
	}
	var m M
	if json.Unmarshal(b, &m) != nil {
		t.Fatal("fixture")
	}
	m["deviceId"] = device
	m["generatedAt"] = now()
	return m
}
func expectFault(t *testing.T, code string, fn func()) {
	t.Helper()
	defer func() {
		v := recover()
		if v == nil {
			t.Fatalf("expected %s", code)
		}
		if f, ok := v.(Fault); ok {
			if f.Code != code {
				t.Fatalf("got %s, want %s", f.Code, code)
			}
		} else {
			t.Fatalf("unexpected panic: %v", v)
		}
	}()
	fn()
}
func TestScryptNodeCompatibility(t *testing.T) {
	encoded := "scrypt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:ca72ab774197f76a14a92fb2184d28343f1ffdae1b5d67cff7a9a0994d3acd33313e22cf4948f165a86afeb913696aad61cb5c77081becc05264f21c52fb2419"
	if !VerifyPassword("test-password-12345", encoded) || VerifyPassword("bad", encoded) || VerifyPassword("test-password-12345", "malformed") {
		t.Fatal("password compatibility")
	}
}
func TestAccountRolesAndRevocation(t *testing.T) {
	store, s, p, device := fixture(t)
	admin := store.CreateUser("user", "test-password-12345", "admin")
	if store.CheckPassword(" USER ", "test-password-12345", "admin").ID != admin["id"] || store.CheckPassword("user", "test-password-12345", "user").ID != p.ID {
		t.Fatal("role separation")
	}
	ticket := store.Ticket(p)
	if store.ConsumeTicket(str(ticket["ticket"])) == nil || store.ConsumeTicket(str(ticket["ticket"])) != nil {
		t.Fatal("single use ticket")
	}
	expectFault(t, "admin-disable-protected", func() { store.DisableUser(str(admin["id"]), "admin", str(admin["id"])) })
	agent := store.CreateSession(p.ID, device)
	store.ResetUser(p.ID, "changed-password-1234", "user")
	if store.SessionHash(p.Hash, "") != nil || store.Session(str(agent["session"]), device) != nil {
		t.Fatal("reset did not revoke sessions")
	}
	s.CloseSessions(func(q *Principal) bool { return q.ID == p.ID }, "password-reset")
}
func TestIdlePolicyAndAgentSession(t *testing.T) {
	store, _, p, device := fixture(t)
	agent := store.CreateSession(p.ID, device)
	browser := store.CreateSession(p.ID, "")
	store.Settings(2)
	row := store.One("SELECT expires_at,last_active_at FROM sessions WHERE hash=$1", hash(str(browser["session"])))
	if num(row["expires_at"])-num(row["last_active_at"]) != 120000 {
		t.Fatal("policy")
	}
	if store.Session(str(agent["session"]), device).Expires != num(agent["expiresAt"]) {
		t.Fatal("agent session renewed")
	}
	store.Q("UPDATE sessions SET expires_at=$2 WHERE hash=$1", hash(str(browser["session"])), now()-1)
	store.Settings(1440)
	if store.Session(str(browser["session"]), "") != nil {
		t.Fatal("revived expired session")
	}
	store.Q("UPDATE sessions SET expires_at=$2 WHERE hash=$1", p.Hash, now()-1)
	if store.SessionHash(p.Hash, "") != nil {
		t.Fatal("session boundary")
	}
}
func TestSplitSnapshotsReplayAndRollback(t *testing.T) {
	store, s, _, device := fixture(t)
	m := state(t, device)
	s.Validate("device", M{"type": "device.snapshot", "snapshot": m})
	store.SaveSnapshot(m)
	head := obj(store.One("SELECT payload FROM snapshots WHERE device_id=$1", device)["payload"])
	if head["threads"] != nil {
		t.Fatal("metadata contains threads")
	}
	thread := clone(obj(obj(m["threads"])["thread-test"]))
	thread["title"] = "updated\x00title"
	event := M{"protocolVersion": 1, "deviceId": device, "epoch": m["epoch"], "seq": 1, "timestamp": now(), "change": M{"type": "thread.updated", "thread": thread}}
	store.SaveEvent(event)
	expectFault(t, "sequence-gap", func() { store.SaveEvent(event) })
	snapshot := store.Snapshot(device)
	if num(snapshot["lastSeq"]) != 1 || obj(obj(snapshot["threads"])["thread-test"])["title"] != "updated�title" {
		t.Fatal("rollback / text normalization")
	}
	events, ok := store.Replay(device, str(m["epoch"]), 0)
	if !ok || len(events) != 1 {
		t.Fatal("replay")
	}
	if _, ok = store.Replay(device, "old", 0); ok {
		t.Fatal("old epoch")
	}
	expectFault(t, "stale-snapshot", func() { store.SaveSnapshot(m) })
	snapshot["epoch"] = "new"
	snapshot["lastSeq"] = 0
	snapshot["threads"] = M{}
	store.SaveSnapshot(snapshot)
	if len(obj(store.Snapshot(device)["threads"])) != 0 {
		t.Fatal("old threads resurrected")
	}
}
func TestProtocolRefinements(t *testing.T) {
	_, s, _, device := fixture(t)
	m := state(t, device)
	bad := clone(m)
	obj(bad["threads"])["wrong"] = obj(m["threads"])["thread-test"]
	expectFault(t, "invalid-message", func() { s.Validate("device", M{"type": "device.snapshot", "snapshot": bad}) })
	base := M{"commandId": uuid(), "deviceId": device, "expectedEpoch": "e", "expiresAt": now() + 60000}
	for _, payload := range []M{{"type": "turn.start", "threadId": "t", "text": " "}, {"type": "thread.model.update", "threadId": "t", "model": "foo bar", "expectedModel": "x"}, {"type": "input.respond", "threadId": "t", "turnId": "v", "requestId": "r", "answers": func() M {
		m := M{}
		for i := 0; i < 21; i++ {
			m[fmt.Sprint(i)] = M{"answers": []any{}}
		}
		return m
	}()}} {
		base["payload"] = payload
		expectAnyFault(t, func() { s.Validate("command", base) })
	}
}
func expectAnyFault(t *testing.T, fn func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Fatal("expected validation failure")
		}
	}()
	fn()
}
func TestTransactionalCompletionsAndPreferences(t *testing.T) {
	store, _, p, device := fixture(t)
	binding := uuid()
	store.Q("INSERT INTO weixin_bindings(id,user_id,bot_id,peer_id,base_url,token,created_at,notifications) VALUES($1,$2,'bot','peer',$3,'encrypted',$4,FALSE)", binding, p.ID, weixinBase, now()-60000)
	before := state(t, device)
	thread := obj(obj(before["threads"])["thread-test"])
	thread["activeTurnId"] = "turn-A"
	store.SaveSnapshot(before)
	if num(store.One("SELECT COUNT(*) AS total FROM weixin_outbox")["total"]) != 0 {
		t.Fatal("initial flood")
	}
	after := clone(before)
	turn := obj(list(obj(obj(after["threads"])["thread-test"])["turns"])[0])
	turn["status"] = "completed"
	turn["completedAtMs"] = now()
	store.SaveSnapshot(after)
	if num(store.One("SELECT COUNT(*) AS total FROM weixin_outbox")["total"]) != 0 {
		t.Fatal("opt out")
	}
	store.Q("INSERT INTO weixin_thread_notifications VALUES($1,$2,'thread-test')", p.ID, device)
	store.SaveSnapshot(before)
	store.SaveSnapshot(after)
	store.SaveSnapshot(after)
	if num(store.One("SELECT COUNT(*) AS total FROM weixin_outbox")["total"]) != 1 {
		t.Fatal("notification dedup")
	}
	row := store.One("SELECT * FROM weixin_outbox")
	store.Delivered(binding, str(row["id"]), true)
	if store.Binding(p.ID)["reply_target_code"] != row["target_code"] {
		t.Fatal("reply target")
	}
	store.Enqueue(binding, "unrelated", "test", "test", "", "")
	store.Delivered(binding, "unrelated", true)
	if store.Binding(p.ID)["reply_target_code"] != row["target_code"] {
		t.Fatal("unrelated delivery switched target")
	}
	store.Q("CREATE TRIGGER outbox_failure BEFORE INSERT ON weixin_outbox BEGIN SELECT RAISE(ABORT,'fixture'); END")
	after = clone(after)
	turn = obj(list(obj(obj(after["threads"])["thread-test"])["turns"])[0])
	turn["id"] = "new-turn"
	turn["startedAtMs"] = now()
	turn["completedAtMs"] = now()
	seq := num(store.Snapshot(device)["lastSeq"])
	func() {
		defer func() { recover() }()
		store.SaveEvent(M{"protocolVersion": 1, "deviceId": device, "epoch": before["epoch"], "seq": seq + 1, "timestamp": now(), "change": M{"type": "thread.updated", "thread": obj(obj(after["threads"])["thread-test"])}})
	}()
	if num(store.Snapshot(device)["lastSeq"]) != seq {
		t.Fatal("completion did not rollback atomically")
	}
}
func TestWeixinEncryptionAndHost(t *testing.T) {
	_, s, _, _ := fixture(t)
	w, e := NewWeixin(s, Options{WeixinKey: make([]byte, 32)})
	if e != nil {
		t.Fatal(e)
	}
	ciphertext := w.seal("secret", "u:b:token")
	if w.open(ciphertext, "u:b:token") != "secret" {
		t.Fatal("secret")
	}
	expectFault(t, "weixin-invalid-secret", func() { w.open(ciphertext, "other") })
	for _, url := range []string{"http://ilinkai.weixin.qq.com", "https://evil.com", "https://ilinkai.weixin.qq.com:443", "https://user@ilinkai.weixin.qq.com", "https://ilinkai.weixin.qq.com/path"} {
		expectFault(t, "weixin-invalid-host", func() { wxURL(url) })
	}
	if wxURL(weixinBase) != weixinBase {
		t.Fatal("host")
	}
}
func TestMaintenancePreservesDedupeAndPending(t *testing.T) {
	store, _, p, device := fixture(t)
	store.Q("INSERT INTO commands VALUES($1,'c','hash','succeeded',NULL,1,1)", device)
	store.Q("INSERT INTO tickets VALUES('expired',1,$1,$2)", p.ID, p.Hash)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store.Cleanup(ctx)
	if store.One("SELECT hash FROM tickets WHERE hash='expired'") == nil {
		t.Fatal("cancel ignored")
	}
	store.Cleanup(context.Background())
	if store.One("SELECT hash FROM tickets WHERE hash='expired'") != nil || store.Command(device, "c") == nil {
		t.Fatal("retention")
	}
}
func TestParallelLanesAndRevocationBarrier(t *testing.T) {
	_, s, _, _ := fixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan struct{})
	go s.lane("a", func() { close(entered); <-release })
	<-entered
	go s.lane("b", func() { close(done) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("unrelated device blocked")
	}
	var mu sync.Mutex
	order := []int{}
	go func() { s.exclusive.Lock(); mu.Lock(); order = append(order, 1); mu.Unlock(); s.exclusive.Unlock() }()
	time.Sleep(10 * time.Millisecond)
	go s.lane("a", func() { mu.Lock(); order = append(order, 2); mu.Unlock() })
	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		if len(order) == 2 {
			if order[0] != 1 {
				t.Fatal("barrier ordering")
			}
			mu.Unlock()
			return
		}
		mu.Unlock()
		time.Sleep(time.Millisecond)
	}
	t.Fatal("barrier never finished")
}
func TestAuthAndMetricsRoutes(t *testing.T) {
	store, s, p, _ := fixture(t)
	admin := store.CreateUser("admin", "test-password-12345", "admin")
	session := store.CreateSession(str(admin["id"]), "")
	for _, test := range []struct {
		session string
		status  int
	}{{"", 401}, {sessionToken(store, p), 403}, {str(session["session"]), 200}} {
		req := httptest.NewRequest("GET", "/v1/admin/metrics", nil)
		if test.session != "" {
			req.Header.Set("Authorization", "Bearer "+test.session)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, req)
		if w.Code != test.status {
			t.Fatalf("metrics status %d != %d", w.Code, test.status)
		}
		if w.Code == 200 {
			var v M
			json.Unmarshal(w.Body.Bytes(), &v)
			if num(obj(obj(v["process"])["memoryBytes"])["rss"]) <= 0 {
				t.Fatal("memory")
			}
			if strings.Contains(w.Body.String(), p.ID) || strings.Contains(w.Body.String(), "SELECT") {
				t.Fatal("metrics leak")
			}
		}
	}
	for _, v := range []string{"0", "1.5", "\"60\"", "43201"} {
		req := httptest.NewRequest("PUT", "/v1/admin/auth-settings", strings.NewReader(`{"idleTimeoutMinutes":`+v+`}`))
		req.Header.Set("Authorization", "Bearer "+str(session["session"]))
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, req)
		if w.Code != 400 {
			t.Fatalf("accepted %s", v)
		}
	}
}
func sessionToken(store *Store, p *Principal) string {
	return str(store.CreateSession(p.ID, "")["session"])
}
func TestImageAndPreviewRewriting(t *testing.T) {
	image := M{"name": "one.png", "mimeType": "image/png", "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII="}
	if len(imageBytes(image)) == 0 {
		t.Fatal("PNG")
	}
	image["mimeType"] = "image/jpeg"
	expectFault(t, "invalid-image", func() { imageBytes(image) })
	text := rewritePreview(`<html><head></head><script type="module" src="/src/main.js"></script><style>url('/img.png')</style>`, "text/html", "/prefix/", "http://localhost:3000", "/nested/page")
	for _, v := range []string{"/prefix/src/main.js", "/prefix/img.png", "document,'cookie'", "__socket"} {
		if !strings.Contains(text, v) {
			t.Fatalf("missing %s", v)
		}
	}
	if strings.Contains(previewDocument(text, "</script>", nil), `)("</script>"`) {
		t.Fatal("script injection")
	}
	if _, e := base64.StdEncoding.DecodeString("%%%%"); e == nil {
		t.Fatal("base64")
	}
}

var _ = http.StatusOK
