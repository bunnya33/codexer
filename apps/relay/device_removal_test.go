package relay

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestRemoveOfflineDeviceData(t *testing.T) {
	for _, backend := range []string{"sqlite", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			url := ""
			if backend == "postgres" {
				url, _ = postgresFixture(t)
			}
			store, err := Open(url, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			owner := str(store.CreateUser("owner", "test-password-12345", "user")["id"])
			other := str(store.CreateUser("other", "test-password-12345", "user")["id"])
			installation := uuid()
			device := store.Register(owner, installation, "PC", "win32")
			unrelated := store.Register(owner, uuid(), "Other PC", "win32")
			login := str(store.CreateSession(owner, "")["session"])
			agentSession := str(store.CreateSession(owner, device)["session"])
			s, err := New(store, Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			request := func(session string) *httptest.ResponseRecorder {
				r := httptest.NewRequest("DELETE", "/v1/devices/"+device+"/data", nil)
				if session != "" {
					r.Header.Set("Authorization", "Bearer "+session)
				}
				w := httptest.NewRecorder()
				s.Handler().ServeHTTP(w, r)
				return w
			}
			if request("").Code != 401 || request(str(store.CreateSession(other, "")["session"])).Code != 404 {
				t.Fatal("unowned deletion allowed")
			}
			s.mu.Lock()
			s.agents[device] = &Peer{}
			s.mu.Unlock()
			if w := request(login); w.Code != 409 || !strings.Contains(w.Body.String(), "device-online") {
				t.Fatal("online deletion allowed", w)
			}
			s.mu.Lock()
			delete(s.agents, device)
			s.mu.Unlock()
			store.SaveSnapshot(state(t, device))
			store.SaveSnapshot(state(t, unrelated))
			store.SaveCatalog(M{"deviceId": device})
			store.SaveCatalog(M{"deviceId": unrelated})
			store.Q("INSERT INTO events(device_id,epoch,seq,payload,created_at) VALUES($1,'e',1,'{}',$2)", device, now())
			store.Q("INSERT INTO commands(device_id,id,payload_hash,status,expires_at,created_at) VALUES($1,'command','hash','pending',$2,$3)", device, now()+60000, now())
			store.Q("INSERT INTO images(device_id,thread_id,id,payload,bytes,uploaded,created_at) VALUES($1,'thread','image','{}',2,TRUE,$2)", device, now())
			shareKey := strings.Repeat("a", 64)
			store.Q("INSERT INTO preview_shares(id,user_id,device_id,thread_id,kind,source,origin,entry_path,token,created_at,expires_at) VALUES('share',$1,$2,'thread','audio','/song.wav','','',$3,$4,$5)", owner, device, shareKey, now(), now()+60000)
			binding := uuid()
			store.Q("INSERT INTO weixin_bindings(id,user_id,bot_id,peer_id,base_url,token,created_at) VALUES($1,$2,'bot','peer','https://example.com','token',$3)", binding, owner, now())
			code := store.Target(owner, device, "thread")
			store.Q("UPDATE weixin_bindings SET reply_target_code=$2 WHERE id=$1", binding, code)
			store.Q("INSERT INTO weixin_thread_notifications(user_id,device_id,thread_id) VALUES($1,$2,'thread')", owner, device)
			store.Enqueue(binding, "out", "test", "cached result", device, code)
			store.Q("INSERT INTO weixin_inbox(binding_id,id,created_at,device_id) VALUES($1,'in',$2,$3)", binding, now(), device)
			u := upload{ID: strings.Repeat("b", 64), Owner: owner, Device: device, Expires: now() + 60000}
			keep := upload{ID: strings.Repeat("c", 64), Owner: owner, Device: unrelated, Expires: now() + 60000}
			for _, value := range []upload{u, keep} {
				s.uploads.save(value)
				if err := os.WriteFile(s.uploads.path(value.ID, ".data"), []byte("attachment"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(s.ctx)
			s.audio["audio"] = &AudioPlayback{Device: device, ctx: ctx, cancel: cancel}
			s.previews["preview"] = &Preview{Device: device, Principal: &Principal{ID: owner}}
			s.armPreviewShare(shareKey, now()+60000)
			if w := request(login); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			for _, table := range []string{"snapshots", "snapshot_threads", "catalogs", "events", "commands", "images", "preview_shares", "weixin_targets", "weixin_thread_notifications", "weixin_outbox", "weixin_inbox"} {
				if num(store.One("SELECT COUNT(*) AS n FROM "+table+" WHERE device_id=$1", device)["n"]) != 0 {
					t.Fatal("retained data", table)
				}
			}
			p := store.Session(login, "")
			if len(store.Devices(p)) != 1 || store.Owns(device, p) || store.Snapshot(unrelated) == nil || store.Catalog(unrelated) == nil {
				t.Fatal("list isolation")
			}
			if store.Session(agentSession, device) == nil {
				t.Fatal("removal must preserve authenticated reconnect")
			}
			if store.One("SELECT reply_target_code FROM weixin_bindings WHERE id=$1", binding)["reply_target_code"] != nil {
				t.Fatal("retained reply target")
			}
			if len(s.audio) != 0 || len(s.previews) != 0 || len(s.shareTimers) != 0 || ctx.Err() == nil {
				t.Fatal("retained in-memory capabilities")
			}
			if _, err := os.Stat(s.uploads.path(u.ID, ".data")); !os.IsNotExist(err) {
				t.Fatal("retained attachment")
			}
			if _, err := os.Stat(s.uploads.path(u.ID, ".json")); !os.IsNotExist(err) {
				t.Fatal("retained upload metadata")
			}
			if _, err := os.Stat(s.uploads.path(keep.ID, ".data")); err != nil {
				t.Fatal("other attachment lost", err)
			}
			if request(login).Code != 200 {
				t.Fatal("removal retry must be idempotent")
			}
			if store.Register(owner, installation, "PC", "win32") != device || !store.Owns(device, p) || len(store.Devices(p)) != 2 {
				t.Fatal("login must restore one identity")
			}
			if store.Session(agentSession, device) != nil {
				t.Fatal("new login must still replace old credentials")
			}
			if store.PublicPreviewShare(shareKey) != nil || store.Snapshot(device) != nil {
				t.Fatal("login must not restore old data or shares")
			}
		})
	}
}
