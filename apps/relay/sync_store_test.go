package relay

import (
	"fmt"
	"strings"
	"testing"
)

func TestReplayBoundsAndMissingEvents(t *testing.T) {
	store, _, _, device := fixture(t)
	snapshot := state(t, device)
	store.SaveSnapshot(snapshot)
	epoch := str(snapshot["epoch"])
	for seq := 1; seq <= maxReplayEvents+1; seq++ {
		store.SaveEvent(M{"protocolVersion": 1, "deviceId": device, "epoch": epoch, "seq": seq, "timestamp": now(), "change": M{"type": "runtime.status", "connected": true}})
	}
	if _, ok := store.Replay(device, epoch, 0); ok {
		t.Fatal("large catch-up must use the latest snapshot")
	}
	events, ok := store.Replay(device, epoch, 1)
	if !ok || len(events) != maxReplayEvents || num(events[0]["seq"]) != 2 || num(events[len(events)-1]["seq"]) != maxReplayEvents+1 {
		t.Fatal("small catch-up lost ordered events")
	}
	if events, ok := store.Replay(device, epoch, maxReplayEvents+1); !ok || len(events) != 0 {
		t.Fatal("up-to-date health probe must acknowledge without a snapshot")
	}
	for _, cursor := range []struct {
		epoch string
		seq   int64
	}{{"old", 1}, {epoch, maxReplayEvents + 2}} {
		if _, ok := store.Replay(device, cursor.epoch, cursor.seq); ok {
			t.Fatal("invalid cursor was replayed")
		}
	}
	store.Q("DELETE FROM events WHERE device_id=$1 AND seq=$2", device, 32)
	if _, ok := store.Replay(device, epoch, 1); ok {
		t.Fatal("missing retained event must use a snapshot")
	}
	if num(store.Snapshot(device)["lastSeq"]) != maxReplayEvents+1 {
		t.Fatal("catch-up policy modified the latest state")
	}
}

func TestReplayByteBudget(t *testing.T) {
	for _, output := range []string{strings.Repeat("x", 8192), strings.Repeat("蛙", 2730)} {
		t.Run(fmt.Sprint(len(output)), func(t *testing.T) {
			store, s, _, device := fixture(t)
			snapshot := state(t, device)
			store.SaveSnapshot(snapshot)
			thread := obj(obj(snapshot["threads"])["thread-test"])
			items := []any{}
			for i := 0; i < 16; i++ {
				items = append(items, M{"id": fmt.Sprint(i), "type": "commandExecution", "output": output, "truncated": false})
			}
			obj(list(thread["turns"])[0])["items"] = items
			for seq := 1; seq <= 8; seq++ {
				thread["revision"] = seq
				event := M{"protocolVersion": 1, "deviceId": device, "epoch": snapshot["epoch"], "seq": seq, "timestamp": now(), "change": M{"type": "thread.updated", "thread": thread}}
				s.Validate("device", M{"type": "device.event", "event": event})
				store.SaveEvent(event)
			}
			if _, ok := store.Replay(device, str(snapshot["epoch"]), 0); ok {
				t.Fatal("few large events must also use a snapshot")
			}
			if events, ok := store.Replay(device, str(snapshot["epoch"]), 1); !ok || len(events) != 7 {
				t.Fatal("bounded large events should remain replayable")
			}
		})
	}
}
