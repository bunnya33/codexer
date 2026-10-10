package relay

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"github.com/gorilla/websocket"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed protocol/schemas.json
var schemaFile []byte

// Include Expo's _expo directory; embed otherwise skips underscore-prefixed files.
//
//go:embed all:assets
var bundled embed.FS

type Options struct {
	Version, WebRoot, AdminRoot, DataDir, UpdateDir, UpdateStatus string
	Origins                                                       []string
	Weixin                                                        bool
	WeixinBase                                                    string
	WeixinKey                                                     []byte
	CleanupInterval, HeartbeatInterval                            time.Duration
}
type Server struct {
	deviceRunning, deviceWaiting, deviceCompleted, exclusiveRunning, exclusiveWaiting, exclusiveCompleted atomic.Int64
	maintenanceRunning, maintenanceCompleted                                                              atomic.Int64

	Store        *Store
	Options      Options
	mux          *http.ServeMux
	schemas      map[string]*jsonschema.Schema
	schemaValues map[string]any
	mu           sync.Mutex
	agents       map[string]*Peer
	clients      map[*Peer]bool
	pending      map[string]*Pending
	previews     map[string]*Preview
	lanes        map[string]*deviceLane
	exclusive    sync.RWMutex
	auth         sync.Mutex
	limits       map[string]*rateWindow
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	closing      atomic.Bool
	metrics      *Metrics
	wx           *Weixin
	updates      *Updates
}
type deviceLane struct {
	tail chan struct{}
	refs int
}
type rateWindow struct {
	count int
	start int64
}

func New(store *Store, options Options) (*Server, error) {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{Store: store, Options: options, mux: http.NewServeMux(), schemas: map[string]*jsonschema.Schema{}, agents: map[string]*Peer{}, clients: map[*Peer]bool{}, pending: map[string]*Pending{}, previews: map[string]*Preview{}, limits: map[string]*rateWindow{}, lanes: map[string]*deviceLane{}, ctx: ctx, cancel: cancel, metrics: store.Metrics}
	var values map[string]any
	if e := json.Unmarshal(schemaFile, &values); e != nil {
		return nil, e
	}
	s.schemaValues = values
	c := jsonschema.NewCompiler()
	for name, v := range values {
		if e := c.AddResource("https://codexer.local/"+name, v); e != nil {
			return nil, e
		}
	}
	for name := range values {
		compiled, e := c.Compile("https://codexer.local/" + name)
		if e != nil {
			return nil, e
		}
		s.schemas[name] = compiled
	}
	s.updates = NewUpdates(options.Version, options.UpdateDir, options.UpdateStatus)
	if options.Weixin {
		wx, e := NewWeixin(s, options)
		if e != nil {
			cancel()
			return nil, e
		}
		s.wx = wx
	}
	s.routes()
	s.background()
	return s, nil
}
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		defer func() {
			if e := recover(); e != nil {
				if e == http.ErrAbortHandler {
					panic(e)
				}
				status, code := 500, "server-error"
				if f, ok := e.(Fault); ok {
					status, code = f.Status, f.Code
				}
				s.metrics.Observe("http", start, status >= 500)
				writeJSON(w, status, M{"error": code})
			} else {
				s.metrics.Observe("http", start, false)
			}
		}()
		if s.closing.Load() {
			fail(503, "relay-closing")
		}
		if len(r.URL.Path) > 16384 {
			fail(400, "invalid-request")
		}
		if strings.HasPrefix(r.URL.Path, "/v1/weixin") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if strings.HasPrefix(r.URL.Path, "/v1/") && !strings.HasPrefix(r.URL.Path, "/v1/previews/") {
			limit := 120
			key := r.RemoteAddr
			host := strings.LastIndex(key, ":")
			if host > 0 {
				key = key[:host]
			}
			if strings.Contains(r.URL.Path, "/login") {
				limit = 10
				key += "/login"
			}
			s.mu.Lock()
			window := s.limits[key]
			if window == nil || now()-window.start > 60000 {
				window = &rateWindow{start: now()}
				s.limits[key] = window
			}
			window.count++
			allowed := window.count <= limit
			s.mu.Unlock()
			if !allowed {
				fail(429, "rate-limited")
			}
		}
		if s.originAllowed(r) {
			if origin := r.Header.Get("Origin"); origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			}
		}
		s.mux.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func body(r *http.Request) M {
	b, e := io.ReadAll(io.LimitReader(r.Body, 8*1024*1024+1))
	if e != nil {
		fail(400, "invalid-request")
	}
	if len(b) > 8*1024*1024 {
		fail(413, "request-too-large")
	}
	if len(b) == 0 {
		return M{}
	}
	r.Body = io.NopCloser(bytes.NewReader(b))
	var m M
	if json.Unmarshal(b, &m) != nil || m == nil {
		fail(400, "invalid-request")
	}
	return m
}
func (s *Server) route(pattern string, role string, fn func(http.ResponseWriter, *http.Request, *Principal) any) {
	s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		var p *Principal
		requestRole := role
		if role == "user" && strings.Contains(pattern, "/v1/devices/{deviceId}") && !strings.Contains(pattern, "weixin-notification") {
			requestRole = "member"
		}
		if role != "" {
			p = s.principal(r, requestRole)
		}
		global := r.Method != "GET" && r.Method != "OPTIONS" && (strings.HasPrefix(r.URL.Path, "/v1/users") || strings.HasPrefix(r.URL.Path, "/v1/admin/accounts") || r.URL.Path == "/v1/admin/auth-settings" || r.URL.Path == "/v1/agents/login" || r.URL.Path == "/v1/auth/login" || r.URL.Path == "/v1/admin/auth/login" || r.URL.Path == "/v1/auth/logout")
		if global {
			waitStart := time.Now()
			s.exclusiveWaiting.Add(1)
			s.exclusive.Lock()
			s.metrics.Observe("exclusiveWait", waitStart, false)
			runStart := time.Now()
			s.exclusiveWaiting.Add(-1)
			s.exclusiveRunning.Add(1)
			defer func() {
				e := recover()
				s.metrics.Observe("exclusiveRun", runStart, e != nil)
				s.exclusiveRunning.Add(-1)
				s.exclusiveCompleted.Add(1)
				s.exclusive.Unlock()
				if e != nil {
					panic(e)
				}
			}()
			if p != nil && s.Store.SessionHash(p.Hash, "") == nil {
				fail(401, "unauthorized")
			}
		}
		v := fn(w, r, p)
		if v != nil {
			writeJSON(w, 200, v)
		}
	})
}
func (s *Server) principal(r *http.Request, role string) *Principal {
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, "Bearer ") {
		fail(401, "unauthorized")
	}
	p := s.Store.Session(strings.TrimPrefix(value, "Bearer "), "")
	if p == nil {
		fail(401, "unauthorized")
	}
	if role != "member" && p.Kind != role {
		if role == "admin" {
			fail(403, "admin-required")
		}
		fail(403, "control-account-required")
	}
	return p
}
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if origin == scheme+"://"+r.Host {
		return true
	}
	for _, allowed := range s.Options.Origins {
		if origin == allowed {
			return true
		}
	}
	return false
}
func (s *Server) deviceAccess(r *http.Request, p *Principal) {
	id := r.PathValue("deviceId")
	if !validID(id) || !s.Store.Owns(id, p) {
		fail(404, "device-not-found")
	}
}
func (s *Server) reserveLane(id string) func(func()) {
	s.deviceWaiting.Add(1)
	start := time.Now()
	s.exclusive.RLock()
	s.mu.Lock()
	lane := s.lanes[id]
	if lane == nil {
		ready := make(chan struct{})
		close(ready)
		lane = &deviceLane{tail: ready}
		s.lanes[id] = lane
	}
	previous := lane.tail
	done := make(chan struct{})
	lane.tail = done
	lane.refs++
	s.mu.Unlock()
	return func(fn func()) {
		<-previous
		s.deviceWaiting.Add(-1)
		s.deviceRunning.Add(1)
		defer func() {
			s.deviceRunning.Add(-1)
			s.deviceCompleted.Add(1)
			close(done)
			s.mu.Lock()
			lane.refs--
			if lane.refs == 0 {
				delete(s.lanes, id)
			}
			s.mu.Unlock()
			s.exclusive.RUnlock()
		}()
		s.metrics.Observe("deviceWait", start, false)
		runStart := time.Now()
		defer func() {
			e := recover()
			s.metrics.Observe("deviceRun", runStart, e != nil)
			if e != nil {
				panic(e)
			}
		}()
		fn()
	}
}
func (s *Server) lane(id string, fn func()) { s.reserveLane(id)(fn) }
func (s *Server) enqueueLane(id string, fn func()) bool {
	if !s.beginJob() {
		return false
	}
	run := s.reserveLane(id)
	go func() { defer s.wg.Done(); run(fn) }()
	return true
}
func (s *Server) Validate(name string, m M) {
	s.refine(name, m)
	projectProtocol(obj(s.schemaValues[name]), m)
	if e := s.schemas[name].Validate(m); e != nil {
		fail(400, "invalid-message")
	}
	if name == "command" {
		payload := obj(m["payload"])
		kind := str(payload["type"])
		if kind == "turn.start" || kind == "turn.queue" || kind == "turn.steer" {
			if strings.TrimSpace(str(payload["text"])) == "" && len(list(payload["images"])) == 0 {
				fail(400, "invalid-request")
			}
		}
	}
	if name == "device" {
		if m["type"] == "device.snapshot" {
			snapshot := obj(m["snapshot"])
			if len(obj(snapshot["threads"])) > 20 {
				fail(400, "invalid-message")
			}
			for id, t := range obj(snapshot["threads"]) {
				if str(obj(t)["id"]) != id || len(js(t)) > 256*1024 {
					fail(400, "invalid-message")
				}
			}
		}
		if m["type"] == "device.catalog" {
			catalog := obj(m["catalog"])
			if len(js(catalog)) > 6*1024*1024 {
				fail(400, "invalid-message")
			}
			for _, name := range []string{"projects", "threads"} {
				ids := map[string]bool{}
				for _, v := range list(catalog[name]) {
					id := str(obj(v)["id"])
					if ids[id] {
						fail(400, "invalid-message")
					}
					ids[id] = true
				}
			}
		}
	}
}
func (s *Server) agent(id string) *Peer { s.mu.Lock(); defer s.mu.Unlock(); return s.agents[id] }

// Adds and shutdown are serialized so upgrades cannot outlive a completed Close.
func (s *Server) beginJob() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing.Load() {
		return false
	}
	s.wg.Add(1)
	return true
}
func (s *Server) Close() {
	s.mu.Lock()
	if s.closing.Swap(true) {
		s.mu.Unlock()
		return
	}
	s.cancel()
	peers := []*Peer{}
	for _, p := range s.agents {
		peers = append(peers, p)
	}
	for p := range s.clients {
		peers = append(peers, p)
	}
	s.mu.Unlock()
	for _, p := range peers {
		p.Close(1001, "relay-closing")
	}
	s.wg.Wait()
}
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	isAdmin := strings.HasPrefix(r.URL.Path, "/admin/")
	root := s.Options.WebRoot
	folder := "web"
	if isAdmin {
		root = s.Options.AdminRoot
		folder = "admin"
	}
	var files fs.FS
	if root != "" {
		files = os.DirFS(root)
	} else {
		files, _ = fs.Sub(bundled, "assets/"+folder)
	}
	if files == nil {
		http.NotFound(w, r)
		return
	}
	rr := r.Clone(r.Context())
	if isAdmin {
		rr.URL.Path = strings.TrimPrefix(r.URL.Path, "/admin")
	}
	http.FileServerFS(files).ServeHTTP(w, rr)
}
func (s *Server) background() {
	heartbeat := s.Options.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = 15 * time.Second
	}
	cleanup := s.Options.CleanupInterval
	if cleanup <= 0 {
		cleanup = 5 * time.Minute
	}
	s.beginJob()
	go func() {
		defer s.wg.Done()
		tick := time.NewTicker(heartbeat)
		defer tick.Stop()
		clean := time.NewTimer(cleanup)
		defer clean.Stop()
		auto := time.NewTicker(6 * time.Hour)
		defer auto.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-tick.C:
				s.safe(func() { s.maintain(s.heartbeat) })
			case <-clean.C:
				clean.Reset(cleanup)
				s.safe(func() {
					s.maintain(func() {
						capped := s.Store.Cleanup(s.ctx)
						if capped {
							clean.Reset(5 * time.Second)
						} else {
							clean.Reset(cleanup)
						}
						s.mu.Lock()
						for k, v := range s.limits {
							if now()-v.start > 60000 {
								delete(s.limits, k)
							}
						}
						for k, v := range s.previews {
							if v.Expires <= now() {
								delete(s.previews, k)
							}
						}
						s.mu.Unlock()
					})
				})
			case <-auto.C:
				s.safe(func() { s.updates.AutoPrepare() })
			}
		}
	}()
	if s.wx != nil {
		s.wx.Start()
	}
}
func (s *Server) safe(fn func()) {
	defer func() {
		if recover() != nil {
			s.metrics.Inc("backgroundErrors", 1)
		}
	}()
	fn()
}

// Heartbeat and cleanup run serially in the background loop, with no separate
// waiting queue. Keep the existing metrics accurate for their actual work.
func (s *Server) maintain(fn func()) {
	start := time.Now()
	s.maintenanceRunning.Add(1)
	defer func() {
		e := recover()
		s.metrics.Observe("maintenanceRun", start, e != nil)
		s.maintenanceRunning.Add(-1)
		s.maintenanceCompleted.Add(1)
		if e != nil {
			panic(e)
		}
	}()
	fn()
}

var stableTag = regexp.MustCompile(`^v\d+\.\d+\.\d+$`)
var _ = filepath.Join
var _ = websocket.CloseNormalClosure
