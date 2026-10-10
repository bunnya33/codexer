package management

import (
	"encoding/json"
	"errors"
	relay "github.com/bunnya33/codexer/apps/relay"
	"strings"
	"testing"
	"time"
)

func legacyRows(t *testing.T, entries ...relay.M) string {
	t.Helper()
	var b strings.Builder
	for _, v := range entries {
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		b.Write(raw)
		b.WriteByte('\n')
	}
	return b.String()
}
func TestLegacyImportPreservesIdentityAndSplitState(t *testing.T) {
	store, e := relay.Open("", t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	password := relay.HashPassword("legacy-password-12345")
	expires := time.Now().UnixMilli() + 604800000
	rows := legacyRows(t,
		relay.M{"table": "users", "row": relay.M{"id": "old-admin", "name": "Admin", "role": "admin", "password_hash": password, "created_at": 1}},
		relay.M{"table": "users", "row": relay.M{"id": "old-user", "name": "Legacy", "token_hash": "old-token", "created_at": 1}},
		relay.M{"table": "devices", "row": relay.M{"id": "pc", "name": "PC", "platform": "darwin", "owner_user_id": "old-user", "created_at": 1}},
		relay.M{"table": "snapshots", "row": relay.M{"device_id": "pc", "epoch": "e", "seq": 7, "payload": relay.M{"deviceId": "pc", "epoch": "e", "lastSeq": 7, "threads": relay.M{"t": relay.M{"id": "t", "title": "Legacy thread"}}}}},
		relay.M{"table": "sessions", "row": relay.M{"hash": "session-hash", "user_id": "old-admin", "expires_at": expires}},
		relay.M{"table": "auth_settings", "row": relay.M{"id": 1, "idle_timeout_minutes": 120}},
		relay.M{"table": "images", "row": relay.M{"device_id": "pc", "thread_id": "t", "id": "image", "payload": relay.M{"name": "one.png"}, "bytes": 10, "uploaded": true, "expires_at": nil, "created_at": 1}},
		relay.M{"table": "commands", "row": relay.M{"device_id": "pc", "id": "command", "payload_hash": "old-hash", "status": "pending", "expires_at": 1, "created_at": 1}},
		relay.M{"table": "weixin_bindings", "row": relay.M{"id": "binding", "user_id": "old-user", "bot_id": "bot", "peer_id": "peer", "base_url": "https://ilinkai.weixin.qq.com", "token": "old-ciphertext", "created_at": 1}},
		relay.M{"table": "weixin_targets", "row": relay.M{"user_id": "old-user", "code": "C12345678", "device_id": "pc", "thread_id": "t"}},
		relay.M{"table": "weixin_thread_notifications", "row": relay.M{"user_id": "old-user", "device_id": "pc", "thread_id": "t"}},
		relay.M{"table": "weixin_outbox", "row": relay.M{"binding_id": "binding", "id": "completion", "kind": "completion", "text": "done", "client_id": "stable-client", "created_at": 1, "next_attempt_at": 1}},
	)
	counts := importLegacyRows(store, strings.NewReader(rows), func() error { return nil })
	if counts["users"] != 2 || store.CheckPassword("Admin", "legacy-password-12345", "admin").ID != "old-admin" {
		t.Fatal("credentials lost")
	}
	if store.CheckPassword("Legacy", "old-token", "user") != nil || store.Users("user")[0]["login_enabled"] != false {
		t.Fatal("legacy token revived")
	}
	if store.IdleTimeout() != 120 || store.Command("pc", "command")["status"] != "unknown" {
		t.Fatal("policy or pending outcome")
	}
	snapshot := store.Snapshot("pc")
	if snapshot["lastSeq"] != float64(7) || snapshot["threads"].(map[string]any)["t"].(map[string]any)["title"] != "Legacy thread" {
		t.Fatal("snapshot")
	}
	if store.One("SELECT payload FROM snapshots WHERE device_id='pc'")["payload"].(map[string]any)["threads"] != nil {
		t.Fatal("snapshot not split")
	}
	if store.One("SELECT last_active_at FROM sessions WHERE hash='session-hash'")["last_active_at"] != expires-604800000 {
		t.Fatal("activity migration")
	}
	if store.One("SELECT token FROM weixin_bindings")["token"] != "old-ciphertext" || store.One("SELECT client_id FROM weixin_outbox")["client_id"] != "stable-client" {
		t.Fatal("encrypted settings or outbox identity")
	}
}
func TestLegacyImportRollsBackMalformedAndIncompleteExports(t *testing.T) {
	for _, mode := range []string{"invalid-json", "duplicate", "process-failure"} {
		t.Run(mode, func(t *testing.T) {
			store, e := relay.Open("", t.TempDir())
			if e != nil {
				t.Fatal(e)
			}
			defer store.Close()
			row := legacyRows(t, relay.M{"table": "users", "row": relay.M{"id": "u", "name": "User", "created_at": 1}})
			verify := func() error { return nil }
			switch mode {
			case "invalid-json":
				row += "broken\n"
			case "duplicate":
				row += row
			case "process-failure":
				verify = func() error { return errors.New("export failed") }
			}
			failed := false
			func() {
				defer func() { failed = recover() != nil }()
				importLegacyRows(store, strings.NewReader(row), verify)
			}()
			if !failed || len(store.Users("user")) != 0 {
				t.Fatal("partial import survived")
			}
		})
	}
}
