package relay

import (
	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const messageLimit = 8 * 1024 * 1024

// A bounded writer prevents a slow consumer from retaining an unbounded event history.
type Peer struct {
	s               *Server
	ws              *websocket.Conn
	mu              sync.Mutex
	principal       *Principal
	devices         map[string]bool
	files, previews bool
	lastPong        atomic.Int64
	queue           chan []byte
	done            chan struct{}
	once            sync.Once
	buffered        atomic.Int64
	inbound         atomic.Int64
}

func (p *Peer) Principal() *Principal { p.mu.Lock(); defer p.mu.Unlock(); return p.principal }
func (p *Peer) Close(code int, reason string) {
	p.once.Do(func() {
		close(p.done)
		if p.ws != nil {
			_ = p.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
			_ = p.ws.Close()
		}
	})
}
func (p *Peer) Send(v any) bool { return p.sendBytes([]byte(js(v))) }
func (p *Peer) sendBytes(b []byte) bool {
	if len(b) > messageLimit {
		p.s.metrics.Inc("oversized", 1)
		p.Close(1009, "payload-too-large")
		return false
	}
	select {
	case <-p.done:
		return false
	default:
	}
	if p.buffered.Add(int64(len(b))) > 16*1024*1024 {
		p.buffered.Add(-int64(len(b)))
		p.s.metrics.Inc("backpressure", 1)
		p.Close(1013, "backpressure")
		return false
	}
	select {
	case p.queue <- b:
		p.s.metrics.Inc("sentMessages", 1)
		p.s.metrics.Inc("sentBytes", int64(len(b)))
		return true
	default:
		p.buffered.Add(-int64(len(b)))
		p.s.metrics.Inc("backpressure", 1)
		p.Close(1013, "backpressure")
		return false
	}
}
func (s *Server) peer(w http.ResponseWriter, r *http.Request, p *Principal) *Peer {
	up := websocket.Upgrader{CheckOrigin: s.originAllowed, ReadBufferSize: 4096, WriteBufferSize: 4096, EnableCompression: false}
	ws, e := up.Upgrade(w, r, nil)
	if e != nil {
		return nil
	}
	peer := &Peer{s: s, ws: ws, principal: p, devices: map[string]bool{}, queue: make(chan []byte, 128), done: make(chan struct{})}
	peer.lastPong.Store(now())
	ws.SetReadLimit(messageLimit)
	ws.SetPongHandler(func(string) error { peer.lastPong.Store(now()); return nil })
	if !s.beginJob() {
		peer.Close(1001, "relay-closing")
		return nil
	}
	go func() {
		defer s.wg.Done()
		defer peer.Close(1001, "connection-closed")
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-peer.done:
				return
			case b := <-peer.queue:
				_ = ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
				e := ws.WriteMessage(websocket.TextMessage, b)
				peer.buffered.Add(-int64(len(b)))
				if e != nil {
					return
				}
			}
		}
	}()
	return peer
}
func (s *Server) Broadcast(device string, m any) {
	start := time.Now()
	defer s.metrics.Observe("broadcast", start, false)
	s.mu.Lock()
	targets := []*Peer{}
	for p := range s.clients {
		if p.devices[device] {
			targets = append(targets, p)
		}
	}
	s.mu.Unlock()
	b := []byte(js(m))
	for _, p := range targets {
		if p.sendBytes(b) {
			s.metrics.Inc("recipients", 1)
		}
	}
}
func (s *Server) BroadcastAccount(id string, m any) {
	s.mu.Lock()
	targets := []*Peer{}
	for p := range s.clients {
		if q := p.Principal(); q != nil && q.ID == id {
			targets = append(targets, p)
		}
	}
	s.mu.Unlock()
	for _, p := range targets {
		p.Send(m)
	}
}
func (s *Server) CloseSessions(matches func(*Principal) bool, reason string) {
	s.mu.Lock()
	targets := []*Peer{}
	ids := []string{}
	for p := range s.clients {
		if q := p.Principal(); q != nil && matches(q) {
			delete(s.clients, p)
			targets = append(targets, p)
		}
	}
	for id, p := range s.agents {
		if q := p.Principal(); q != nil && matches(q) {
			delete(s.agents, id)
			targets = append(targets, p)
			ids = append(ids, id)
		}
	}
	pending := []*Pending{}
	for id, v := range s.pending {
		if v.Principal != nil && matches(v.Principal) {
			delete(s.pending, id)
			pending = append(pending, v)
		}
	}
	s.mu.Unlock()
	for _, v := range pending {
		v.Reject(Fault{401, reason})
	}
	for _, p := range targets {
		p.Close(4003, reason)
	}
	for _, id := range ids {
		s.FailPending(id, reason)
		s.Broadcast(id, M{"type": "device.presence", "deviceId": id, "online": false})
	}
}
func (s *Server) heartbeat() {
	s.mu.Lock()
	pendingPrincipals := map[string]*Principal{}
	for _, p := range s.pending {
		if p.Principal != nil {
			pendingPrincipals[p.Principal.Hash] = p.Principal
		}
	}
	s.mu.Unlock()
	for h, p := range pendingPrincipals {
		if s.Store.SessionHash(h, p.Device) == nil {
			s.CloseSessions(func(v *Principal) bool { return v.Hash == h }, "session-expired")
		}
	}

	for _, row := range s.Store.Q("SELECT DISTINCT device_id FROM commands WHERE status='pending' AND expires_at<$1", now()-5000) {
		id := str(row["device_id"])
		s.lane(id, func() {
			for _, r := range s.Store.Q("UPDATE commands SET status='unknown',result="+s.Store.jsonObject("'commandId',id,'deviceId',device_id,'status','unknown','code','command-outcome-unconfirmed'")+" WHERE status='pending' AND device_id=$1 AND expires_at<$2 RETURNING result", id, now()-5000) {
				v := obj(r["result"])
				s.Broadcast(id, M{"type": "command.result", "result": v})
				if s.wx != nil {
					s.wx.CommandResult(v)
				}
			}
		})
	}

	s.mu.Lock()
	peers := []*Peer{}
	for _, p := range s.agents {
		peers = append(peers, p)
	}
	for p := range s.clients {
		peers = append(peers, p)
	}
	s.mu.Unlock()
	for _, p := range peers {
		q := p.Principal()
		if q != nil && s.Store.SessionHash(q.Hash, q.Device) == nil {
			s.CloseSessions(func(v *Principal) bool { return v.Hash == q.Hash }, "session-expired")
			continue
		}
		if now()-p.lastPong.Load() > 45000 {
			p.Close(1001, "heartbeat-timeout")
			continue
		}
		_ = p.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second))
	}
}
func (s *Server) deviceSocket(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		fail(403, "origin-denied")
	}
	id := r.Header.Get("X-Device-Id")
	q := s.Store.Session(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), id)
	if q == nil || q.Kind != "user" || id == "" {
		fail(401, "unauthorized")
	}
	p := s.peer(w, r, q)
	if p == nil {
		return
	}
	if !s.beginJob() {
		p.Close(1001, "relay-closing")
		return
	}
	go func() {
		defer s.wg.Done()
		defer p.Close(1001, "connection-closed")
		defer s.safe(func() {
			s.lane(id, func() {
				s.mu.Lock()
				current := s.agents[id] == p
				if current {
					delete(s.agents, id)
				}
				s.mu.Unlock()
				if current {
					s.FailPending(id, "device-offline")
					s.Store.Q("UPDATE devices SET last_seen_at=$2 WHERE id=$1", id, now())
					s.Broadcast(id, M{"type": "device.presence", "deviceId": id, "online": false})
				}
			})
		})
		defer func() {
			if e := recover(); e != nil {
				code := 1011
				reason := "storage-error"
				if f, ok := e.(Fault); ok {
					code = 1008
					reason = f.Code
				}
				p.Close(code, reason)
			}
		}()
		s.lane(id, func() {
			if s.Store.SessionHash(q.Hash, id) == nil {
				p.Close(4003, "revoked")
				return
			}
			s.mu.Lock()
			old := s.agents[id]
			s.agents[id] = p
			s.mu.Unlock()
			if old != nil {
				s.FailPending(id, "connection-replaced")
				old.Close(4001, "connection-replaced")
			}
			s.Store.Q("UPDATE devices SET last_seen_at=$2 WHERE id=$1", id, now())
			p.Send(M{"type": "device.welcome", "deviceId": id, "protocolVersion": 1, "features": []string{"catalog", "history", "images", "files", "previews"}})
			s.Broadcast(id, M{"type": "device.presence", "deviceId": id, "online": true})
		})
		for {
			kind, b, e := p.ws.ReadMessage()
			if e != nil {
				return
			}
			if kind != websocket.TextMessage {
				p.Close(1003, "text-required")
				return
			}
			var m M
			if json.Unmarshal(b, &m) != nil {
				p.Close(1008, "invalid-message")
				return
			}
			sanitize(m)
			s.Validate("device", m)
			if m["type"] == "device.preview" {
				if s.agent(id) == p {
					s.acceptPreview(id, m)
				}
				continue
			}
			size := int64(len(b))
			if p.inbound.Add(size) > 16*1024*1024 {
				p.inbound.Add(-size)
				p.Close(1013, "backpressure")
				return
			}
			if !s.enqueueLane(id, func() {
				defer p.inbound.Add(-size)
				defer func() {
					if e := recover(); e != nil {
						code, reason := 1011, "storage-error"
						if f, ok := e.(Fault); ok {
							code, reason = 1008, f.Code
						} else {
							logStorageFailure(e)
						}
						p.Close(code, reason)
					}
				}()
				if s.agent(id) != p {
					return
				}
				if s.Store.SessionHash(q.Hash, id) == nil {
					p.Close(4003, "session-expired")
					return
				}
				switch m["type"] {
				case "device.capabilities":
					p.mu.Lock()
					for _, f := range list(m["features"]) {
						if f == "files" {
							p.files = true
						}
						if f == "previews" {
							p.previews = true
						}
					}
					p.mu.Unlock()
				case "device.file", "device.history", "device.image":
					s.acceptTransfer(id, m)
				case "device.snapshot":
					v := obj(m["snapshot"])
					if v["deviceId"] != id {
						fail(400, "device-mismatch")
					}
					s.Store.SaveSnapshot(v)
					s.Broadcast(id, m)
				case "device.catalog":
					v := obj(m["catalog"])
					if v["deviceId"] != id {
						fail(400, "device-mismatch")
					}
					s.Store.SaveCatalog(v)
					s.Broadcast(id, M{"type": "catalog.updated", "deviceId": id, "generatedAt": v["generatedAt"]})
				case "device.event":
					v := obj(m["event"])
					if v["deviceId"] != id {
						fail(400, "device-mismatch")
					}
					func() {
						defer func() {
							if e := recover(); e != nil {
								if f, ok := e.(Fault); ok && f.Code == "sequence-gap" {
									p.Send(M{"type": "device.resync", "reason": "sequence-gap"})
								} else {
									panic(e)
								}
							}
						}()
						s.Store.SaveEvent(v)
						s.Broadcast(id, m)
					}()
				case "command.result":
					v := obj(m["result"])
					if v["deviceId"] != id {
						fail(400, "device-mismatch")
					}
					if s.Store.Finish(v) {
						s.Broadcast(id, m)
						if s.wx != nil {
							s.wx.CommandResult(v)
						}
					}
				}
			}) {
				p.inbound.Add(-size)
				return
			}
		}
	}()
}
func (s *Server) clientSocket(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		ws, e := up.Upgrade(w, r, nil)
		if e == nil {
			ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "origin-denied"), time.Now().Add(time.Second))
			ws.Close()
		}
		return
	}
	p := s.peer(w, r, nil)
	if p == nil {
		return
	}
	s.mu.Lock()
	s.clients[p] = true
	s.mu.Unlock()
	timer := time.AfterFunc(5*time.Second, func() { p.Close(1008, "authentication-required") })
	if !s.beginJob() {
		timer.Stop()
		s.mu.Lock()
		delete(s.clients, p)
		s.mu.Unlock()
		p.Close(1001, "relay-closing")
		return
	}
	go func() {
		defer s.wg.Done()
		defer timer.Stop()
		defer p.Close(1001, "connection-closed")
		defer func() { s.mu.Lock(); delete(s.clients, p); s.mu.Unlock() }()
		window := now()
		count := 0
		for {
			kind, b, e := p.ws.ReadMessage()
			if e != nil {
				return
			}
			if kind != websocket.TextMessage {
				p.Close(1003, "text-required")
				return
			}
			if now()-window > 60000 {
				window = now()
				count = 0
			}
			count++
			if count > 60 {
				p.Close(1008, "rate-limited")
				return
			}
			func() {
				defer func() {
					if e := recover(); e != nil {
						if f, ok := e.(Fault); ok {
							if f.Code == "invalid-message" {
								p.Close(1008, f.Code)
							} else {
								p.Send(M{"type": "error", "code": f.Code})
							}
						} else {
							p.Send(M{"type": "error", "code": "server-error"})
						}
					}
				}()
				var m M
				if json.Unmarshal(b, &m) != nil {
					p.Close(1008, "invalid-message")
					return
				}
				s.Validate("client", m)
				if m["type"] == "client.authenticate" {
					if p.Principal() != nil {
						p.Close(1008, "invalid-ticket")
						return
					}
					q := s.Store.ConsumeTicket(str(m["ticket"]))
					if q == nil {
						p.Close(1008, "invalid-ticket")
						return
					}
					p.mu.Lock()
					p.principal = q
					p.mu.Unlock()
					timer.Stop()
					p.Send(M{"type": "client.authenticated", "protocolVersion": 1})
					return
				}
				q := p.Principal()
				if q == nil {
					p.Close(1008, "authentication-required")
					return
				}
				if s.Store.SessionHash(q.Hash, "") == nil {
					p.Close(4003, "session-expired")
					return
				}
				id := str(m["deviceId"])
				if m["type"] == "client.command" {
					id = str(obj(m["command"])["deviceId"])
				}
				s.lane(id, func() {
					if !s.Store.Owns(id, q) {
						fail(404, "device-not-found")
					}
					if m["type"] == "client.command" {
						c := obj(m["command"])
						s.Validate("command", c)
						p.Send(s.Submit(c, b))
						return
					}
					snapshot := s.Store.Snapshot(id)
					if snapshot == nil {
						fail(404, "snapshot-not-found")
					}
					s.mu.Lock()
					if len(p.devices) >= 20 && !p.devices[id] {
						s.mu.Unlock()
						fail(400, "subscription-limit")
					}
					if !s.clients[p] {
						s.mu.Unlock()
						return
					}
					p.devices[id] = true
					s.mu.Unlock()
					var events []M
					replay := false
					if m["epoch"] != nil && m["lastSeq"] != nil {
						events, replay = s.Store.Replay(id, str(m["epoch"]), num(m["lastSeq"]))
					}
					mode := "snapshot"
					if replay {
						mode = "replay"
					}
					p.Send(M{"type": "sync.begin", "deviceId": id, "epoch": snapshot["epoch"], "lastSeq": snapshot["lastSeq"], "mode": mode})
					if replay {
						for _, v := range events {
							p.Send(M{"type": "device.event", "event": v})
						}
					} else {
						p.Send(M{"type": "device.snapshot", "snapshot": snapshot})
					}
					p.Send(M{"type": "sync.ready", "deviceId": id, "epoch": snapshot["epoch"], "lastSeq": snapshot["lastSeq"]})
					p.Send(M{"type": "device.presence", "deviceId": id, "online": s.agent(id) != nil})
				})
			}()
		}
	}()
}
func (s *Server) Submit(c M, raw ...[]byte) M {
	id, cid := str(c["deviceId"]), str(c["commandId"])
	h := commandHash(c, raw...)
	if old := s.Store.Command(id, cid); old != nil {
		if old["payload_hash"] != h {
			fail(409, "command-id-reused")
		}
		if old["result"] != nil {
			return M{"type": "command.result", "result": old["result"]}
		}
		return M{"type": "command.accepted", "commandId": cid}
	}
	expiry := num(c["expiresAt"])
	if expiry <= now() || expiry > now()+300000 {
		fail(400, "invalid-command-expiry")
	}
	p := s.agent(id)
	if p == nil {
		fail(409, "device-offline")
	}
	head := s.Store.One("SELECT epoch FROM snapshots WHERE device_id=$1", id)
	if head == nil || head["epoch"] != c["expectedEpoch"] {
		fail(409, "stale-device-epoch")
	}
	payload := obj(c["payload"])
	thread := str(payload["threadId"])
	for _, image := range list(payload["images"]) {
		if s.Store.Image(id, thread, str(image), true) == nil {
			fail(400, "image-not-in-thread")
		}
		s.Store.Q("UPDATE images SET expires_at=NULL WHERE device_id=$1 AND thread_id=$2 AND id=$3", id, thread, image)
	}
	s.Store.Q("INSERT INTO commands(device_id,id,payload_hash,status,expires_at,created_at) VALUES($1,$2,$3,'pending',$4,$5)", id, cid, h, expiry, now())
	if !p.Send(M{"type": "command", "command": c}) {
		result := M{"deviceId": id, "commandId": cid, "status": "unknown", "code": "dispatch-unconfirmed"}
		s.Store.Finish(result)
		return M{"type": "command.result", "result": result}
	}
	return M{"type": "command.accepted", "commandId": cid}
}
