package relay

import (
	"net/http"
	"time"
)

// Resource samples are request/reply only: no command journal, database writes,
// telemetry history or background collection on the relay.
func (s *Server) agentResourceRoutes() {
	s.route("GET /v1/devices/{deviceId}/resources", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		id := r.PathValue("deviceId")
		pending := &Pending{Device: id, Kind: "resources", ID: uuid(), Principal: p, Reply: make(chan response, 1)}
		s.lane(id, func() {
			s.deviceAccess(r, p)
			a := s.agent(id)
			if a == nil {
				fail(409, "device-offline")
			}
			a.mu.Lock()
			supported := a.resources
			a.mu.Unlock()
			if !supported {
				fail(409, "agent-update-required")
			}
			s.addPending(pending, 64, 4)
			if !a.Send(M{"type": "resources.request", "requestId": pending.ID}) {
				s.removePending(pending.ID)
				fail(409, "device-offline")
			}
		})
		value := s.wait(r.Context(), pending, 8*time.Second)
		if s.Store.SessionHash(p.Hash, "") == nil {
			fail(401, "unauthorized")
		}
		s.deviceAccess(r, p)
		return value
	})
}
