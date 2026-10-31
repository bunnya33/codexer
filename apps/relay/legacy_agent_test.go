package relay

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLegacyEmptyActiveTurnRemainsConnected(t *testing.T) {
	store, s, p, device := fixture(t)
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
	thread["status"] = "active"
	thread["activeTurnId"] = ""
	ws.WriteJSON(M{"type": "device.snapshot", "snapshot": snapshot})
	eventually(t, func() bool { return store.Snapshot(device) != nil })
	if obj(obj(store.Snapshot(device)["threads"])["thread-test"])["activeTurnId"] != nil {
		t.Fatal("legacy snapshot was not normalized")
	}
	thread["revision"] = 1
	event := M{"protocolVersion": 1, "deviceId": device, "epoch": snapshot["epoch"], "seq": 1, "timestamp": now(), "change": M{"type": "thread.updated", "thread": thread}}
	ws.WriteJSON(M{"type": "device.event", "event": event})
	eventually(t, func() bool { return num(store.Snapshot(device)["lastSeq"]) == 1 })
	if obj(obj(store.Snapshot(device)["threads"])["thread-test"])["activeTurnId"] != nil {
		t.Fatal("legacy event was not normalized")
	}
	// A subsequent frame must still be processed on the same connection.
	event["seq"] = 2
	thread["activeTurnId"] = "known-turn"
	ws.WriteJSON(M{"type": "device.event", "event": event})
	eventually(t, func() bool { return num(store.Snapshot(device)["lastSeq"]) == 2 })
	if obj(obj(store.Snapshot(device)["threads"])["thread-test"])["activeTurnId"] != "known-turn" {
		t.Fatal("real turn identity was altered")
	}
	for _, entry := range logEntries(s.logs) {
		if entry.CloseCode == 1008 || entry.Code == "invalid-message" {
			t.Fatal("legacy compatibility still rejected", entry)
		}
	}
	ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "client-closed"), time.Now().Add(time.Second))
}

func TestLegacyActiveTurnCompatibilityDoesNotRelaxOtherIDs(t *testing.T) {
	_, s, _, device := fixture(t)
	for _, value := range []any{123, strings.Repeat("x", 161)} {
		snapshot := state(t, device)
		obj(obj(snapshot["threads"])["thread-test"])["activeTurnId"] = value
		expectFault(t, "invalid-message", func() { s.Validate("device", M{"type": "device.snapshot", "snapshot": snapshot}) })
	}
	snapshot := state(t, device)
	thread := obj(obj(snapshot["threads"])["thread-test"])
	thread["id"] = ""
	thread["activeTurnId"] = ""
	expectFault(t, "invalid-message", func() { s.Validate("device", M{"type": "device.snapshot", "snapshot": snapshot}) })
}
