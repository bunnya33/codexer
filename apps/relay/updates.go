package relay

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const releaseRepository = "bunnya33/codexer"

type Updates struct {
	Version, Dir, Status string
	mu                   sync.Mutex
	Checked              int64
	Method               string
	Warning              any
	Release              M
	Tags                 []M
	Client               *http.Client
}

func NewUpdates(version, dir, status string) *Updates {
	if status == "" {
		status = "/var/lib/codexer-updater/status.json"
	}
	return &Updates{Version: version, Dir: dir, Status: status, Tags: []M{}, Client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func ReadJSON(path string) M {
	b, e := os.ReadFile(path)
	if e != nil || len(b) > 1024*1024 {
		return nil
	}
	var m M
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}
func AtomicJSON(path string, value any, mode os.FileMode) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	tmp, e := os.OpenFile(path+"-"+uuid()+".tmp", os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if e != nil {
		return e
	}
	defer os.Remove(tmp.Name())
	if _, e = tmp.Write([]byte(js(value))); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Sync(); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Close(); e != nil {
		return e
	}
	return os.Rename(tmp.Name(), path)
}
func Newer(a, b string) bool {
	parse := func(v string) [3]int {
		m := stableTag.FindStringSubmatch("v" + strings.TrimPrefix(v, "v"))
		if m == nil {
			fail(400, "invalid-version")
		}
		parts := strings.Split(strings.TrimPrefix(m[0], "v"), ".")
		n := [3]int{}
		for i, v := range parts {
			n[i], _ = strconv.Atoi(v)
		}
		return n
	}
	x, y := parse(a), parse(b)
	for i := 0; i < 3; i++ {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	return false
}
func DownloadURL(raw string) string {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		fail(400, "invalid-download-url")
	}
	switch u.Hostname() {
	case "github.com":
		if !strings.HasPrefix(u.Path, "/"+releaseRepository+"/releases/download/") {
			fail(400, "invalid-download-url")
		}
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com":
	default:
		fail(400, "invalid-download-url")
	}
	return raw
}
func ParseRelease(m M) M {
	tag := str(m["tag_name"])
	if !stableTag.MatchString(tag) || boolean(m["draft"]) || boolean(m["prerelease"]) {
		fail(502, "invalid-release")
	}
	version := tag[1:]
	name := fmt.Sprintf("codexer-server-%s-%s-%s.tar.gz", version, runtime.GOOS, runtime.GOARCH)
	assets := list(m["assets"])
	asset, checksum := "", ""
	for _, v := range assets {
		a := obj(v)
		if a["name"] == name {
			asset = str(a["browser_download_url"])
		}
		if a["name"] == name+".sha256" {
			checksum = str(a["browser_download_url"])
		}
	}
	if asset == "" || checksum == "" {
		fail(502, "release-assets-missing")
	}
	url := "https://github.com/" + releaseRepository + "/releases/tag/" + tag
	if m["html_url"] != url {
		fail(502, "invalid-release-url")
	}
	return M{"tag": tag, "version": version, "url": url, "notes": truncate(str(m["body"]), 16000), "publishedAt": str(m["published_at"]), "asset": DownloadURL(asset), "checksum": DownloadURL(checksum)}
}
func (u *Updates) fetch(path string) any {
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+releaseRepository+path, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Codexer-server-updater")
	res, e := u.Client.Do(req)
	if e != nil {
		fail(502, "release-check-failed")
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return nil
	}
	if res.StatusCode != 200 {
		if res.StatusCode == 403 || res.StatusCode == 429 {
			fail(502, "github-rate-limited")
		}
		fail(502, "release-check-failed")
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, 1024*1024+1))
	if e != nil || len(b) > 1024*1024 {
		fail(502, "release-response-too-large")
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		fail(502, "invalid-release")
	}
	return v
}
func updateRunning(job M) bool {
	if len(job) == 0 {
		return false
	}
	switch job["phase"] {
	case "fetched", "built", "succeeded", "failed", "rolled-back":
		return false
	}
	return true
}
func nextAction(job M, method, tag string) string {
	if job == nil || job["tag"] != tag {
		return "update"
	}
	if method == "git" && job["method"] == "git" && (job["phase"] == "fetched" || job["phase"] == "failed" && job["action"] == "build") {
		return "build"
	}
	if job["phase"] == "built" || job["phase"] == "failed" && job["action"] == "restart" {
		return "restart"
	}
	return "update"
}
func (u *Updates) Info(force bool) M { u.mu.Lock(); defer u.mu.Unlock(); return u.info(force) }
func (u *Updates) info(force bool) M {
	if u.Dir == "" {
		fail(503, "updates-unavailable")
	}
	settings := ReadJSON(filepath.Join(u.Dir, "settings.json"))
	method := "release"
	if settings["method"] == "git" {
		method = "git"
	}
	if force || u.Method != method || u.Checked == 0 || now()-u.Checked > 20*60000 {
		func() {
			defer func() {
				if e := recover(); e != nil {
					u.Warning = "release-check-failed"
					if f, ok := e.(Fault); ok {
						u.Warning = f.Code
					}
				}
				u.Checked = now()
				u.Method = method
			}()
			u.Warning = nil
			if method == "git" {
				raw := u.fetch("/tags?per_page=100")
				tags := list(raw)
				if len(tags) > 100 {
					fail(502, "invalid-tags")
				}
				u.Tags = []M{}
				for _, v := range tags {
					m := obj(v)
					tag := str(m["name"])
					if !stableTag.MatchString(tag) {
						continue
					}
					commit := str(obj(m["commit"])["sha"])
					if len(commit) != 40 {
						fail(502, "invalid-tags")
					}
					u.Tags = append(u.Tags, M{"tag": tag, "version": tag[1:], "commit": commit})
				}
				sort.Slice(u.Tags, func(i, j int) bool { return Newer(str(u.Tags[i]["version"]), str(u.Tags[j]["version"])) })
				if len(u.Tags) == 0 {
					u.Warning = "no-stable-tags"
				}
			} else {
				raw := u.fetch("/releases/latest")
				u.Release = nil
				if raw == nil {
					u.Warning = "no-published-release"
				} else {
					u.Release = ParseRelease(obj(raw))
				}
			}
		}()
	}
	status := ReadJSON(u.Status)
	job := obj(status["job"])
	if len(job) == 0 {
		job = nil
	}
	pending := ReadJSON(filepath.Join(u.Dir, "request.json"))
	if pending != nil && (pending["id"] != job["id"] || pending["action"] != job["action"] || num(pending["updatedAt"]) > num(job["updatedAt"])) {
		job = pending
	}
	var latest, release any
	tags := []M{}
	auto := false
	if method == "git" {
		tags = u.Tags
		if len(tags) > 0 {
			latest = tags[0]["version"]
		}
	} else {
		if u.Release != nil {
			latest = u.Release["version"]
			release = u.Release
		}
		auto = boolean(settings["autoInstall"])
	}
	has := latest != nil && Newer(str(latest), u.Version)
	return M{"currentVersion": u.Version, "latestVersion": latest, "hasUpdate": has, "checkedAt": u.Checked, "warning": u.Warning, "release": release, "supported": boolean(status["enabled"]) && num(status["protocol"]) == 2, "gitSupported": num(status["protocol"]) == 2 && boolean(status["gitSupported"]), "method": method, "tags": tags, "autoInstall": auto, "job": job}
}
func (u *Updates) Settings(change M) M {
	u.mu.Lock()
	defer u.mu.Unlock()
	info := u.info(false)
	if !boolean(info["supported"]) {
		fail(409, "updater-not-installed")
	}
	if updateRunning(obj(info["job"])) {
		fail(409, "update-in-progress")
	}
	method := str(info["method"])
	if change["method"] != nil {
		method = str(change["method"])
	}
	if method == "git" && !boolean(info["gitSupported"]) {
		fail(409, "git-updater-not-installed")
	}
	if method == "git" && boolean(change["autoInstall"]) {
		fail(409, "git-requires-manual-steps")
	}
	auto := boolean(info["autoInstall"])
	if change["autoInstall"] != nil {
		auto = boolean(change["autoInstall"])
	}
	settings := M{"method": method, "autoInstall": method == "release" && auto}
	if e := AtomicJSON(filepath.Join(u.Dir, "settings.json"), settings, 0600); e != nil {
		panic(e)
	}
	return settings
}
func (u *Updates) Request(tag, action, id string) M {
	u.mu.Lock()
	defer u.mu.Unlock()
	info := u.info(action == "update")
	if !boolean(info["supported"]) {
		fail(409, "updater-not-installed")
	}
	job := obj(info["job"])
	if updateRunning(job) {
		fail(409, "update-in-progress")
	}
	method := str(info["method"])
	if action == "update" {
		if info["warning"] != nil {
			fail(409, "update-not-current")
		}
		if method == "release" {
			if !boolean(info["hasUpdate"]) || obj(info["release"])["tag"] != tag {
				fail(409, "update-not-current")
			}
		} else {
			found := false
			for _, t := range u.Tags {
				if t["tag"] == tag && Newer(str(t["version"]), u.Version) {
					found = true
				}
			}
			if !found {
				fail(409, "tag-not-available")
			}
		}
		id = uuid()
	} else if job["id"] != id || nextAction(job, method, tag) != action {
		fail(409, "update-step-not-ready")
	}
	if method == "git" && !boolean(info["gitSupported"]) {
		fail(409, "git-updater-not-installed")
	}
	v := M{"id": id, "tag": tag, "method": method, "action": action, "phase": "queued", "updatedAt": now()}
	if action != "update" && job["commit"] != nil {
		v["commit"] = job["commit"]
	}
	path := filepath.Join(u.Dir, "request.json")
	os.MkdirAll(u.Dir, 0700)
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(e) {
		fail(409, "update-in-progress")
	}
	if e != nil {
		panic(e)
	}
	_, e = f.Write([]byte(js(v)))
	f.Close()
	if e != nil {
		panic(e)
	}
	return v
}
func (u *Updates) AutoPrepare() {
	if u.Dir == "" {
		return
	}
	info := u.Info(true)
	job := obj(info["job"])
	if info["method"] == "release" && boolean(info["autoInstall"]) && boolean(info["supported"]) && boolean(info["hasUpdate"]) && info["warning"] == nil && (len(job) == 0 || job["phase"] == "succeeded") {
		u.Request(str(obj(info["release"])["tag"]), "update", "")
	}
}
func (s *Server) updateRoutes() {
	s.route("GET /v1/admin/system/version", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		return s.updates.Info(r.URL.Query().Get("force") == "true")
	})
	s.route("POST /v1/admin/system/update", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		b := body(r)
		for k := range b {
			if k != "tag" && k != "action" && k != "jobId" {
				fail(400, "invalid-request")
			}
		}
		tag, action, id := str(b["tag"]), str(b["action"]), str(b["jobId"])
		if action == "" {
			action = "update"
		}
		if !stableTag.MatchString(tag) || (action != "update" && action != "build" && action != "restart") || (id != "" && !uuidPattern.MatchString(id)) {
			fail(400, "invalid-request")
		}
		return s.updates.Request(tag, action, id)
	})
	s.route("PUT /v1/admin/system/update-settings", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		b := body(r)
		if len(b) == 0 {
			fail(400, "invalid-request")
		}
		for k, v := range b {
			if k == "autoInstall" {
				if _, ok := v.(bool); !ok {
					fail(400, "invalid-request")
				}
			} else if k != "method" || (v != "release" && v != "git") {
				fail(400, "invalid-request")
			}
		}
		return s.updates.Settings(b)
	})
}
