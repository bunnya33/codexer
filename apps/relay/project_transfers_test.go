package relay

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

type transferFixture struct {
	store                                          *Store
	server                                         *Server
	source, target, user, sourceToken, targetToken string
	request                                        M
}

func transferTest(t *testing.T) *transferFixture {
	t.Helper()
	store, s, p, source := fixture(t)
	target := store.Register(p.ID, uuid(), "Target", "win32")
	token := str(store.CreateSession(p.ID, "")["session"])
	sourceToken := str(store.CreateSession(p.ID, source)["session"])
	targetToken := str(store.CreateSession(p.ID, target)["session"])
	store.SaveCatalog(M{"deviceId": source, "projects": []any{M{"id": "project", "name": "Sample", "roots": []any{"/work/sample"}}}, "threads": []any{}, "projectTransfer": true})
	store.SaveCatalog(M{"deviceId": target, "projects": []any{}, "threads": []any{}, "projectTransfer": true, "projectCreation": M{"parents": []any{M{"id": "parent", "path": "F:/Projects"}}}})
	s.agents[source] = &Peer{s: s, done: make(chan struct{}), queue: make(chan []byte, 10)}
	s.agents[target] = &Peer{s: s, done: make(chan struct{}), queue: make(chan []byte, 10)}
	request := M{"id": uuid(), "sourceDeviceId": source, "targetDeviceId": target, "projectId": "project", "parentId": "parent", "relativePath": "received-project", "options": M{"includeGit": true, "includeLocalFiles": false, "excludedDirectories": []any{"node_modules"}, "note": "Resume later"}}
	return &transferFixture{store, s, source, target, token, sourceToken, targetToken, request}
}
func (f *transferFixture) call(t *testing.T, method, path, token, device string, value any, want int) M {
	t.Helper()
	b := []byte{}
	if value != nil {
		if raw, ok := value.([]byte); ok {
			b = raw
		} else {
			b = []byte(js(value))
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	r.Header.Set("Authorization", "Bearer "+token)
	if device != "" {
		r.Header.Set("x-device-id", device)
	}
	w := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	if w.Code != want {
		t.Fatalf("%s %s: %d %s (want %d)", method, path, w.Code, w.Body.String(), want)
	}
	var result M
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if result == nil {
		result = M{"bytes": w.Body.Bytes()}
	}
	return result
}
func (f *transferFixture) create(t *testing.T) string {
	f.call(t, "POST", "/v1/project-transfers", f.user, "", f.request, 200)
	return str(f.request["id"])
}
func (f *transferFixture) base(device, id string) string {
	return "/v1/agent/" + device + "/project-transfers/" + id
}
func (f *transferFixture) ready(t *testing.T, id string, b []byte) {
	digest := sha256.Sum256(b)
	f.call(t, "POST", f.base(f.source, id)+"/status", f.sourceToken, f.source, M{"state": "ready", "size": len(b), "sha256": hex.EncodeToString(digest[:]), "files": 2, "directories": 1, "excluded": 1, "excludedSamples": []any{"node_modules"}, "roots": []any{""}}, 200)
}
func TestProjectTransferScopedResumeAndReceiveWithoutDevelopment(t *testing.T) {
	f := transferTest(t)
	id := f.create(t)
	base := f.base(f.source, id)
	target := f.base(f.target, id)
	// Same creation id is safe after an ambiguous network outcome.
	f.call(t, "POST", "/v1/project-transfers", f.user, "", f.request, 200)
	changed := M{}
	for k, v := range f.request {
		changed[k] = v
	}
	changed["relativePath"] = "other"
	f.call(t, "POST", "/v1/project-transfers", f.user, "", changed, 409)
	f.call(t, "POST", "/v1/project-transfers/"+id+"/start", f.user, "", M{}, 409)
	payload := bytes.Repeat([]byte("uncommitted and untracked content\x00"), 30000)
	f.ready(t, id, payload)
	if got := f.call(t, "POST", "/v1/project-transfers/"+id+"/start", f.user, "", M{}, 200); got["state"] != "uploading" {
		t.Fatal(got)
	}
	f.call(t, "PUT", base+"/chunk?offset=1", f.sourceToken, f.source, payload[:projectTransferChunk], 409)
	f.call(t, "PUT", target+"/chunk?offset=0", f.targetToken, f.target, payload[:projectTransferChunk], 409)
	f.call(t, "GET", base+"/chunk?offset=0", f.sourceToken, f.source, nil, 409)
	// Source credentials cannot impersonate the destination, even on this account.
	f.call(t, "GET", target, f.sourceToken, f.target, nil, 401)
	first := f.call(t, "PUT", base+"/chunk?offset=0", f.sourceToken, f.source, payload[:projectTransferChunk], 200)
	if num(first["uploaded"]) != projectTransferChunk {
		t.Fatal(first)
	}
	// A lost chunk acknowledgement is resolved by reading the durable offset.
	f.call(t, "PUT", base+"/chunk?offset=0", f.sourceToken, f.source, payload[:projectTransferChunk], 409)
	next := f.call(t, "GET", base, f.sourceToken, f.source, nil, 200)
	if num(next["uploaded"]) != projectTransferChunk {
		t.Fatal(next)
	}
	f.call(t, "PUT", base+"/chunk?offset=524288", f.sourceToken, f.source, payload[projectTransferChunk:], 200)
	f.call(t, "POST", base+"/uploaded", f.sourceToken, f.source, M{}, 200)
	received := []byte{}
	for offset := 0; offset < len(payload); offset += projectTransferChunk {
		path := target + "/chunk?offset=" + str(offset)
		got := f.call(t, "GET", path, f.targetToken, f.target, nil, 200)
		received = append(received, got["bytes"].([]byte)...)
	}
	if !bytes.Equal(received, payload) {
		t.Fatal("content changed in transit")
	}
	f.call(t, "POST", target+"/status", f.targetToken, f.target, M{"state": "downloaded", "downloaded": len(payload)}, 200)
	// A receiver may redownload after a restart without regressing UI progress.
	f.call(t, "POST", target+"/status", f.targetToken, f.target, M{"state": "downloaded", "downloaded": 0}, 200)
	f.call(t, "POST", target+"/status", f.targetToken, f.target, M{"state": "received", "savedPath": "F:/Projects/received-project"}, 409)
	f.call(t, "POST", target+"/status", f.targetToken, f.target, M{"state": "installing"}, 200)
	f.call(t, "POST", "/v1/project-transfers/"+id+"/cancel", f.user, "", M{}, 409)
	f.call(t, "POST", target+"/status", f.targetToken, f.target, M{"state": "received", "savedPath": "F:/escape"}, 400)
	got := f.call(t, "POST", target+"/status", f.targetToken, f.target, M{"state": "received", "savedPath": "F:/Projects/received-project"}, 200)
	if got["state"] != "received" || num(got["downloaded"]) != int64(len(payload)) {
		t.Fatal(got)
	}
	f.call(t, "POST", target+"/status", f.targetToken, f.target, M{"state": "completed", "targetProjectId": "new-project"}, 200)
	if _, err := os.Stat(f.server.projectTransfers.path(id, ".data")); !os.IsNotExist(err) {
		t.Fatal("completed payload retained", err)
	}
	for _, device := range []string{f.source, f.target} {
		peer := f.server.agent(device)
		if len(peer.queue) != 0 {
			t.Fatal("transfer started a runtime command")
		}
	}
}
func TestProjectTransferOwnershipCancellationExpiryAndHash(t *testing.T) {
	t.Run("ownership and revocation", func(t *testing.T) {
		f := transferTest(t)
		id := f.create(t)
		other := f.store.CreateUser("other", "test-password-12345", "user")
		token := str(f.store.CreateSession(str(other["id"]), "")["session"])
		if len(list(f.call(t, "GET", "/v1/project-transfers", token, "", nil, 200)["transfers"])) != 0 {
			t.Fatal("cross-account listing")
		}
		f.call(t, "POST", "/v1/project-transfers/"+id+"/cancel", token, "", M{}, 404)
		f.call(t, "POST", "/v1/project-transfers", f.sourceToken, f.source, f.request, 401)
		f.store.ResetUser(str(other["id"]), "new-password-12345", "user")
		f.call(t, "GET", "/v1/project-transfers", token, "", nil, 401)
	})
	t.Run("cancel and expire", func(t *testing.T) {
		f := transferTest(t)
		id := f.create(t)
		f.ready(t, id, []byte("test"))
		f.call(t, "POST", "/v1/project-transfers/"+id+"/cancel", f.user, "", M{}, 200)
		f.call(t, "PUT", f.base(f.source, id)+"/chunk?offset=0", f.sourceToken, f.source, []byte("test"), 409)
		j := f.server.projectTransfers.lookup(id)
		j.mu.Lock()
		j.Expires = now() - 1
		j.mu.Unlock()
		f.server.projectTransfers.cleanup()
		f.call(t, "GET", f.base(f.source, id), f.sourceToken, f.source, nil, 404)
	})
	t.Run("hash mismatch", func(t *testing.T) {
		f := transferTest(t)
		id := f.create(t)
		f.ready(t, id, []byte("good"))
		f.call(t, "POST", "/v1/project-transfers/"+id+"/start", f.user, "", M{}, 200)
		f.call(t, "PUT", f.base(f.source, id)+"/chunk?offset=0", f.sourceToken, f.source, []byte("evil"), 200)
		got := f.call(t, "POST", f.base(f.source, id)+"/uploaded", f.sourceToken, f.source, M{}, 200)
		if got["state"] != "failed" || got["code"] != "project-transfer-checksum-mismatch" {
			t.Fatal(got)
		}
		f.call(t, "GET", f.base(f.target, id)+"/chunk?offset=0", f.targetToken, f.target, nil, 409)
	})
	t.Run("parent revoked", func(t *testing.T) {
		f := transferTest(t)
		id := f.create(t)
		f.ready(t, id, []byte("test"))
		f.store.SaveCatalog(M{"deviceId": f.target, "projects": []any{}, "threads": []any{}, "projectTransfer": true})
		f.call(t, "POST", "/v1/project-transfers/"+id+"/start", f.user, "", M{}, 409)
	})
}
func TestProjectTransferStoreSurvivesRestartAndEnforcesCapacity(t *testing.T) {
	directory := t.TempDir()
	store, err := newProjectTransferStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	j := &projectTransfer{ID: uuid(), Owner: "owner", State: "uploading", Size: 100, Uploaded: 7, Expires: now() + projectTransferLifetime, Roots: []string{""}, ExcludedSamples: []string{}}
	store.persist(j)
	store.jobs[j.ID] = j
	if err = os.WriteFile(store.path(j.ID, ".data"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	reloaded, err := newProjectTransferStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	loaded := reloaded.lookup(j.ID)
	if loaded.Uploaded != 7 || loaded.State != "uploading" {
		t.Fatal("resume offset lost")
	}
	if b, err := os.ReadFile(reloaded.path(j.ID, ".data")); err != nil || string(b) != "partial" {
		t.Fatal(err)
	}
	f := transferTest(t)
	f.create(t)
	f.request["id"] = uuid()
	f.create(t)
	f.request["id"] = uuid()
	f.call(t, "POST", "/v1/project-transfers", f.user, "", f.request, 429)
	for _, name := range []string{"../escape", "C:\\escape", "CON", "test.", "a/b", ".."} {
		if validTransferName(name) {
			t.Fatal(name)
		}
	}
	if !validTransferName("中文项目") || strings.Contains(string(js(loaded.view())), "owner") {
		t.Fatal("invalid public metadata")
	}
}
