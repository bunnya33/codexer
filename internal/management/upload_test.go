package management

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	relay "github.com/bunnya33/codexer/apps/relay"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestUploadedBundleSnapshotAndReverification(t *testing.T) {
	inbox, directory := t.TempDir(), t.TempDir()
	id := "12345678-1234-1234-1234-123456789abc"
	var data bytes.Buffer
	gz := gzip.NewWriter(&data)
	tw := tar.NewWriter(gz)
	manifest, _ := json.Marshal(relay.M{"kind": "codexer-server-bundle", "runtime": "go", "version": "0.3.39", "os": runtime.GOOS, "arch": runtime.GOARCH})
	for name, body := range map[string][]byte{"codexer/server-bundle.json": manifest, "codexer/VERSION": []byte("0.3.39\n"), "codexer/codexer": bytes.Repeat([]byte{1}, 1024*1024)} {
		if e := tw.WriteHeader(&tar.Header{Name: name, Mode: 0644, Size: int64(len(body))}); e != nil {
			t.Fatal(e)
		}
		tw.Write(body)
	}
	tw.Close()
	gz.Close()
	source := filepath.Join(inbox, id+".tar.gz")
	os.WriteFile(source, data.Bytes(), 0600)
	digest := sha256.Sum256(data.Bytes())
	job := relay.M{"id": id, "tag": "v0.3.39", "method": "upload", "source": "upload", "action": "update", "phase": "queued", "sha256": hex.EncodeToString(digest[:]), "size": float64(data.Len())}
	if !ValidUpdate(job) {
		t.Fatal("valid upload rejected")
	}
	job["phase"] = "verifying" // Actual updater publishes this before snapshotting.
	trusted, e := prepareUploadedBundle(inbox, directory, job)
	if e != nil {
		t.Fatal(e)
	}
	defer os.Remove(trusted)
	next := filepath.Join(directory, "0.3.39-release-"+id)
	if e = installArchiveIn(trusted, next, "0.3.39", directory); e != nil {
		t.Fatal("offline preparation", e)
	}
	if bundleVersion(next) != "0.3.39" {
		t.Fatal("prepared version")
	}
	os.WriteFile(source, []byte("tampered"), 0600)
	immutable, _ := os.ReadFile(trusted)
	if !bytes.Equal(immutable, data.Bytes()) {
		t.Fatal("root snapshot changed")
	}
	if _, e = prepareUploadedBundle(inbox, directory, job); e == nil || e.Error() != "checksum-mismatch" {
		t.Fatal("modified upload accepted", e)
	}
	entries, _ := os.ReadDir(directory)
	if len(entries) != 2 {
		t.Fatal("failed snapshot was not cleaned")
	}
	for _, change := range []relay.M{{"source": "unknown"}, {"source": 123}, {"sha256": strings.Repeat("0", 63)}, {"size": float64(129.5)}, {"size": float64(relay.MaxServerUpdateBytes + 1)}, {"method": "git"}, {"id": "../outside"}} {
		bad := relay.M{}
		for k, v := range job {
			bad[k] = v
		}
		bad["phase"] = "queued"
		for k, v := range change {
			bad[k] = v
		}
		if ValidUpdate(bad) {
			t.Fatal("invalid upload accepted", change)
		}
	}
	os.Remove(source)
	if e = os.Symlink(trusted, source); e != nil {
		t.Log("symlinks unavailable; existing symlink coverage applies on Linux")
		return
	}
	if _, e = prepareUploadedBundle(inbox, directory, job); e == nil {
		t.Fatal("symlink upload accepted")
	}
}
