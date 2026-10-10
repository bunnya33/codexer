package relay

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func releaseFixture(version string) M {
	name := "codexer-server-" + version + "-" + runtime.GOOS + "-" + runtime.GOARCH + ".tar.gz"
	root := "https://github.com/" + releaseRepository + "/releases/download/v" + version + "/"
	return M{"tag_name": "v" + version, "html_url": "https://github.com/" + releaseRepository + "/releases/tag/v" + version, "assets": []any{M{"name": name, "browser_download_url": root + name}, M{"name": name + ".sha256", "browser_download_url": root + name + ".sha256"}}}
}
func TestReleaseMetadataAndDownloads(t *testing.T) {
	if !Newer("0.3.0", "0.2.10") || Newer("0.3.0", "0.3.0") {
		t.Fatal("versions")
	}
	r := ParseRelease(releaseFixture("0.3.0"))
	if r["tag"] != "v0.3.0" {
		t.Fatal("release")
	}
	for _, raw := range []string{"http://github.com/bunnya33/codexer/releases/download/v1/file", "https://github.com.evil.com/file", "https://github.com/other/repo/releases/download/v1/file", "https://127.0.0.1/private", "https://user@github.com/bunnya33/codexer/releases/download/v1/file"} {
		expectFault(t, "invalid-download-url", func() { DownloadURL(raw) })
	}
	bad := releaseFixture("0.3.0")
	bad["prerelease"] = true
	expectFault(t, "invalid-release", func() { ParseRelease(bad) })
}
func TestReleaseWorkflowSettingsAndRetries(t *testing.T) {
	dir := t.TempDir()
	status := filepath.Join(dir, "status.json")
	AtomicJSON(status, M{"enabled": true, "protocol": 2, "gitSupported": true, "job": nil}, 0600)
	u := NewUpdates("0.2.10", dir, status)
	calls := 0
	u.Client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		return fakeResponse(releaseFixture("0.3.0")), nil
	})
	info := u.Info(true)
	if info["hasUpdate"] != true || info["supported"] != true {
		t.Fatal("metadata")
	}
	u.Info(false)
	if calls != 1 {
		t.Fatal("cache")
	}
	job := u.Request("v0.3.0", "update", "")
	expectFault(t, "update-in-progress", func() { u.Request("v0.3.0", "update", "") })
	os.Remove(filepath.Join(dir, "request.json"))
	job["phase"] = "built"
	job["updatedAt"] = now() + 1
	AtomicJSON(status, M{"enabled": true, "protocol": 2, "gitSupported": true, "job": job}, 0600)
	expectFault(t, "update-step-not-ready", func() { u.Request("v0.3.0", "restart", uuid()) })
	restart := u.Request("v0.3.0", "restart", str(job["id"]))
	if restart["id"] != job["id"] || restart["action"] != "restart" {
		t.Fatal("manual restart")
	}
	os.Remove(filepath.Join(dir, "request.json"))
	job["phase"] = "failed"
	job["action"] = "restart"
	AtomicJSON(status, M{"enabled": true, "protocol": 2, "gitSupported": true, "job": job}, 0600)
	if u.Request("v0.3.0", "restart", str(job["id"]))["action"] != "restart" {
		t.Fatal("retry")
	}
	os.Remove(filepath.Join(dir, "request.json"))
	AtomicJSON(status, M{"enabled": true, "protocol": 2, "gitSupported": true, "job": nil}, 0600)
	if u.Settings(M{"method": "git"})["autoInstall"] != false {
		t.Fatal("git auto")
	}
	expectFault(t, "git-requires-manual-steps", func() { u.Settings(M{"autoInstall": true}) })
}
func TestGitWorkflowAndLegacyUpdater(t *testing.T) {
	dir := t.TempDir()
	status := filepath.Join(dir, "status.json")
	AtomicJSON(status, M{"enabled": true, "protocol": 1, "job": nil}, 0600)
	u := NewUpdates("0.2.10", dir, status)
	u.Client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path[len(r.URL.Path)-4:] == "tags" {
			return fakeResponse([]any{M{"name": "v0.3.0", "commit": M{"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}), nil
		}
		return fakeResponse(releaseFixture("0.3.0")), nil
	})
	expectFault(t, "updater-not-installed", func() { u.Request("v0.3.0", "update", "") })
	AtomicJSON(status, M{"enabled": true, "protocol": 2, "gitSupported": true, "job": nil}, 0600)
	u.Settings(M{"method": "git"})
	job := u.Request("v0.3.0", "update", "")
	os.Remove(filepath.Join(dir, "request.json"))
	job["phase"] = "fetched"
	job["commit"] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	job["updatedAt"] = now() + 1
	AtomicJSON(status, M{"enabled": true, "protocol": 2, "gitSupported": true, "job": job}, 0600)
	expectFault(t, "update-step-not-ready", func() { u.Request("v0.3.0", "restart", str(job["id"])) })
	build := u.Request("v0.3.0", "build", str(job["id"]))
	if build["commit"] != job["commit"] {
		t.Fatal("commit lost")
	}
	u.Checked = now() - int64((21*time.Minute)/time.Millisecond)
	u.Info(false)
}
