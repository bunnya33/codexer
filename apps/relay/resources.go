package relay

import (
	"context"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/process"
)

type resourceMemory struct {
	TotalBytes     uint64  `json:"totalBytes"`
	UsedBytes      uint64  `json:"usedBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedPercent    float64 `json:"usedPercent"`
}
type resourceDisk struct {
	Label          string   `json:"label"`
	Mount          string   `json:"mount"`
	Filesystem     string   `json:"filesystem"`
	TotalBytes     *uint64  `json:"totalBytes"`
	UsedBytes      *uint64  `json:"usedBytes"`
	AvailableBytes *uint64  `json:"availableBytes"`
	UsedPercent    *float64 `json:"usedPercent"`
}
type resourceSnapshot struct {
	CapturedAt          int64    `json:"capturedAt"`
	SampleWindowSeconds *float64 `json:"sampleWindowSeconds"`
	CPUSampling         bool     `json:"cpuSampling"`
	Host                struct {
		Platform    string          `json:"platform"`
		LogicalCPUs int             `json:"logicalCpus"`
		CPUPercent  *float64        `json:"cpuPercent"`
		Memory      *resourceMemory `json:"memory"`
	} `json:"host"`
	Process struct {
		CPUPercent    *float64 `json:"cpuPercent"`
		RSSBytes      *uint64  `json:"rssBytes"`
		HeapBytes     uint64   `json:"heapBytes"`
		Goroutines    int      `json:"goroutines"`
		UptimeSeconds float64  `json:"uptimeSeconds"`
	} `json:"process"`
	Disks []resourceDisk `json:"disks"`
}
type resourceReading struct {
	at         time.Time
	totalCPU   *cpu.TimesStat
	processCPU *cpu.TimesStat
	view       resourceSnapshot
}
type resourceMonitor struct {
	mu       sync.Mutex
	previous *resourceReading
	cached   resourceSnapshot
	read     func(context.Context) resourceReading
	clock    func() time.Time
}

// On-demand, shared across administrators. No background worker or disk walk.
func newResourceMonitor(dataDir string, start time.Time) *resourceMonitor {
	return &resourceMonitor{clock: time.Now, read: func(ctx context.Context) resourceReading {
		return readResources(ctx, dataDir, start)
	}}
}
func cpuTotal(v *cpu.TimesStat) float64 {
	// Guest/GuestNice are already included in User/Nice on Linux.
	return v.User + v.Nice + v.System + v.Idle + v.Iowait + v.Irq + v.Softirq + v.Steal
}
func resourcePercent(v float64) *float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return nil
	}
	v = math.Min(v, 100)
	return &v
}
func (m *resourceMonitor) snapshot(ctx context.Context) resourceSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	ttl := 15 * time.Second
	if m.cached.CPUSampling {
		ttl = time.Second
	}
	if m.previous != nil && m.clock().Sub(m.previous.at) < ttl {
		return m.cached
	}
	current := m.read(ctx)
	v := current.view
	v.CapturedAt = current.at.UnixMilli()
	v.CPUSampling = current.totalCPU != nil
	if old := m.previous; old != nil && current.totalCPU != nil && old.totalCPU != nil {
		elapsed := current.at.Sub(old.at).Seconds()
		total := cpuTotal(current.totalCPU) - cpuTotal(old.totalCPU)
		idle := current.totalCPU.Idle + current.totalCPU.Iowait - old.totalCPU.Idle - old.totalCPU.Iowait
		// Returning after a long absence should show a fresh short sample,
		// rather than presenting an hours-long average as current CPU load.
		if elapsed >= 1 && elapsed <= 90 && total > 0 && idle >= 0 && idle <= total {
			v.CPUSampling = false
			v.SampleWindowSeconds = &elapsed
			v.Host.CPUPercent = resourcePercent((total - idle) / total * 100)
			if current.processCPU != nil && old.processCPU != nil {
				used := current.processCPU.User + current.processCPU.System - old.processCPU.User - old.processCPU.System
				v.Process.CPUPercent = resourcePercent(used / total * 100)
			}
		}
	}
	m.previous = &current
	m.cached = v
	return v
}
func readResources(ctx context.Context, dataDir string, start time.Time) resourceReading {
	r := resourceReading{at: time.Now()}
	r.view.Host.Platform = runtime.GOOS
	if count, err := cpu.CountsWithContext(ctx, true); err == nil {
		r.view.Host.LogicalCPUs = count
	}
	if values, err := cpu.TimesWithContext(ctx, false); err == nil && len(values) > 0 {
		r.totalCPU = &values[0]
	}
	if value, err := mem.VirtualMemoryWithContext(ctx); err == nil && value.Total > 0 {
		available := min(value.Available, value.Total)
		r.view.Host.Memory = &resourceMemory{TotalBytes: value.Total, UsedBytes: value.Total - available, AvailableBytes: available, UsedPercent: float64(value.Total-available) / float64(value.Total) * 100}
	}
	if p, err := process.NewProcessWithContext(ctx, int32(os.Getpid())); err == nil {
		if value, err := p.TimesWithContext(ctx); err == nil {
			r.processCPU = value
		}
		if value, err := p.MemoryInfoWithContext(ctx); err == nil {
			r.view.Process.RSSBytes = &value.RSS
		}
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	r.view.Process.HeapBytes = memory.HeapAlloc
	r.view.Process.Goroutines = runtime.NumGoroutine()
	r.view.Process.UptimeSeconds = time.Since(start).Seconds()
	r.view.Disks = readResourceDisks(ctx, dataDir)
	return r
}
func readResourceDisks(ctx context.Context, dataDir string) []resourceDisk {
	root := string(filepath.Separator)
	if runtime.GOOS == "windows" {
		root = filepath.VolumeName(os.Getenv("SystemRoot")) + string(filepath.Separator)
	}
	paths := []struct{ path, label string }{{root, "系统分区"}, {dataDir, "数据目录分区"}}
	partitions, _ := disk.PartitionsWithContext(ctx, false)
	result := []resourceDisk{}
	seen := map[string]int{}
	for _, target := range paths {
		if target.path == "" {
			continue
		}
		path, err := filepath.Abs(target.path)
		if err != nil {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			path = resolved
		}
		mount, fs := filepath.VolumeName(path)+string(filepath.Separator), ""
		for _, partition := range partitions {
			p := filepath.Clean(partition.Mountpoint)
			relative, err := filepath.Rel(p, path)
			if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && len(p) >= len(mount) {
				mount, fs = p, partition.Fstype
			}
		}
		key := mount
		if runtime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if index, ok := seen[key]; ok {
			result[index].Label += " / " + target.label
			continue
		}
		seen[key] = len(result)
		v := resourceDisk{Label: target.label, Mount: mount, Filesystem: fs}
		if value, err := disk.UsageWithContext(ctx, path); err == nil && value.Total > 0 {
			v.TotalBytes, v.UsedBytes, v.AvailableBytes = &value.Total, &value.Used, &value.Free
			v.UsedPercent = resourcePercent(value.UsedPercent)
		}
		result = append(result, v)
	}
	return result
}
func (s *Server) resourceRoutes() {
	s.route("GET /v1/admin/system/resources", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		return s.resources.snapshot(ctx)
	})
}
