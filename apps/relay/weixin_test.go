package relay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fakeResponse(v any) *http.Response {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(js(v))), Header: make(http.Header)}
}
func wxFixture(t *testing.T) (*Store, *Server, *Weixin, *Principal, string, M) {
	store, s, p, device := fixture(t)
	w, e := NewWeixin(s, Options{WeixinKey: make([]byte, 32)})
	if e != nil {
		t.Fatal(e)
	}
	b := M{"id": uuid(), "user_id": p.ID}
	store.Q("INSERT INTO weixin_bindings(id,user_id,bot_id,peer_id,base_url,token,context,created_at) VALUES($1,$2,'bot','peer',$3,$4,$5,$6)", b["id"], p.ID, weixinBase, w.seal("token", scope(b, "token")), w.seal("context", scope(b, "context")), now()-10000)
	b = store.Binding(p.ID)
	store.SaveSnapshot(state(t, device))
	store.SaveCatalog(M{"protocolVersion": 1, "deviceId": device, "generatedAt": now(), "projects": []any{}, "threads": []any{M{"id": "thread-test", "title": "Thread", "cwd": nil, "projectId": nil, "updatedAt": now(), "archived": false}}})
	peer := &Peer{s: s, principal: p, devices: map[string]bool{}, queue: make(chan []byte, 128), done: make(chan struct{})}
	s.agents[device] = peer
	t.Cleanup(func() { s.mu.Lock(); delete(s.agents, device); s.mu.Unlock() })
	return store, s, w, p, device, b
}
func TestWeixinRepliesIsolationDedupeAndFreshness(t *testing.T) {
	store, s, w, p, device, b := wxFixture(t)
	code := store.Target(p.ID, device, "thread-test")
	store.Enqueue(str(b["id"]), "completion", "completion", "done", device, code)
	store.Delivered(str(b["id"]), "completion", true)
	b = store.Binding(p.ID)
	reply, target := w.handleText(b, "下一步", now(), "1", context.Background())
	if !strings.Contains(reply, "已提交排队请求") || target != code {
		t.Fatalf("reply %s %s", reply, target)
	}
	message := <-s.agents[device].queue
	var m M
	json.Unmarshal(message, &m)
	if obj(obj(m["command"])["payload"])["text"] != "下一步" {
		t.Fatal("command text")
	}
	stale, _ := w.handleText(b, "不会执行", now()-300001, "2", context.Background())
	if !strings.Contains(stale, "已过期") {
		t.Fatal("stale")
	}
	store.Q("UPDATE weixin_bindings SET replies=FALSE WHERE id=$1", b["id"])
	expectFault(t, "weixin-replies-disabled", func() { w.handleText(b, "不能执行", now(), "3", context.Background()) })
	store.Q("UPDATE weixin_bindings SET replies=TRUE WHERE id=$1", b["id"])
	other := store.CreateUser("other", "test-password-12345", "user")
	foreignDevice := store.Register(str(other["id"]), uuid(), "Other", "darwin")
	foreignCode := store.Target(str(other["id"]), foreignDevice, "thread-test")
	expectFault(t, "weixin-target-not-found", func() { w.handleText(b, "继续 "+foreignCode+" hello", now(), "4", context.Background()) })
	msg := M{"message_type": 1, "from_user_id": "peer", "message_id": json.Number("9223372036854775807"), "create_time_ms": now(), "item_list": []any{M{"type": 1, "text_item": M{"text": "设备"}}}}
	w.receive(b, msg, context.Background())
	w.receive(b, msg, context.Background())
	if num(store.One("SELECT COUNT(*) AS total FROM weixin_inbox WHERE id='9223372036854775807'")["total"]) != 1 {
		t.Fatal("lossless dedupe")
	}
	msg["message_id"] = "spoof"
	msg["from_user_id"] = "foreign-peer"
	w.receive(b, msg, context.Background())
	if store.One("SELECT 1 FROM weixin_inbox WHERE id='spoof'") != nil {
		t.Fatal("spoof")
	}
	list, _ := w.handleText(b, "会话", 0, "5", context.Background())
	if !strings.Contains(list, code) || strings.Contains(list, foreignCode) {
		t.Fatal("list isolation")
	}
}
func TestWeixinDeliveryStableIDAndReplyTarget(t *testing.T) {
	store, _, w, p, device, b := wxFixture(t)
	code := store.Target(p.ID, device, "thread-test")
	store.Enqueue(str(b["id"]), "completion", "completion", "done", device, code)
	clientIDs := []string{}
	attempt := 0
	w.client.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "Bearer token" || req.Header.Get("iLink-App-Id") != "bot" || req.Header.Get("AuthorizationType") != "ilink_bot_token" {
			t.Fatal("auth headers")
		}
		var v M
		json.NewDecoder(req.Body).Decode(&v)
		clientIDs = append(clientIDs, str(obj(v["msg"])["client_id"]))
		attempt++
		if attempt == 1 {
			return fakeResponse(M{"ret": 1}), nil
		}
		return fakeResponse(M{"ret": 0}), nil
	})
	w.send(b, context.Background())
	if store.Binding(p.ID)["reply_target_code"] != nil {
		t.Fatal("failed delivery switched target")
	}
	store.Q("UPDATE weixin_outbox SET next_attempt_at=0 WHERE id='completion'")
	w.send(b, context.Background())
	if len(clientIDs) != 2 || clientIDs[0] != clientIDs[1] {
		t.Fatal("retry id")
	}
	if store.Binding(p.ID)["reply_target_code"] != code {
		t.Fatal("successful target")
	}
	store.Enqueue(str(b["id"]), "old", "completion", "old", device, code)
	store.Q("UPDATE weixin_outbox SET created_at=1 WHERE id='old'")
	w.send(b, context.Background())
	if store.One("SELECT state FROM weixin_outbox WHERE id='old'")["state"] != "failed" {
		t.Fatal("stale notice")
	}
}
func TestWeixinQRVerificationAndRebinding(t *testing.T) {
	store, s, p, _ := fixture(t)
	w, _ := NewWeixin(s, Options{WeixinKey: make([]byte, 32)})
	status := "need_verifycode"
	w.client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/ilink/bot/get_bot_qrcode":
			return fakeResponse(M{"qrcode": "qr", "qrcode_img_content": "https://liteapp.weixin.qq.com/qr"}), nil
		case "/ilink/bot/get_qrcode_status":
			if r.URL.Query().Get("verify_code") == "123456" {
				status = "confirmed"
			}
			return fakeResponse(M{"status": status, "bot_token": "secret-token", "ilink_bot_id": "bot", "ilink_user_id": "peer"}), nil
		}
		t.Fatal("unexpected endpoint")
		return nil, nil
	})
	login := w.Login(p.ID)
	if !strings.HasPrefix(str(login["qrImage"]), "data:image/png;base64,") {
		t.Fatal("QR")
	}
	poll := w.PollLogin(p.ID, str(login["loginId"]), "")
	if poll["status"] != "need_verifycode" {
		t.Fatal("verification")
	}
	poll = w.PollLogin(p.ID, str(login["loginId"]), "123456")
	if poll["status"] != "confirmed" || poll["qrImage"] != nil {
		t.Fatal("confirmation")
	}
	b := store.Binding(p.ID)
	if strings.Contains(str(b["token"]), "secret-token") || w.open(str(b["token"]), scope(b, "token")) != "secret-token" {
		t.Fatal("credentials at rest")
	}
	other := store.CreateUser("other", "test-password-12345", "user")
	next := w.Login(str(other["id"]))
	expectFault(t, "weixin-already-connected", func() { w.PollLogin(str(other["id"]), str(next["loginId"]), "123456") })
	store.DisableUser(p.ID, "user", "")
	if w.current(b, context.Background()) != nil {
		t.Fatal("inactive binding")
	}
}
func TestWeixinAPIIDsLimitsAndErrors(t *testing.T) {
	_, s, _, _ := fixture(t)
	w, _ := NewWeixin(s, Options{WeixinKey: make([]byte, 32)})
	for _, tc := range []struct{ body, code string }{{`{"ret":-14}`, "weixin-session-expired"}, {`{"errcode":1}`, "weixin-api-error"}, {`not-json`, "weixin-invalid-response"}, {strings.Repeat("x", 2*1024*1024+1), "weixin-response-too-large"}} {
		w.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header)}, nil
		})
		expectFault(t, tc.code, func() { w.api(context.Background(), weixinBase, "ilink/bot/getupdates", M{}, "token", time.Second) })
	}
	w.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"msgs":[{"message_id":9223372036854775807}]}`)), Header: make(http.Header)}, nil
	})
	m := w.api(context.Background(), weixinBase, "ilink/bot/getupdates", M{}, "token", time.Second)
	if str(obj(list(m["msgs"])[0])["message_id"]) != "9223372036854775807" {
		t.Fatal("rounded ID")
	}
}
func TestWeixinSettingsNotificationScopeAndPendingRetention(t *testing.T) {
	store, s, w, p, device, b := wxFixture(t)
	s.wx = w
	other := store.CreateUser("foreign", "test-password-12345", "user")
	foreign := &Principal{ID: str(other["id"]), Kind: "user"}
	peer := func(q *Principal) *Peer {
		return &Peer{s: s, principal: q, devices: map[string]bool{}, queue: make(chan []byte, 8), done: make(chan struct{})}
	}
	a, second, outsider := peer(p), peer(p), peer(foreign)
	s.mu.Lock()
	for _, c := range []*Peer{a, second, outsider} {
		s.clients[c] = true
	}
	s.mu.Unlock()
	token := sessionToken(store, p)
	call := func(method, path string, payload M, status int) M {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(js(payload)))
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		var m M
		json.Unmarshal(response.Body.Bytes(), &m)
		return m
	}
	path := "/v1/devices/" + device + "/threads/thread-test/weixin-notification"
	if call("GET", path, nil, 200)["enabled"] != false {
		t.Fatal("default notification")
	}
	call("PUT", path, M{"enabled": true}, 200)
	if len(a.queue) != 1 || len(second.queue) != 1 || len(outsider.queue) != 0 {
		t.Fatal("preference broadcast scope")
	}
	code := store.Target(p.ID, device, "thread-test")
	otherCode := store.Target(p.ID, device, "other")
	store.Enqueue(str(b["id"]), "opted", "completion", "done", device, code)
	store.Enqueue(str(b["id"]), "unopted", "completion", "done", device, otherCode)
	call("PUT", "/v1/weixin", M{"notifications": false, "replies": true}, 200)
	if store.One("SELECT id FROM weixin_outbox WHERE id='opted'") == nil || store.One("SELECT id FROM weixin_outbox WHERE id='unopted'") != nil {
		t.Fatal("global switch discarded opted notifications")
	}
	call("PUT", path, M{"enabled": false}, 200)
	if store.One("SELECT id FROM weixin_outbox WHERE id='opted'") != nil {
		t.Fatal("session switch kept pending notice")
	}
	call("PUT", path, M{"enabled": "yes"}, 400)
	call("DELETE", "/v1/weixin", nil, 200)
	if store.Binding(p.ID) != nil {
		t.Fatal("unbind")
	}
}
func TestWeixinMalformedUpstreamTypes(t *testing.T) {
	_, s, _, _ := fixture(t)
	w, _ := NewWeixin(s, Options{WeixinKey: make([]byte, 32)})
	for _, body := range []string{`{"ret":0.5}`, `{"ret":null}`, `{"msgs":null}`, `{"msgs":[{"context_token":123}]}`, `{"msgs":[{"item_list":[{"type":1,"text_item":{"text":false}}]}]}`} {
		w.client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})
		expectFault(t, "weixin-invalid-response", func() { w.api(context.Background(), weixinBase, "ilink/bot/getupdates", M{}, "token", time.Second) })
	}
}
