package relay

import (
	"os"
	"strings"
	"testing"
)

func TestUploadsSurviveRestartAndReleaseExpiredReservations(t *testing.T) {
	directory := t.TempDir()
	store, err := newUploadStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	u := upload{ID: strings.Repeat("a", 64), Device: "pc", Thread: "thread", Size: 1024, Offset: 3, Expires: now() + 60000}
	if err := os.WriteFile(store.path(u.ID, ".data"), []byte("abc"), 0600); err != nil {
		t.Fatal(err)
	}
	store.save(u)
	store.close()
	reopened, err := newUploadStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.load(u.ID); got.Offset != 3 || got.Size != 1024 {
		t.Fatal("unfinished upload lost on restart")
	}
	total, devices, count := reopened.cleanupLocked()
	if total != 1024 || devices["pc"] != 1024 || count != 1 {
		t.Fatal("reserve the entire declared size before receiving chunks")
	}
	u.Expires = now() - 1
	reopened.save(u)
	expectFault(t, "attachment-unavailable", func() { reopened.load(u.ID) })
	total, devices, count = reopened.cleanupLocked()
	if total != 0 || len(devices) != 0 || count != 0 {
		t.Fatal("expired reservation retained")
	}
	if _, err := os.Stat(reopened.path(u.ID, ".data")); !os.IsNotExist(err) {
		t.Fatal("expired upload retained on disk")
	}

	temporary, err := newUploadStore("")
	if err != nil {
		t.Fatal(err)
	}
	temporary.close()
	if _, err := os.Stat(temporary.directory); !os.IsNotExist(err) {
		t.Fatal("test upload directory retained after close")
	}
}
