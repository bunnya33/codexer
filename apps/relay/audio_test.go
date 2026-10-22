package relay

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAudioByteRanges(t *testing.T) {
	for _, tc := range []struct {
		rangeHeader      string
		size, start, end int64
		partial, valid   bool
	}{
		{"", 100, 0, 99, false, true}, {"", 0, 0, -1, false, true},
		{"bytes=0-1", 100, 0, 1, true, true}, {"bytes=50-", 100, 50, 99, true, true},
		{"bytes=98-500", 100, 98, 99, true, true}, {"bytes=-10", 100, 90, 99, true, true},
		{"bytes=-1000", 100, 0, 99, true, true}, {" BYTES=9-9 ", 100, 9, 9, true, true},
		{"bytes=0-0", 0, 0, 0, true, false}, {"bytes=100-", 100, 0, 0, true, false},
		{"bytes=3-2", 100, 0, 0, true, false}, {"bytes=-0", 100, 0, 0, true, false},
		{"bytes=-", 100, 0, 0, true, false}, {"bytes=0-1,3-4", 100, 0, 0, true, false},
		{"bytes=999999999999999999999999-", 100, 0, 0, true, false},
		{"bytes=-999999999999999999999999", 100, 0, 0, true, false},
		{"bytes=0-999999999999999999999999", 100, 0, 0, true, false},
		{"items=0-1", 100, 0, 0, true, false}, {"bytes=+1-2", 100, 0, 0, true, false},
	} {
		start, end, partial, valid := audioRange(tc.rangeHeader, tc.size)
		if partial != tc.partial || valid != tc.valid || valid && (start != tc.start || end != tc.end) {
			t.Fatalf("%q size %d: %d-%d partial=%v valid=%v", tc.rangeHeader, tc.size, start, end, partial, valid)
		}
	}
}

func TestPublicAudioSourceAndTransferScope(t *testing.T) {
	for _, source := range []string{`C:\Music\中文 sample.WAV`, "/tmp/music.mp3"} {
		path, origin, entry := shareSource("audio", source)
		if path != source || origin != "" || entry != "/audio" {
			t.Fatal("audio share source changed")
		}
	}
	for _, source := range []string{"", "/tmp/file.html", "/tmp/a.wav\n", "/tmp/a\x00.wav", strings.Repeat("a", 4097) + ".wav"} {
		expectFault(t, "invalid-preview-source", func() { shareSource("audio", source) })
	}
	store, s, owner, device := fixture(t)
	store.SaveCatalog(M{"deviceId": device, "threads": []any{M{"id": "thread-test", "archived": false}}})
	key := strings.Repeat("c", 64)
	insertShare(store, owner, device, key, now()+60000)
	store.Q("UPDATE preview_shares SET kind='audio',source='/tmp/music.wav' WHERE token=$1", key)
	p := &Principal{ID: owner.ID, Kind: "user", Share: key}
	r := httptest.NewRequest("GET", "/", nil)
	r.SetPathValue("deviceId", device)
	r.SetPathValue("threadId", "thread-test")
	// A valid source reaches the offline Agent check; capabilities cannot request
	// another file, thread history, or read files using a server-preview key.
	expectFault(t, "device-offline", func() { s.requestTransfer(r, p, "file", M{"path": "/tmp/music.wav"}) })
	expectFault(t, "preview-share-disabled", func() { s.requestTransfer(r, p, "file", M{"path": "/tmp/other.wav"}) })
	expectFault(t, "preview-share-disabled", func() { s.requestTransfer(r, p, "history", M{}) })
	store.Q("UPDATE preview_shares SET kind='server' WHERE token=$1", key)
	expectFault(t, "preview-share-disabled", func() { s.requestTransfer(r, p, "file", M{"path": "/tmp/music.wav"}) })
}

func TestAudioExpiryAndSessionRevocation(t *testing.T) {
	_, s, p, _ := fixture(t)
	token := strings.Repeat("a", 64)
	ctx, cancel := context.WithCancel(s.ctx)
	s.mu.Lock()
	s.audio[token] = &AudioPlayback{Principal: p, Expires: now() - 1, ctx: ctx, cancel: cancel}
	s.mu.Unlock()
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/audio/"+token, nil))
	if w.Code != 410 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("expired playback should be rejected without contacting the Agent")
	}
	s.CloseSessions(func(principal *Principal) bool { return principal.Hash == p.Hash }, "logout")
	if ctx.Err() != context.Canceled {
		t.Fatal("revocation must cancel active playback contexts")
	}
	s.mu.Lock()
	remaining := len(s.audio)
	s.mu.Unlock()
	if remaining != 0 {
		t.Fatal("revoked capabilities retained")
	}
}

func TestAudioRevokeRequiresOriginalSessionForBothAccountRoles(t *testing.T) {
	for _, role := range []string{"user", "admin"} {
		t.Run(role, func(t *testing.T) {
			store, s, _, _ := fixture(t)
			account := store.CreateUser("audio-"+role, "test-password-12345", role)
			owner := str(store.CreateSession(str(account["id"]), "")["session"])
			other := str(store.CreateSession(str(account["id"]), "")["session"])
			ctx, cancel := context.WithCancel(s.ctx)
			token := strings.Repeat("b", 64)
			s.mu.Lock()
			s.audio[token] = &AudioPlayback{Principal: store.Session(owner, ""), Expires: now() + 60000, ctx: ctx, cancel: cancel}
			s.mu.Unlock()
			for _, session := range []string{other, owner} {
				w := httptest.NewRecorder()
				r := httptest.NewRequest("DELETE", "/v1/audio/"+token, nil)
				r.Header.Set("Authorization", "Bearer "+session)
				s.Handler().ServeHTTP(w, r)
				if session == other {
					if w.Code != 404 || ctx.Err() != nil {
						t.Fatal("another session must not revoke playback, even for the same account")
					}
				} else if w.Code != 200 || ctx.Err() != context.Canceled {
					t.Fatal("the original session must revoke playback for either account role")
				}
			}
		})
	}
}
