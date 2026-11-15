package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestAgentResourcesRoundTripAndAccess(t *testing.T) {
	store, s, p, device := fixture(t)
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	userToken := sessionToken(store, p)
	other := str(store.CreateUser("other-resource-user", "test-password-12345", "user")["id"])
	otherToken := str(store.CreateSession(other, "")["session"])
	agentToken := str(store.CreateSession(p.ID, device)["session"])
	path := "/v1/devices/" + device + "/resources"
	call := func(token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	for _, test := range []struct {
		token  string
		status int
	}{{"", 401}, {otherToken, 404}, {agentToken, 401}, {userToken, 409}} {
		if w := call(test.token); w.Code != test.status {
			t.Fatalf("access: %d %s", w.Code, w.Body)
		}
	}
	headers := http.Header{"Authorization": {"Bearer " + agentToken}, "X-Device-Id": {device}}
	ws, _, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http:", "ws:", 1)+"/v1/ws/device", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	var welcome M
	if err := ws.ReadJSON(&welcome); err != nil || welcome["type"] != "device.welcome" {
		t.Fatal("welcome", err)
	}
	if w := call(userToken); w.Code != 409 || !strings.Contains(w.Body.String(), "agent-update-required") {
		t.Fatal("legacy compatibility", w.Body)
	}
	if err := ws.WriteJSON(M{"type": "device.capabilities", "features": []string{"resources"}}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		a := s.agent(device)
		a.mu.Lock()
		ready := a.resources
		a.mu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("capability not received")
		}
		time.Sleep(time.Millisecond)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- call(userToken) }()
	var request M
	if err := ws.ReadJSON(&request); err != nil || request["type"] != "resources.request" {
		t.Fatal("request", request, err)
	}
	resource := M{"capturedAt": now(), "logicalCpus": 8, "sampleWindowMs": 5000,
		"agent":    M{"pid": 123, "name": "Codexer Agent", "cpuPercent": 1.5, "residentBytes": 128 * 1024 * 1024, "privateBytes": 96 * 1024 * 1024, "uptimeSeconds": 42},
		"children": []any{}}
	if err := ws.WriteJSON(M{"type": "device.resources", "requestId": request["requestId"], "resources": resource}); err != nil {
		t.Fatal(err)
	}
	select {
	case w := <-result:
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Code, w.Body)
		}
		var returned M
		if json.Unmarshal(w.Body.Bytes(), &returned) != nil || js(returned) != js(resource) {
			t.Fatal("wrong response", w.Body)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no resource response")
	}
	if len(store.Q("SELECT id FROM commands")) != 0 || len(store.Q("SELECT device_id FROM snapshots")) != 0 || len(store.Q("SELECT device_id FROM events")) != 0 {
		t.Fatal("telemetry persisted")
	}
	s.mu.Lock()
	pending := len(s.pending)
	s.mu.Unlock()
	if pending != 0 {
		t.Fatal("pending response retained", pending)
	}
	if w := call(otherToken); w.Code != 404 {
		t.Fatal("cross account access")
	}
}

func TestAgentResourcesCancellationAndBounds(t *testing.T) {
	store, s, p, device := fixture(t)
	peer := &Peer{s: s, resources: true, queue: make(chan []byte, 10), done: make(chan struct{})}
	s.agents[device] = peer
	token := sessionToken(store, p)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("GET", "/v1/devices/"+device+"/resources", nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+token)
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); s.Handler().ServeHTTP(w, r); finished <- w }()
	select {
	case <-peer.queue:
	case <-time.After(2 * time.Second):
		t.Fatal("request not forwarded")
	}
	cancel()
	select {
	case w := <-finished:
		if w.Code != 499 {
			t.Fatal(w.Code, w.Body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation retained request")
	}
	s.mu.Lock()
	pending := len(s.pending)
	s.mu.Unlock()
	if pending != 0 {
		t.Fatal("cancelled pending retained")
	}
	for range 4 {
		s.addPending(&Pending{Device: device, Kind: "resources", ID: uuid(), Reply: make(chan response, 1)}, 64, 4)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r.Clone(context.Background()))
	if w.Code != 429 {
		t.Fatal("unbounded requests", w.Code, w.Body)
	}
	s.FailPending(device, "device-offline")
	s.mu.Lock()
	pending = len(s.pending)
	s.mu.Unlock()
	if pending != 0 {
		t.Fatal("disconnect retained pending")
	}
}
