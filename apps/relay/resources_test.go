package relay

import (
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
)

func TestResourceSamplingAndCache(t *testing.T) {
	now := time.Unix(1000, 0)
	reads := 0
	m := &resourceMonitor{clock: func() time.Time { return now }, read: func(context.Context) resourceReading {
		reads++
		total := &cpu.TimesStat{User: 200, Idle: 800, Guest: 100}
		proc := &cpu.TimesStat{User: 10}
		if reads > 1 {
			total = &cpu.TimesStat{User: 260, Idle: 940, Guest: 150}
			proc.User = 14
		}
		return resourceReading{at: now, totalCPU: total, processCPU: proc, view: resourceSnapshot{Disks: []resourceDisk{}}}
	}}
	ctx := context.Background()
	first := m.snapshot(ctx)
	if !first.CPUSampling || first.Host.CPUPercent != nil || first.Process.CPUPercent != nil {
		t.Fatal("initial sample must not pretend to be zero CPU")
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() { m.snapshot(ctx) })
	}
	wg.Wait()
	if reads != 1 {
		t.Fatal("concurrent requests bypassed shared cache", reads)
	}
	now = now.Add(2 * time.Second)
	v := m.snapshot(ctx)
	if v.CPUSampling || v.Host.CPUPercent == nil || *v.Host.CPUPercent != 30 || v.Process.CPUPercent == nil || *v.Process.CPUPercent != 2 || *v.SampleWindowSeconds != 2 {
		t.Fatalf("wrong interval or whole-machine CPU rates: %+v", v)
	}
	now = now.Add(10 * time.Second)
	if cached := m.snapshot(ctx); cached.CapturedAt != v.CapturedAt || reads != 2 {
		t.Fatal("fresh sample was needlessly recollected")
	}
	now = now.Add(6 * time.Second)
	m.snapshot(ctx)
	if reads != 3 {
		t.Fatal("cache never expires")
	}
	now = now.Add(2 * time.Minute)
	if v := m.snapshot(ctx); !v.CPUSampling || v.Host.CPUPercent != nil || v.SampleWindowSeconds != nil {
		t.Fatal("long idle period must establish a fresh CPU baseline")
	}
}

func TestResourceUnavailableAndReset(t *testing.T) {
	for _, next := range []*cpu.TimesStat{nil, {User: 1, Idle: 1}, {User: 2, Idle: 200}, {User: math.NaN(), Idle: 300}} {
		at := time.Unix(100, 0)
		old := resourceReading{at: at, totalCPU: &cpu.TimesStat{User: 100, Idle: 200}, processCPU: &cpu.TimesStat{User: 10}}
		m := &resourceMonitor{previous: &old, clock: func() time.Time { return at.Add(30 * time.Second) }, read: func(context.Context) resourceReading {
			return resourceReading{at: at.Add(30 * time.Second), totalCPU: next, processCPU: &cpu.TimesStat{User: 1}}
		}}
		v := m.snapshot(context.Background())
		if v.Host.CPUPercent != nil || v.Process.CPUPercent != nil || v.Host.Memory != nil || v.Process.RSSBytes != nil {
			t.Fatal("unavailable or reset counters produced fabricated metrics")
		}
		if _, err := json.Marshal(v); err != nil {
			t.Fatal("non-JSON metric", err)
		}
	}
}

func TestAdminResourceRoutes(t *testing.T) {
	store, s, p, device := fixture(t)
	admin := str(store.CreateUser("resource-admin", "test-password-12345", "admin")["id"])
	session := str(store.CreateSession(admin, "")["session"])
	agent := str(store.CreateSession(p.ID, device)["session"])
	for _, test := range []struct {
		session string
		status  int
	}{{"", 401}, {sessionToken(store, p), 403}, {agent, 401}, {session, 200}} {
		req := httptest.NewRequest("GET", "/v1/admin/system/resources", nil)
		if test.session != "" {
			req.Header.Set("Authorization", "Bearer "+test.session)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, req)
		if w.Code != test.status {
			t.Fatalf("resource status %d != %d: %s", w.Code, test.status, w.Body)
		}
		if w.Code == 200 {
			var v resourceSnapshot
			if json.Unmarshal(w.Body.Bytes(), &v) != nil || v.CapturedAt <= 0 || v.Host.Platform == "" || v.Process.HeapBytes == 0 || v.Process.Goroutines == 0 || len(v.Disks) == 0 {
				t.Fatal("missing actual host/process/disk sample", w.Body)
			}
			if w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), p.ID) || strings.Contains(w.Body.String(), session) {
				t.Fatal("cache or sensitive data exposed")
			}
		}
	}
}

func TestResourceDiskTargets(t *testing.T) {
	data := t.TempDir()
	check := func(t *testing.T, path string) {
		t.Helper()
		v := readResourceDisks(context.Background(), path)
		if len(v) < 1 || len(v) > 2 {
			t.Fatal("must only inspect system and data filesystems", v)
		}
		for _, item := range v {
			if strings.Contains(item.Label, "数据目录") {
				if item.TotalBytes == nil || *item.TotalBytes == 0 || item.UsedPercent == nil {
					t.Fatal("data filesystem missing", item)
				}
				return
			}
		}
		t.Fatal("data filesystem not included")
	}
	check(t, data)
	t.Run("symlink", func(t *testing.T) {
		link := filepath.Join(t.TempDir(), "data-link")
		if err := os.Symlink(data, link); err != nil {
			t.Skip("symlinks unavailable on this host")
		}
		check(t, link)
	})
}
