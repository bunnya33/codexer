package relay

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const projectTransferChunk = 512 * 1024
const maxProjectTransferSize int64 = 4 * 1024 * 1024 * 1024
const projectTransferLifetime int64 = 24 * 60 * 60 * 1000

type projectTransfer struct {
	mu              sync.Mutex
	Owner           string   `json:"owner"`
	RequestHash     string   `json:"requestHash"`
	ID              string   `json:"id"`
	Source          string   `json:"sourceDeviceId"`
	Target          string   `json:"targetDeviceId"`
	Project         string   `json:"projectId"`
	Name            string   `json:"name"`
	Parent          string   `json:"parentId"`
	ParentPath      string   `json:"parentPath"`
	Relative        string   `json:"relativePath"`
	Options         M        `json:"options"`
	Preparation     M        `json:"preparation,omitempty"`
	State           string   `json:"state"`
	Size            int64    `json:"size"`
	Uploaded        int64    `json:"uploaded"`
	Downloaded      int64    `json:"downloaded"`
	SHA256          string   `json:"sha256"`
	Files           int64    `json:"files"`
	Directories     int64    `json:"directories"`
	Excluded        int64    `json:"excluded"`
	ExcludedSamples []string `json:"excludedSamples"`
	Roots           []string `json:"roots"`
	SavedPath       string   `json:"savedPath"`
	TargetProject   string   `json:"targetProjectId"`
	Code            string   `json:"code"`
	Created         int64    `json:"createdAt"`
	Updated         int64    `json:"updatedAt"`
	Expires         int64    `json:"expiresAt"`
}
type projectTransferStore struct {
	mu        sync.Mutex
	directory string
	temporary bool
	jobs      map[string]*projectTransfer
}

func newProjectTransferStore(directory string) (*projectTransferStore, error) {
	temporary := directory == ""
	var err error
	if temporary {
		directory, err = os.MkdirTemp("", "codexer-project-transfers-")
	} else {
		directory = filepath.Join(directory, "project-transfers")
		err = os.MkdirAll(directory, 0700)
	}
	if err != nil {
		return nil, err
	}
	result := &projectTransferStore{directory: directory, temporary: temporary, jobs: map[string]*projectTransfer{}}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !uuidPattern.MatchString(id) {
			continue
		}
		b, e := os.ReadFile(filepath.Join(directory, entry.Name()))
		if e != nil {
			return nil, e
		}
		var job projectTransfer
		if json.Unmarshal(b, &job) != nil || job.ID != id {
			return nil, io.ErrUnexpectedEOF
		}
		result.jobs[id] = &job
	}
	result.cleanup()
	return result, nil
}
func (s *projectTransferStore) path(id, suffix string) string {
	if !uuidPattern.MatchString(id) {
		fail(404, "project-transfer-unavailable")
	}
	return filepath.Join(s.directory, id+suffix)
}
func (s *projectTransferStore) persist(j *projectTransfer) {
	j.Updated = now()
	b, err := json.Marshal(j)
	if err != nil {
		panic(err)
	}
	path := s.path(j.ID, ".json")
	f, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		panic(err)
	}
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		panic(err)
	}
	if err = os.Rename(path+".tmp", path); err != nil {
		panic(err)
	}
}
func (j *projectTransfer) view() M {
	b, _ := json.Marshal(j)
	var result M
	_ = json.Unmarshal(b, &result)
	delete(result, "owner")
	delete(result, "requestHash")
	return result
}
func transferTerminal(state string) bool {
	return state == "completed" || state == "failed" || state == "cancelled"
}
func (s *projectTransferStore) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, j := range s.jobs {
		j.mu.Lock()
		if j.Expires <= now() {
			// An expired transfer never authorizes another write on the target.
			for _, suffix := range []string{".data", ".json.tmp", ".json"} {
				if err := os.Remove(s.path(id, suffix)); err != nil && !os.IsNotExist(err) {
					j.mu.Unlock()
					panic(err)
				}
			}
			delete(s.jobs, id)
		}
		j.mu.Unlock()
	}
}
func (s *projectTransferStore) close() {
	if s != nil && s.temporary {
		_ = os.RemoveAll(s.directory)
	}
}
func (s *projectTransferStore) lookup(id string) *projectTransfer {
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.jobs[id]
	if j == nil {
		fail(404, "project-transfer-unavailable")
	}
	return j
}

var portableTransferName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)`)

func validTransferName(name string) bool {
	return name != "" && name != "." && name != ".." && jsLength(name) <= 100 && !strings.ContainsAny(name, "/\\<>:\"|?*") && strings.IndexFunc(name, func(r rune) bool { return r < 32 }) < 0 && !strings.HasSuffix(name, ".") && !strings.HasSuffix(name, " ") && !portableTransferName.MatchString(name)
}
func (s *Server) transferCatalog(device string) M {
	row := s.Store.One("SELECT payload FROM catalogs WHERE device_id=$1", device)
	if row == nil {
		fail(409, "project-transfer-update-required")
	}
	catalog := obj(row["payload"])
	if catalog["projectTransfer"] != true {
		fail(409, "project-transfer-update-required")
	}
	return catalog
}
func (s *Server) transferParent(j *projectTransfer) {
	for _, v := range list(obj(s.transferCatalog(j.Target)["projectCreation"])["parents"]) {
		p := obj(v)
		if p["id"] == j.Parent && p["path"] == j.ParentPath {
			return
		}
	}
	fail(409, "project-parent-not-authorized")
}

// Account changes take the exclusive write barrier. Every transfer request
// rechecks both device owners, including scoped Agent requests after reconnect.
func (s *Server) transferAccess(p *Principal, j *projectTransfer, agent string) {
	owner := &Principal{ID: p.ID, Kind: "user"}
	if p.ID != j.Owner || j.Expires <= now() || !s.Store.Owns(j.Source, owner) || !s.Store.Owns(j.Target, owner) || agent != "" && agent != j.Source && agent != j.Target {
		fail(404, "project-transfer-unavailable")
	}
}
func (s *Server) transferAgent(r *http.Request) *Principal {
	device := r.PathValue("deviceId")
	value := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	p := s.Store.Session(value, device)
	if p == nil || p.Device != device || r.Header.Get("x-device-id") != device {
		fail(401, "unauthorized")
	}
	return p
}
func (s *Server) projectTransferRoutes() {
	s.route("POST /v1/project-transfers", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		b := body(r)
		s.Validate("projectTransfer", b)
		if b["sourceDeviceId"] == b["targetDeviceId"] || !validTransferName(str(b["relativePath"])) {
			fail(400, "project-path-invalid")
		}
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		if s.Store.SessionHash(p.Hash, "") == nil {
			fail(401, "unauthorized")
		}
		s.authorizeProject(p, str(b["sourceDeviceId"]), str(b["projectId"]))
		if !s.Store.Owns(str(b["targetDeviceId"]), p) {
			fail(404, "device-not-found")
		}
		source := s.transferCatalog(str(b["sourceDeviceId"]))
		target := s.transferCatalog(str(b["targetDeviceId"]))
		j := &projectTransfer{Owner: p.ID, RequestHash: hash(js(b)), ID: str(b["id"]), Source: str(b["sourceDeviceId"]), Target: str(b["targetDeviceId"]), Project: str(b["projectId"]), Parent: str(b["parentId"]), Relative: str(b["relativePath"]), Options: obj(b["options"]), State: "preparing", Created: now(), Expires: now() + projectTransferLifetime, ExcludedSamples: []string{}, Roots: []string{}}
		for _, v := range list(source["projects"]) {
			if obj(v)["id"] == j.Project {
				j.Name = str(obj(v)["name"])
			}
		}
		for _, v := range list(obj(target["projectCreation"])["parents"]) {
			if obj(v)["id"] == j.Parent {
				j.ParentPath = str(obj(v)["path"])
			}
		}
		if j.ParentPath == "" {
			fail(409, "project-parent-not-authorized")
		}
		store := s.projectTransfers
		store.cleanup()
		store.mu.Lock()
		defer store.mu.Unlock()
		if previous := store.jobs[j.ID]; previous != nil {
			previous.mu.Lock()
			defer previous.mu.Unlock()
			if previous.Owner != p.ID || previous.RequestHash != j.RequestHash {
				fail(409, "project-transfer-id-reused")
			}
			return previous.view()
		}
		active, owned := 0, 0
		for _, v := range store.jobs {
			v.mu.Lock()
			if !transferTerminal(v.State) {
				active++
				if v.Owner == p.ID {
					owned++
				}
			}
			v.mu.Unlock()
		}
		if active >= 4 || owned >= 2 || len(store.jobs) >= 1000 {
			fail(429, "project-transfer-busy")
		}
		if s.agent(j.Source) == nil || s.agent(j.Target) == nil {
			fail(409, "device-offline")
		}
		store.persist(j)
		store.jobs[j.ID] = j
		return j.view()
	})
	s.route("GET /v1/project-transfers", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		if s.Store.SessionHash(p.Hash, "") == nil {
			fail(401, "unauthorized")
		}
		return s.transferList(p, "")
	})
	for _, action := range []string{"start", "cancel"} {
		action := action
		s.route("POST /v1/project-transfers/{transferId}/"+action, "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
			s.exclusive.RLock()
			defer s.exclusive.RUnlock()
			if s.Store.SessionHash(p.Hash, "") == nil {
				fail(401, "unauthorized")
			}
			j := s.projectTransfers.lookup(r.PathValue("transferId"))
			j.mu.Lock()
			defer j.mu.Unlock()
			s.transferAccess(p, j, "")
			if action == "start" {
				if j.State == "ready" {
					s.transferParent(j)
					j.State = "uploading"
					s.projectTransfers.persist(j)
				} else if j.State == "preparing" || transferTerminal(j.State) {
					fail(409, "project-transfer-state-changed")
				}
			} else if !transferTerminal(j.State) {
				if j.State == "installing" || j.State == "received" {
					fail(409, "project-transfer-already-saved")
				}
				j.State = "cancelled"
				s.projectTransfers.persist(j)
				_ = os.Remove(s.projectTransfers.path(j.ID, ".data"))
			}
			return j.view()
		})
	}
	agentBase := "/v1/agent/{deviceId}/project-transfers"
	s.route("GET "+agentBase, "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		p := s.transferAgent(r)
		return s.transferList(p, p.Device)
	})
	s.route("GET "+agentBase+"/{transferId}", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		p := s.transferAgent(r)
		j := s.projectTransfers.lookup(r.PathValue("transferId"))
		j.mu.Lock()
		defer j.mu.Unlock()
		s.transferAccess(p, j, p.Device)
		return j.view()
	})
	s.route("POST "+agentBase+"/{transferId}/status", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		b := body(r)
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		p := s.transferAgent(r)
		j := s.projectTransfers.lookup(r.PathValue("transferId"))
		j.mu.Lock()
		defer j.mu.Unlock()
		s.transferAccess(p, j, p.Device)
		state := str(b["state"])
		if transferTerminal(j.State) {
			return j.view()
		}
		switch state {
		case "preparing":
			if p.Device != j.Source || j.State != "preparing" {
				fail(409, "project-transfer-state-changed")
			}
			preparation := obj(b["preparation"])
			s.Validate("projectTransferPreparation", preparation)
			preparation["updatedAt"] = now()
			j.Preparation = preparation
		case "ready":
			if p.Device != j.Source || j.State != "preparing" {
				fail(409, "project-transfer-state-changed")
			}
			size := num(b["size"])
			files, dirs, excluded := num(b["files"]), num(b["directories"]), num(b["excluded"])
			if size < 1 || size > maxProjectTransferSize || !hex64.MatchString(str(b["sha256"])) || files < 0 || dirs < 0 || files+dirs > 100000 || excluded < 0 || len(list(b["roots"])) < 1 || len(list(b["roots"])) > 20 || len(list(b["excludedSamples"])) > 30 {
				fail(400, "invalid-project-snapshot")
			}
			roots := []string{}
			for _, v := range list(b["roots"]) {
				root := str(v)
				if root != "" && !validTransferName(root) {
					fail(400, "invalid-project-snapshot")
				}
				roots = append(roots, root)
			}
			samples := []string{}
			for _, v := range list(b["excludedSamples"]) {
				if jsLength(str(v)) > 4096 {
					fail(400, "invalid-project-snapshot")
				}
				samples = append(samples, str(v))
			}
			j.Size = size
			j.SHA256 = str(b["sha256"])
			j.Files = files
			j.Directories = dirs
			j.Excluded = excluded
			j.ExcludedSamples = samples
			j.Roots = roots
			j.State = "ready"
		case "downloaded":
			if p.Device != j.Target || j.State != "downloading" || num(b["downloaded"]) < 0 || num(b["downloaded"]) > j.Size {
				fail(409, "project-transfer-state-changed")
			}
			j.Downloaded = max(j.Downloaded, num(b["downloaded"]))
		case "installing":
			if p.Device != j.Target || j.State != "downloading" && j.State != "installing" {
				fail(409, "project-transfer-state-changed")
			}
			s.transferParent(j)
			j.State = "installing"
		case "received":
			if p.Device != j.Target || j.State != "installing" && j.State != "received" {
				fail(409, "project-transfer-state-changed")
			}
			expected := strings.TrimRight(j.ParentPath, "/\\") + "/" + j.Relative
			if strings.ReplaceAll(str(b["savedPath"]), "\\", "/") != strings.ReplaceAll(expected, "\\", "/") {
				fail(400, "project-path-invalid")
			}
			j.State = "received"
			j.SavedPath = str(b["savedPath"])
			j.Downloaded = j.Size
		case "completed":
			if p.Device != j.Target || j.State != "received" || !validID(str(b["targetProjectId"])) {
				fail(409, "project-transfer-state-changed")
			}
			j.State = "completed"
			j.TargetProject = str(b["targetProjectId"])
		case "failed":
			if j.State == "received" {
				fail(409, "project-transfer-already-saved")
			}
			code := str(b["code"])
			if !strings.HasPrefix(code, "project-") || len(code) > 120 {
				code = "project-transfer-failed"
			}
			j.State = "failed"
			j.Code = code
		default:
			fail(400, "invalid-request")
		}
		s.projectTransfers.persist(j)
		if j.State == "completed" || j.State == "failed" {
			_ = os.Remove(s.projectTransfers.path(j.ID, ".data"))
		}
		return j.view()
	})
	s.route("PUT "+agentBase+"/{transferId}/chunk", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		b, err := io.ReadAll(io.LimitReader(r.Body, projectTransferChunk+1))
		if err != nil || len(b) < 1 || len(b) > projectTransferChunk {
			fail(400, "invalid-project-chunk")
		}
		offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
		if err != nil || offset < 0 {
			fail(400, "invalid-project-chunk")
		}
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		p := s.transferAgent(r)
		j := s.projectTransfers.lookup(r.PathValue("transferId"))
		j.mu.Lock()
		defer j.mu.Unlock()
		s.transferAccess(p, j, p.Device)
		if p.Device != j.Source || j.State != "uploading" {
			fail(409, "project-transfer-state-changed")
		}
		if offset != j.Uploaded || int64(len(b)) != min(int64(projectTransferChunk), j.Size-offset) {
			fail(409, "project-transfer-offset-mismatch")
		}
		f, err := os.OpenFile(s.projectTransfers.path(j.ID, ".data"), os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			panic(err)
		}
		_, err = f.WriteAt(b, offset)
		if err == nil {
			err = f.Sync()
		}
		_ = f.Close()
		if err != nil {
			panic(err)
		}
		j.Uploaded += int64(len(b))
		s.projectTransfers.persist(j)
		return j.view()
	})
	s.route("POST "+agentBase+"/{transferId}/uploaded", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		p := s.transferAgent(r)
		j := s.projectTransfers.lookup(r.PathValue("transferId"))
		j.mu.Lock()
		defer j.mu.Unlock()
		s.transferAccess(p, j, p.Device)
		if p.Device != j.Source {
			fail(404, "project-transfer-unavailable")
		}
		if j.State == "downloading" || j.State == "installing" || j.State == "received" || j.State == "completed" {
			return j.view()
		}
		if j.State != "uploading" || j.Uploaded != j.Size {
			fail(409, "project-transfer-offset-mismatch")
		}
		f, err := os.Open(s.projectTransfers.path(j.ID, ".data"))
		if err != nil {
			panic(err)
		}
		digest := sha256.New()
		n, err := io.Copy(digest, f)
		_ = f.Close()
		if err != nil {
			panic(err)
		}
		if n != j.Size || hex.EncodeToString(digest.Sum(nil)) != j.SHA256 {
			j.State = "failed"
			j.Code = "project-transfer-checksum-mismatch"
		} else {
			j.State = "downloading"
		}
		s.projectTransfers.persist(j)
		if j.State == "failed" {
			_ = os.Remove(s.projectTransfers.path(j.ID, ".data"))
		}
		return j.view()
	})
	s.route("GET "+agentBase+"/{transferId}/chunk", "", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
		if err != nil || offset < 0 {
			fail(400, "invalid-project-chunk")
		}
		s.exclusive.RLock()
		defer s.exclusive.RUnlock()
		p := s.transferAgent(r)
		j := s.projectTransfers.lookup(r.PathValue("transferId"))
		j.mu.Lock()
		defer j.mu.Unlock()
		s.transferAccess(p, j, p.Device)
		if p.Device != j.Target || j.State != "downloading" || offset >= j.Size {
			fail(409, "project-transfer-state-changed")
		}
		f, err := os.Open(s.projectTransfers.path(j.ID, ".data"))
		if err != nil {
			panic(err)
		}
		defer f.Close()
		b := make([]byte, min(int64(projectTransferChunk), j.Size-offset))
		if _, err = f.ReadAt(b, offset); err != nil {
			panic(err)
		}
		downloadHeaders(w)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(b)
		return nil
	})
}
func (s *Server) transferList(p *Principal, device string) M {
	store := s.projectTransfers
	store.mu.Lock()
	defer store.mu.Unlock()
	jobs := []M{}
	owner := &Principal{ID: p.ID, Kind: "user"}
	for _, j := range store.jobs {
		j.mu.Lock()
		if j.Owner == p.ID && j.Expires > now() && (device == "" || j.Source == device || j.Target == device) && s.Store.Owns(j.Source, owner) && s.Store.Owns(j.Target, owner) {
			jobs = append(jobs, j.view())
		}
		j.mu.Unlock()
	}
	sort.Slice(jobs, func(i, j int) bool {
		if transferTerminal(str(jobs[i]["state"])) != transferTerminal(str(jobs[j]["state"])) {
			return !transferTerminal(str(jobs[i]["state"]))
		}
		return num(jobs[i]["createdAt"]) > num(jobs[j]["createdAt"])
	})
	if len(jobs) > 100 {
		jobs = jobs[:100]
	}
	return M{"transfers": jobs}
}
