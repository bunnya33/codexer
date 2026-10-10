package relay

import (
	"github.com/shirou/gopsutil/v4/process"
	"os"
	"runtime"
	"sync"
	"time"
)

var bounds = []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000}

type histogram struct {
	Count      int64
	Total, Max float64
	Buckets    [11]int64
}

func (h *histogram) add(ms float64) {
	h.Count++
	h.Total += ms
	if ms > h.Max {
		h.Max = ms
	}
	i := 10
	for n, b := range bounds {
		if ms <= b {
			i = n
			break
		}
	}
	h.Buckets[i]++
}
func (h histogram) view() M {
	percent := func(p float64) float64 {
		sum := int64(0)
		for i, n := range h.Buckets {
			sum += n
			if h.Count > 0 && float64(sum) >= float64(h.Count)*p {
				if i < 10 {
					return bounds[i]
				}
				return h.Max
			}
		}
		return 0
	}
	buckets := []M{}
	for i, n := range h.Buckets {
		var bound any
		if i < 10 {
			bound = bounds[i]
		}
		buckets = append(buckets, M{"upperMs": bound, "count": n})
	}
	mean := float64(0)
	if h.Count > 0 {
		mean = h.Total / float64(h.Count)
	}
	return M{"count": h.Count, "meanMs": mean, "maxMs": h.Max, "p50Ms": percent(.5), "p95Ms": percent(.95), "p99Ms": percent(.99), "buckets": buckets}
}

type Metrics struct {
	mu          sync.Mutex
	start       time.Time
	h           map[string]*histogram
	counts      map[string]int64
	lastCleanup M
}

func NewMetrics() *Metrics {
	return &Metrics{start: time.Now(), h: map[string]*histogram{}, counts: map[string]int64{}}
}
func (m *Metrics) Observe(name string, start time.Time, failed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.h[name] == nil {
		m.h[name] = &histogram{}
	}
	m.h[name].add(float64(time.Since(start).Microseconds()) / 1000)
	if failed {
		m.counts[name+"Errors"]++
	}
}
func (m *Metrics) Inc(name string, n int64) { m.mu.Lock(); m.counts[name] += n; m.mu.Unlock() }
func (m *Metrics) Snapshot() M {
	m.mu.Lock()
	defer m.mu.Unlock()
	view := func(k string) M {
		if m.h[k] == nil {
			return (histogram{}).view()
		}
		return m.h[k].view()
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	rss := mem.Sys
	user, system := float64(0), float64(0)
	if p, e := process.NewProcess(int32(os.Getpid())); e == nil {
		if info, e := p.MemoryInfo(); e == nil {
			rss = info.RSS
		}
		if cpu, e := p.Times(); e == nil {
			user = cpu.User * 1e6
			system = cpu.System * 1e6
		}
	}

	queues := M{}
	for _, lane := range []string{"device", "exclusive", "maintenance"} {
		queues[lane] = M{"wait": view(lane + "Wait"), "run": view(lane + "Run")}
	}
	return M{"capturedAt": now(), "process": M{"uptimeSeconds": time.Since(m.start).Seconds(), "memoryBytes": M{"rss": rss, "heapTotal": mem.HeapSys, "heapUsed": mem.HeapAlloc, "external": mem.OtherSys, "arrayBuffers": 0}, "cpuMicroseconds": M{"user": user, "system": system}, "eventLoop": M{"monitoring": false, "utilization": 0, "delayMeanMs": 0, "delayMaxMs": 0, "delayP95Ms": 0, "delayP99Ms": 0}, "goroutines": runtime.NumGoroutine()}, "database": M{"queries": view("database"), "errors": m.counts["databaseErrors"], "transactions": view("transactions"), "transactionErrors": m.counts["transactionsErrors"]}, "queues": queues, "http": M{"requests": view("http"), "serverErrors": m.counts["httpErrors"]}, "events": M{"processing": view("events"), "errors": m.counts["eventsErrors"]}, "transport": M{"broadcast": view("broadcast"), "broadcastRecipients": m.counts["recipients"], "sentMessages": m.counts["sentMessages"], "sentBytes": m.counts["sentBytes"], "backpressureCloses": m.counts["backpressure"], "oversizedCloses": m.counts["oversized"]}, "cleanup": M{"runs": view("cleanup"), "deletedRows": m.counts["cleanupDeleted"], "errors": m.counts["cleanupErrors"], "cappedRuns": m.counts["cleanupCapped"], "lastRun": m.lastCleanup}}
}

func (s *Server) MetricSnapshot() M {
	m := s.metrics.Snapshot()
	s.mu.Lock()
	devices, clients, subscriptions := len(s.agents), 0, 0
	unique := map[string]bool{}
	buffered, maxBuffered := int64(0), int64(0)
	for _, p := range s.agents {
		n := p.buffered.Load()
		buffered += n
		if n > maxBuffered {
			maxBuffered = n
		}
	}
	for p := range s.clients {
		if p.Principal() != nil {
			clients++
		}
		for id := range p.devices {
			unique[id] = true
			subscriptions++
		}
		n := p.buffered.Load()
		buffered += n
		if n > maxBuffered {
			maxBuffered = n
		}
	}
	counts := map[string]int{}
	for _, p := range s.pending {
		counts[p.Kind]++
	}
	s.mu.Unlock()
	m["connections"] = M{"onlineDevices": devices, "onlineClients": clients, "pendingFiles": counts["file"], "pendingHistory": counts["history"], "pendingImages": counts["image"], "subscriptions": subscriptions, "subscriptionDevices": len(unique), "bufferedBytes": buffered, "maxBufferedBytes": maxBuffered}
	m["scheduler"] = M{"lanes": M{"device": M{"running": s.deviceRunning.Load(), "waiting": s.deviceWaiting.Load(), "completed": s.deviceCompleted.Load()}, "exclusive": M{"running": s.exclusiveRunning.Load(), "waiting": s.exclusiveWaiting.Load(), "completed": s.exclusiveCompleted.Load()}, "maintenance": M{"running": s.maintenanceRunning.Load(), "waiting": 0, "completed": s.maintenanceCompleted.Load()}}}
	return m
}
