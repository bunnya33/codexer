package relay

import (
	"math"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPreviewShareSourceCanonicalization(t *testing.T) {
	for _, test := range []struct{ input, source, origin, entry string }{
		{"http://localhost:80#section", "http://127.0.0.1/", "http://localhost", "/"},
		{"https://127.0.0.1:443/demo?q=1#section", "https://127.0.0.1/demo?q=1", "https://127.0.0.1", "/demo?q=1"},
		{"http://[::1]:80/demo", "http://[::1]/demo", "http://[::1]", "/demo"},
		{"https://[::1]:443/", "https://[::1]/", "https://[::1]", "/"},
		{"http://[::1]:5173/demo", "http://[::1]:5173/demo", "http://[::1]:5173", "/demo"},
	} {
		t.Run(test.input, func(t *testing.T) {
			source, origin, entry := shareSource("server", test.input)
			if source != test.source || origin != test.origin || entry != test.entry {
				t.Fatalf("got %q %q %q; want %q %q %q", source, origin, entry, test.source, test.origin, test.entry)
			}
		})
	}
}

func TestPreviewShareDuration(t *testing.T) {
	if previewShareMinutes(M{}) != 30 {
		t.Fatal("default duration")
	}
	for _, value := range []float64{1, 30, 1440, 525600} {
		if previewShareMinutes(M{"durationMinutes": value}) != int64(value) {
			t.Fatal(value)
		}
	}
	for _, value := range []any{nil, "30", true, 0.0, -1.0, 0.5, 525601.0, math.NaN(), math.Inf(1)} {
		expectFault(t, "invalid-preview-share-duration", func() { previewShareMinutes(M{"durationMinutes": value}) })
	}
}

func insertShare(store *Store, p *Principal, device, key string, expires int64) {
	store.Q("INSERT INTO preview_shares(id,user_id,device_id,thread_id,kind,source,origin,entry_path,token,enabled,created_at,expires_at,duration_minutes) VALUES($1,$2,$3,'thread-test','server','http://localhost:5173/','http://localhost:5173','/',$4,TRUE,$5,$6,30)", uuid(), p.ID, device, key, now(), expires)
}

func TestPreviewShareExpirationAndExtension(t *testing.T) {
	store, s, p, device := fixture(t)
	key := strings.Repeat("a", 64)
	deadline := now() + 200
	insertShare(store, p, device, key, deadline)
	principal := &Principal{ID: p.ID, Kind: "user", Share: key}
	pending := []*Pending{}
	for _, kind := range []string{"preview", "preview-socket", "file"} {
		v := &Pending{ID: uuid(), Kind: kind, Device: device, Principal: principal}
		s.addPending(v, 100, 100)
		pending = append(pending, v)
	}
	s.mu.Lock()
	s.previews["guest"] = &Preview{Principal: principal}
	s.mu.Unlock()
	// An earlier timer must reread the persisted extension and leave guests alone.
	extended := now() + 5000
	store.Q("UPDATE preview_shares SET expires_at=$1 WHERE token=$2", extended, key)
	s.armPreviewShare(key, extended)
	eventually(t, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		timer := s.shareTimers[key]
		return timer != nil && timer.expires == extended
	})
	for _, v := range pending {
		select {
		case err := <-v.Failure:
			t.Fatal("extension disconnected visitor", err)
		default:
		}
	}
	s.mu.Lock()
	guest := s.previews["guest"]
	s.mu.Unlock()
	if guest == nil {
		t.Fatal("extension removed guest")
	}
	// Shortening replaces the old timer, and every type of in-flight transfer ends.
	shortened := now() + 100
	store.Q("UPDATE preview_shares SET expires_at=$1 WHERE token=$2", shortened, key)
	s.armPreviewShare(key, shortened)
	for _, v := range pending {
		select {
		case err := <-v.Failure:
			if f, ok := err.(Fault); !ok || f.Code != "preview-share-disabled" {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("expired transfer stayed open")
		}
	}
	if store.PublicPreviewShare(key) != nil {
		t.Fatal("expired share accessible")
	}
	s.mu.Lock()
	remaining := len(s.pending) + len(s.previews) + len(s.shareTimers)
	s.mu.Unlock()
	if remaining != 0 {
		t.Fatal("expired resources retained", remaining)
	}
	expectFault(t, "preview-share-disabled", func() {
		s.addPending(&Pending{ID: uuid(), Kind: "preview", Device: device, Principal: principal}, 100, 100)
	})
	recorder := httptest.NewRecorder()
	s.Handler().ServeHTTP(recorder, httptest.NewRequest("GET", "/share/"+key, nil))
	if recorder.Code != 410 {
		t.Fatal(recorder.Code)
	}
}

func TestPreviewShareLegacyMigrationAndRestart(t *testing.T) {
	directory := t.TempDir()
	store, err := Open("", directory)
	if err != nil {
		t.Fatal(err)
	}
	user := store.CreateUser("legacy-owner", "test-password-12345", "user")
	principal := &Principal{ID: str(user["id"]), Kind: "user"}
	device := store.Register(principal.ID, uuid(), "PC", "windows")
	key := strings.Repeat("b", 64)
	insertShare(store, principal, device, key, now()+60000)
	created := now() - 3600000
	store.Q("UPDATE preview_shares SET created_at=$1", created)
	store.Q("ALTER TABLE preview_shares DROP COLUMN expires_at")
	store.Q("ALTER TABLE preview_shares DROP COLUMN duration_minutes")
	store.Close()
	for i := 0; i < 2; i++ {
		store, err = Open("", directory)
		if err != nil {
			t.Fatal(err)
		}
		row := store.One("SELECT * FROM preview_shares WHERE token=$1", key)
		if num(row["expires_at"]) != created+1800000 || num(row["duration_minutes"]) != 30 {
			t.Fatal("migration renewed share", row)
		}
		if store.PublicPreviewShare(key) != nil || boolean(shareResult(row)["enabled"]) {
			t.Fatal("expired legacy share accessible")
		}
		store.Close()
	}
}
