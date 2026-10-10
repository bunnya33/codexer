package management

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	relay "github.com/bunnya33/codexer/apps/relay"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const updateRoot = "/var/lib/codexer-updater"
const releaseRoot = "/opt/codexer/releases"
const currentPath = "/opt/codexer/current"

var stable = regexp.MustCompile(`^v\d+\.\d+\.\d+$`)
var updateID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var sha = regexp.MustCompile(`^[a-f0-9]{40}$`)

func ValidUpdate(m relay.M) bool {
	if !stable.MatchString(stringValue(m["tag"])) || !updateID.MatchString(stringValue(m["id"])) || m["phase"] != "queued" {
		return false
	}
	if m["method"] != "git" && m["method"] != "release" {
		return false
	}
	if m["action"] != "update" && m["action"] != "build" && m["action"] != "restart" {
		return false
	}
	if m["method"] == "release" && m["action"] == "build" {
		return false
	}
	return true
}
func stringValue(v any) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}
func Download(ctx context.Context, raw, target string, limit int64) error {
	raw = relay.DownloadURL(raw)
	client := &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("too-many-redirects")
		}
		relay.DownloadURL(req.URL.String())
		return nil
	}}
	r, e := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if e != nil {
		return e
	}
	res, e := client.Do(r)
	if e != nil {
		return errors.New("download-failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || res.ContentLength > limit {
		return errors.New("download-failed")
	}
	f, e := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	n, e := io.Copy(f, io.LimitReader(res.Body, limit+1))
	closeErr := f.Close()
	if n > limit {
		return errors.New("download-too-large")
	}
	if e != nil {
		return e
	}
	return closeErr
}

// Extract only directories and regular files under a single root. No links,
// special files, duplicate paths or traversal are allowed in privileged installs.
func ExtractArchive(archive, target string) error {
	f, e := os.Open(archive)
	if e != nil {
		return e
	}
	defer f.Close()
	gz, e := gzip.NewReader(f)
	if e != nil {
		return errors.New("invalid-archive")
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	seen := map[string]bool{}
	size := int64(0)
	for n := 0; ; n++ {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil || n > 100000 {
			return errors.New("invalid-archive")
		}
		name := strings.TrimSuffix(h.Name, "/")
		if name == "" || strings.Contains(name, "\\") || path.Clean(name) != name || (name != "codexer" && !strings.HasPrefix(name, "codexer/")) || strings.Contains(name, "\x00") || seen[name] {
			return errors.New("unsafe-archive-path")
		}
		seen[name] = true
		dest := filepath.Join(target, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if e = os.MkdirAll(dest, 0700); e != nil {
				return e
			}
		case tar.TypeReg:
			if h.Size < 0 || h.Size > 256*1024*1024 {
				return errors.New("invalid-archive")
			}
			size += h.Size
			if size > 512*1024*1024 {
				return errors.New("invalid-archive")
			}
			if e = os.MkdirAll(filepath.Dir(dest), 0700); e != nil {
				return e
			}
			mode := os.FileMode(0644)
			if path.Base(name) == "codexer" {
				mode = 0755
			}
			file, e := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if e != nil {
				return e
			}
			_, e = io.CopyN(file, tr, h.Size)
			file.Close()
			if e != nil {
				return e
			}
		default:
			return errors.New("unsafe-archive-entry")
		}
	}
	return nil
}
func run(ctx context.Context, timeout time.Duration, dir, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c := exec.CommandContext(ctx, name, args...)
	c.Dir = dir
	c.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	b, e := c.Output()
	if ctx.Err() != nil {
		return "", errors.New("command-timeout")
	}
	if e != nil {
		return "", errors.New("command-failed")
	}
	return strings.TrimSpace(string(b)), nil
}
func GitFetch(ctx context.Context, target, tag string) (string, error) {
	if !stable.MatchString(tag) {
		return "", errors.New("invalid-git-tag")
	}
	options := []string{"-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never"}
	steps := [][]string{{"init", target}, {"-C", target, "remote", "add", "origin", "https://github.com/bunnya33/codexer.git"}, {"-C", target, "fetch", "--depth=1", "--no-tags", "origin", "refs/tags/" + tag + ":refs/tags/" + tag}}
	for _, step := range steps {
		if _, e := run(ctx, 10*time.Minute, "", "git", append(options, step...)...); e != nil {
			return "", errors.New("git-fetch-failed")
		}
	}
	commit, e := run(ctx, time.Minute, "", "git", append(options, "-C", target, "rev-parse", "--verify", "refs/tags/"+tag+"^{commit}")...)
	if e != nil || !sha.MatchString(commit) {
		return "", errors.New("git-fetch-failed")
	}
	if _, e = run(ctx, time.Minute, "", "git", append(options, "-C", target, "checkout", "--detach", commit)...); e != nil {
		return "", e
	}
	if relay.ReadJSON(filepath.Join(target, "package.json"))["version"] != tag[1:] {
		return "", errors.New("tag-version-mismatch")
	}
	return commit, nil
}
func BuildUnitArgs(id, workspace string) ([]string, error) {
	if !updateID.MatchString(id) || workspace != filepath.Join(releaseRoot, ".git-stage-"+id, "codexer") {
		return nil, errors.New("invalid-build-workspace")
	}
	return []string{"--unit=codexer-build-" + id, "--wait", "--collect", "--property=User=codexer-builder", "--property=Group=codexer-builder", "--property=WorkingDirectory=" + workspace, "--property=ReadWritePaths=" + workspace, "--property=ProtectSystem=strict", "--property=ProtectHome=true", "--property=PrivateTmp=true", "--property=PrivateDevices=true", "--property=NoNewPrivileges=true", "--property=CapabilityBoundingSet=", "--property=RestrictSUIDSGID=true", "--property=ProtectKernelTunables=true", "--property=ProtectKernelModules=true", "--property=ProtectControlGroups=true", "--property=InaccessiblePaths=/etc/codexer /var/lib/codexer /var/lib/codexer-updater -/run/dbus -/run/systemd/private", "--property=RuntimeMaxSec=1800", "--property=TimeoutStopSec=20", "--property=KillMode=control-group", "--property=StandardOutput=journal", "--property=StandardError=journal", "--setenv=PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin", "--setenv=CI=1", "--setenv=GOCACHE=" + workspace + "/.go-cache", "--setenv=GOMODCACHE=" + workspace + "/.go-modules", "--setenv=__UNSAFE_EXPO_HOME_DIRECTORY=" + workspace + "/.expo-home", "--setenv=EXPO_NO_TELEMETRY=1", "--setenv=NODE_OPTIONS=--no-global-search-paths", "/usr/local/lib/codexer-updater/codexer", "build-worker", workspace}, nil
}
func BuildWorker(workspace string) error {
	if runtime.GOOS != "linux" || os.Geteuid() == 0 || !regexp.MustCompile(`^/opt/codexer/releases/\.git-stage-[a-f0-9-]{36}/codexer$`).MatchString(workspace) {
		return errors.New("invalid-build-worker")
	}
	ctx := context.Background()
	for _, args := range [][]string{{"ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"}, {"run", "build:server"}, {"run", "package:server"}} {
		if _, e := run(ctx, 20*time.Minute, workspace, "npm", args...); e != nil {
			return e
		}
	}
	return nil
}
func switchRelease(next string) error {
	temp := currentPath + ".new"
	os.Remove(temp)
	if e := os.Symlink(next, temp); e != nil {
		return e
	}
	return os.Rename(temp, currentPath)
}

type Activation struct {
	Stop, Start func() error
	Switch      func(string) error
	Healthy     func() bool
}

func Activate(next, previous string, a Activation) (string, error) {
	if e := a.Stop(); e != nil {
		return "", e
	}
	e := a.Switch(next)
	if e == nil {
		e = a.Start()
	}
	if e == nil && a.Healthy() {
		return "succeeded", nil
	}
	a.Stop()
	if e = a.Switch(previous); e != nil {
		return "", e
	}
	if e = a.Start(); e != nil {
		return "", e
	}
	return "rolled-back", nil
}
func bundleVersion(dir string) string {
	if m := relay.ReadJSON(filepath.Join(dir, "server-bundle.json")); m != nil {
		return stringValue(m["version"])
	}
	if m := relay.ReadJSON(filepath.Join(dir, "package.json")); m != nil {
		return stringValue(m["version"])
	}
	b, _ := os.ReadFile(filepath.Join(dir, "VERSION"))
	return strings.TrimSpace(string(b))
}
func validateBundle(dir, version string) error {
	m := relay.ReadJSON(filepath.Join(dir, "server-bundle.json"))
	if m["kind"] != "codexer-server-bundle" || m["version"] != version || m["runtime"] != "go" || m["os"] != runtime.GOOS || m["arch"] != runtime.GOARCH {
		return errors.New("invalid-server-bundle")
	}
	info, e := os.Lstat(filepath.Join(dir, "codexer"))
	if e != nil || !info.Mode().IsRegular() || info.Size() < 1024*1024 || info.Size() > 256*1024*1024 {
		return errors.New("invalid-server-bundle")
	}
	return nil
}
func builderSupported() bool {
	for _, name := range []string{"go", "node", "npm", "git", "systemd-run"} {
		if _, e := exec.LookPath(name); e != nil {
			return false
		}
	}
	if uid, e := output("id", "-u", "codexer-builder"); e != nil || uid == "0" {
		return false
	}
	gv, e := output("go", "env", "GOVERSION")
	if e != nil || !relay.Newer(strings.TrimPrefix(gv, "go"), "1.25.999") {
		return false
	}
	nv, e := output("node", "--version")
	if e != nil || !relay.Newer(strings.TrimPrefix(nv, "v"), "22.12.999") {
		return false
	}
	return true
}
func secureJSON(path string) (relay.M, error) {
	f, e := openRegularNoFollow(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	link, e2 := os.Lstat(path)
	if e != nil || e2 != nil || !info.Mode().IsRegular() || link.Mode()&os.ModeSymlink != 0 || info.Size() > 1024*1024 {
		return nil, errors.New("unsafe-update-file")
	}
	var m relay.M
	if json.NewDecoder(io.LimitReader(f, 1024*1024)).Decode(&m) != nil {
		return nil, errors.New("invalid-update-file")
	}
	return m, nil
}
func ExecuteUpdate() (err error) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return errors.New("managed-linux-root-required")
	}
	ctx := context.Background()
	source, e := os.ReadFile(configPath())
	if e != nil {
		return e
	}
	env := ParseEnv(string(source))
	base := "http://127.0.0.1:" + env["RELAY_PORT"]
	if _, _, e = Origin(base, true); e != nil {
		return e
	}
	statusPath := filepath.Join(updateRoot, "status.json")
	status := relay.ReadJSON(statusPath)
	var previousJob any = status["job"]
	git := builderSupported()
	publishStatus := func(job any) error {
		return relay.AtomicJSON(statusPath, relay.M{"enabled": true, "protocol": 2, "gitSupported": git, "job": job}, 0644)
	}
	journal := filepath.Join(updateRoot, "rollback.json")
	if recovery, e := secureJSON(journal); e == nil {
		previous := stringValue(recovery["previous"])
		if !strings.HasPrefix(previous, releaseRoot+"/") || filepath.Clean(previous) != previous {
			return errors.New("invalid-rollback-journal")
		}
		if _, e = run(ctx, time.Minute, "", "systemctl", "stop", "codexer-relay.service"); e != nil {
			return e
		}
		if e = switchRelease(previous); e != nil {
			return e
		}
		if _, e = run(ctx, time.Minute, "", "systemctl", "start", "codexer-relay.service"); e != nil {
			return e
		}
		if !Healthy(base, bundleVersion(previous), true) {
			return errors.New("rollback-health-failed")
		}
		if j, ok := previousJob.(map[string]any); ok {
			j["phase"] = "rolled-back"
			j["code"] = "update-interrupted"
			j["updatedAt"] = time.Now().UnixMilli()
		}
		os.Remove(journal)
		os.Remove(filepath.Join(updateRoot, "inbox", "request.json"))
	} else if !os.IsNotExist(e) {
		return e
	}
	if e = publishStatus(previousJob); e != nil {
		return e
	}
	inbox := filepath.Join(updateRoot, "inbox", "request.json")
	job, e := secureJSON(inbox)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	if !ValidUpdate(job) {
		os.Remove(inbox)
		return nil
	}
	defer os.Remove(inbox)
	publish := func(phase, code string) error {
		job["phase"] = phase
		job["updatedAt"] = time.Now().UnixMilli()
		delete(job, "code")
		if code != "" {
			job["code"] = code
		}
		return publishStatus(job)
	}
	defer func() {
		if p := recover(); p != nil {
			err = errors.New("update-failed")
			if f, ok := p.(relay.Fault); ok {
				err = errors.New(f.Code)
			}
		}
		if err != nil {
			publish("failed", err.Error())
		}
	}()
	tag, id, method, action := stringValue(job["tag"]), stringValue(job["id"]), stringValue(job["method"]), stringValue(job["action"])
	installed := bundleVersion(currentPath)
	if !relay.Newer(tag[1:], installed) {
		return errors.New("update-not-current")
	}
	stagePath := filepath.Join(updateRoot, "release-stage.json")
	if method == "git" {
		if !git {
			return errors.New("git-updater-not-installed")
		}
		stagePath = filepath.Join(updateRoot, "git-stage.json")
	}
	stage := relay.ReadJSON(stagePath)
	if stage != nil {
		sid, stag := stringValue(stage["id"]), stringValue(stage["tag"])
		expected := filepath.Join(releaseRoot, strings.TrimPrefix(stag, "v")+"-"+method+"-"+sid)
		if !updateID.MatchString(sid) || !stable.MatchString(stag) || stage["releasePath"] != nil && stage["releasePath"] != expected {
			return errors.New("invalid-update-stage")
		}
	}
	next := filepath.Join(releaseRoot, tag[1:]+"-"+method+"-"+id)
	if action == "restart" {
		if stage == nil || stage["id"] != id || stage["tag"] != tag || stage["phase"] != "built" || stage["releasePath"] != next {
			return errors.New("update-step-not-ready")
		}
		if e = validateBundle(next, tag[1:]); e != nil {
			return e
		}
		previous, e := os.Readlink(currentPath)
		if e != nil {
			return e
		}
		if !filepath.IsAbs(previous) {
			previous = filepath.Join(filepath.Dir(currentPath), previous)
		}
		if e = relay.AtomicJSON(journal, relay.M{"previous": previous}, 0600); e != nil {
			return e
		}
		publish("restarting", "")
		result, e := Activate(next, previous, Activation{Stop: func() error {
			_, e := run(ctx, time.Minute, "", "systemctl", "stop", "codexer-relay.service")
			return e
		}, Start: func() error {
			_, e := run(ctx, time.Minute, "", "systemctl", "start", "codexer-relay.service")
			return e
		}, Switch: switchRelease, Healthy: func() bool { return Healthy(base, tag[1:], false) }})
		if e != nil {
			return e
		}
		if result == "rolled-back" && !Healthy(base, installed, true) {
			return errors.New("rollback-health-failed")
		}
		os.Remove(journal)
		os.Remove(stagePath)
		code := ""
		if result == "rolled-back" {
			code = "health-check-failed"
		}
		return publish(result, code)
	}
	if method == "git" {
		workspaceRoot := filepath.Join(releaseRoot, ".git-stage-"+id)
		source := filepath.Join(workspaceRoot, "source")
		workspace := filepath.Join(workspaceRoot, "codexer")
		if action == "update" {
			if stage != nil && stage["id"] == id && stage["tag"] == tag {
				job["commit"] = stage["commit"]
				return publish(stringValue(stage["phase"]), "")
			}
			publish("fetching", "")
			if stage != nil {
				oldID := stringValue(stage["id"])
				os.RemoveAll(filepath.Join(releaseRoot, ".git-stage-"+oldID))
			}
			os.RemoveAll(workspaceRoot)
			os.MkdirAll(workspaceRoot, 0711)
			commit, e := GitFetch(ctx, source, tag)
			if e != nil {
				return e
			}
			stage = relay.M{"id": id, "tag": tag, "commit": commit, "phase": "fetched"}
			job["commit"] = commit
			if e = relay.AtomicJSON(stagePath, stage, 0600); e != nil {
				return e
			}
			return publish("fetched", "")
		}
		if action != "build" || stage["id"] != id || stage["tag"] != tag || !sha.MatchString(stringValue(stage["commit"])) {
			return errors.New("update-step-not-ready")
		}
		if stage["phase"] == "built" {
			return publish("built", "")
		}
		publish("building", "")
		os.RemoveAll(workspace)
		if e = copyTree(source, workspace); e != nil {
			return e
		}
		uid, e := output("id", "-u", "codexer-builder")
		if e != nil {
			return e
		}
		gid, e := output("id", "-g", "codexer-builder")
		if e != nil {
			return e
		}
		if _, e = run(ctx, time.Minute, "", "chown", "-R", uid+":"+gid, workspace); e != nil {
			return e
		}
		args, e := BuildUnitArgs(id, workspace)
		if e != nil {
			return e
		}
		defer run(ctx, time.Minute, "", "systemctl", "stop", "codexer-build-"+id+".service")
		if _, e = run(ctx, 32*time.Minute, "", "systemd-run", args...); e != nil {
			return errors.New("build-command-failed")
		}
		archive := filepath.Join(workspace, "release", fmt.Sprintf("codexer-server-%s-%s-%s.tar.gz", tag[1:], runtime.GOOS, runtime.GOARCH))
		if info, e := os.Lstat(archive); e != nil || !info.Mode().IsRegular() || info.Size() > 256*1024*1024 {
			return errors.New("invalid-server-bundle")
		}
		// systemd-run --wait has finished the isolated service. Snapshot its regular
		// artifact into root-owned staging before privileged extraction.
		trusted, err := snapshotArtifact(archive, releaseRoot)
		if err != nil {
			return err
		}
		defer os.Remove(trusted)
		if e = installArchive(trusted, next, tag[1:]); e != nil {
			return e
		}
		stage["phase"] = "built"
		stage["releasePath"] = next
		if e = relay.AtomicJSON(stagePath, stage, 0600); e != nil {
			return e
		}
		os.RemoveAll(workspaceRoot)
		return publish("built", "")
	}
	if action != "update" {
		return errors.New("update-step-not-ready")
	}
	if stage["id"] == id && stage["tag"] == tag && stage["phase"] == "built" {
		return publish("built", "")
	}
	publish("downloading", "")
	updates := relay.NewUpdates(installed, filepath.Join(updateRoot, "inbox"), statusPath)
	info := updates.Info(true)
	release, _ := info["release"].(map[string]any)
	if release == nil || release["tag"] != tag {
		return errors.New("update-not-current")
	}
	temp, e := os.MkdirTemp(releaseRoot, ".download-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(temp)
	archive, checksum := filepath.Join(temp, "bundle.tar.gz"), filepath.Join(temp, "checksum")
	if e = Download(ctx, stringValue(release["checksum"]), checksum, 4096); e != nil {
		return e
	}
	if e = Download(ctx, stringValue(release["asset"]), archive, 256*1024*1024); e != nil {
		return e
	}
	publish("verifying", "")
	expected, e := os.ReadFile(checksum)
	if e != nil {
		return e
	}
	parts := strings.Fields(string(expected))
	name := fmt.Sprintf("codexer-server-%s-%s-%s.tar.gz", tag[1:], runtime.GOOS, runtime.GOARCH)
	if len(parts) != 2 || strings.TrimPrefix(parts[1], "*") != name || len(parts[0]) != 64 {
		return errors.New("checksum-mismatch")
	}
	f, e := os.Open(archive)
	if e != nil {
		return e
	}
	hash := sha256.New()
	io.Copy(hash, f)
	f.Close()
	if hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(parts[0]) {
		return errors.New("checksum-mismatch")
	}
	publish("installing", "")
	if e = installArchive(archive, next, tag[1:]); e != nil {
		return e
	}
	stage = relay.M{"id": id, "tag": tag, "phase": "built", "releasePath": next}
	if e = relay.AtomicJSON(stagePath, stage, 0600); e != nil {
		return e
	}
	return publish("built", "")
}
func installArchive(archive, next, version string) error {
	temp, e := os.MkdirTemp(releaseRoot, ".update-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(temp)
	if e = ExtractArchive(archive, temp); e != nil {
		return e
	}
	dir := filepath.Join(temp, "codexer")
	if e = validateBundle(dir, version); e != nil {
		return e
	}
	if e = os.Chmod(dir, 0755); e != nil {
		return e
	}
	if e = os.WriteFile(filepath.Join(dir, "VERSION"), []byte(version+"\n"), 0644); e != nil {
		return e
	}
	if _, e = os.Stat(next); e == nil {
		return errors.New("release-already-exists")
	}
	return os.Rename(dir, next)
}

func snapshotArtifact(source, directory string) (string, error) {
	f, e := openRegularNoFollow(source)
	if e != nil {
		return "", e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Size() > 256*1024*1024 {
		return "", errors.New("invalid-server-bundle")
	}
	target, e := os.CreateTemp(directory, ".trusted-bundle-")
	if e != nil {
		return "", e
	}
	name := target.Name()
	n, e := io.Copy(target, io.LimitReader(f, 256*1024*1024+1))
	ce := target.Close()
	if e != nil || ce != nil || n != info.Size() {
		os.Remove(name)
		return "", errors.New("invalid-server-bundle")
	}
	return name, nil
}
