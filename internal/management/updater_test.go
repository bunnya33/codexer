package management

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"errors"
	relay "github.com/bunnya33/codexer/apps/relay"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func archiveFixture(t *testing.T, name string, kind byte) string {
	t.Helper()
	var data bytes.Buffer
	gz := gzip.NewWriter(&data)
	tw := tar.NewWriter(gz)
	body := []byte("example")
	h := &tar.Header{Name: name, Mode: 0644, Size: int64(len(body)), Typeflag: kind}
	if kind != tar.TypeReg {
		h.Size = 0
	}
	if e := tw.WriteHeader(h); e != nil {
		t.Fatal(e)
	}
	if h.Size > 0 {
		tw.Write(body)
	}
	tw.Close()
	gz.Close()
	p := filepath.Join(t.TempDir(), "bundle.tar.gz")
	os.WriteFile(p, data.Bytes(), 0600)
	return p
}
func TestArchiveBoundaries(t *testing.T) {
	for _, name := range []string{"../escaped", "/codexer/file", "codexer/../../escape", "codexer/./file", "other/file", "codexer\\escape"} {
		if e := ExtractArchive(archiveFixture(t, name, tar.TypeReg), t.TempDir()); e == nil {
			t.Fatalf("accepted %s", name)
		}
	}
	for _, kind := range []byte{tar.TypeSymlink, tar.TypeLink, tar.TypeChar, tar.TypeBlock, tar.TypeFifo} {
		if e := ExtractArchive(archiveFixture(t, "codexer/file", kind), t.TempDir()); e == nil {
			t.Fatal("accepted special file")
		}
	}
	root := t.TempDir()
	name := "codexer/" + strings.Repeat("a", 110) + "-示例.txt"
	if e := ExtractArchive(archiveFixture(t, name, tar.TypeReg), root); e != nil {
		t.Fatal(e)
	}
	data, e := os.ReadFile(filepath.Join(root, name))
	if e != nil || string(data) != "example" {
		t.Fatal("PAX extraction")
	}
}
func TestActivationAndRollback(t *testing.T) {
	for _, failure := range []string{"none", "start", "health"} {
		active := "old"
		result, e := Activate("new", "old", Activation{Stop: func() error { return nil }, Switch: func(p string) error { active = p; return nil }, Start: func() error {
			if active == "new" && failure == "start" {
				return errors.New("fixture")
			}
			return nil
		}, Healthy: func() bool { return failure != "health" }})
		if e != nil {
			t.Fatal(e)
		}
		if failure == "none" {
			if result != "succeeded" || active != "new" {
				t.Fatal("activation")
			}
		} else if result != "rolled-back" || active != "old" {
			t.Fatal("rollback")
		}
	}
}
func TestBuildIsUnprivilegedAndFixed(t *testing.T) {
	id := "12345678-1234-1234-1234-123456789abc"
	workspace := filepath.Join(releaseRoot, ".git-stage-"+id, "codexer")
	args, e := BuildUnitArgs(id, workspace)
	if e != nil {
		t.Fatal(e)
	}
	all := strings.Join(args, "\n")
	for _, required := range []string{"User=codexer-builder", "NoNewPrivileges=true", "CapabilityBoundingSet=", "InaccessiblePaths=/etc/codexer", "RuntimeMaxSec=1800", "build-worker"} {
		if !strings.Contains(all, required) {
			t.Fatalf("missing %s", required)
		}
	}
	if _, e = BuildUnitArgs(id, "/tmp/arbitrary"); e == nil {
		t.Fatal("arbitrary build")
	}
	for _, bad := range []relay.M{{"id": "../escape", "tag": "v0.3.0", "method": "git", "action": "update", "phase": "queued"}, {"id": id, "tag": "main", "method": "git", "action": "update", "phase": "queued"}, {"id": id, "tag": "v0.3.0", "method": "release", "action": "build", "phase": "queued"}} {
		if ValidUpdate(bad) {
			t.Fatal("unsafe request")
		}
	}
}
func TestConfigAndServiceHaveNoNodeRuntime(t *testing.T) {
	source := "RELAY_WEB_DIR=/old/web\nRELAY_ADMIN_DIR=/old/admin\nDATABASE_URL=postgresql://example/db\nRELAY_ADMIN_TOKEN=old-token\n"
	content, e := Configure(source, "http://example.com:8899", "admin", "password-123456", "https://web.example.com")
	if e != nil {
		t.Fatal(e)
	}
	values := ParseEnv(content)
	if values["RELAY_PORT"] != "8899" || values["RELAY_ADMIN_TOKEN"] != "" || values["RELAY_WEB_DIR"] != "" || values["DATABASE_URL"] != "postgresql://example/db" {
		t.Fatal("config migration")
	}
	unit := ServiceUnit()
	if strings.Contains(unit, "node") || !strings.Contains(unit, "ExecStart=/opt/codexer/current/codexer serve") {
		t.Fatal("runtime unit")
	}
	for _, raw := range []string{"https://example.com", "http://0.0.0.0:80", "http://example.com/path", "http://user@example.com", "http://example.com?token=secret"} {
		if _, _, e := Origin(raw, true); e == nil {
			t.Fatalf("invalid origin %s", raw)
		}
	}
}
func TestOriginAndCredentialRoundTrip(t *testing.T) {
	source := "OTHER=kept\n"
	password := "spaces '\" \\ 中文 emoji 😀 password"
	content, e := Configure(source, "http://EXAMPLE.com:80/", "admin", password, "https://EXAMPLE.com:443,https://example.com")
	if e != nil {
		t.Fatal(e)
	}
	values := ParseEnv(content)
	decoded, e := base64.StdEncoding.DecodeString(values["RELAY_ADMIN_PASSWORD_B64"])
	if e != nil || string(decoded) != password || values["OTHER"] != "kept" || values["RELAY_ALLOWED_ORIGINS"] != "http://example.com,https://example.com" {
		t.Fatal("config round trip/canonical origins")
	}
}
func TestArtifactRejectsSymlinksAndSnapshotsRegularFiles(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	os.WriteFile(source, []byte("bundle"), 0600)
	snapshot, e := snapshotArtifact(source, dir)
	if e != nil {
		t.Fatal(e)
	}
	defer os.Remove(snapshot)
	data, _ := os.ReadFile(snapshot)
	if string(data) != "bundle" {
		t.Fatal("artifact copy")
	}
	link := filepath.Join(dir, "link")
	if e := os.Symlink(source, link); e != nil {
		t.Skip("symlinks unavailable")
	}
	if _, e = snapshotArtifact(link, dir); e == nil {
		t.Fatal("accepted symlink")
	}
}
