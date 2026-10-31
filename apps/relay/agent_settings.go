package relay

import (
	"net/http"
	"sort"
)

const defaultSyncThreads = 20
const maxSyncThreads = 30

func (s *Store) AgentSettings() M {
	return M{"threadLimit": num(s.One("SELECT thread_limit FROM agent_settings WHERE id=1")["thread_limit"])}
}
func (s *Server) agentSettingsRoutes() {
	s.route("GET /v1/admin/agent-settings", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		return s.Store.AgentSettings()
	})
	s.route("PUT /v1/admin/agent-settings", "admin", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		b := body(r)
		n, ok := b["threadLimit"].(float64)
		if !ok || len(b) != 1 || n < 1 || n > maxSyncThreads || n != float64(int(n)) {
			fail(400, "invalid-agent-settings")
		}
		s.Store.Q("UPDATE agent_settings SET thread_limit=$1 WHERE id=1", int(n))
		settings := s.Store.AgentSettings()
		s.mu.Lock()
		peers := make([]*Peer, 0, len(s.agents))
		for _, peer := range s.agents {
			peers = append(peers, peer)
		}
		s.mu.Unlock()
		for _, peer := range peers {
			peer.Send(M{"type": "device.settings", "threadLimit": settings["threadLimit"]})
		}
		return settings
	})
}

// Old clients still validate a maximum of 20 previews. Project only their
// outgoing state; the device catalog, stored snapshot and histories stay intact.
func legacySnapshot(snapshot M, preferred string) M {
	threads := obj(snapshot["threads"])
	if len(threads) <= defaultSyncThreads {
		return snapshot
	}
	ids := make([]string, 0, len(threads))
	for id := range threads {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := ids[i], ids[j]
		if (a == preferred) != (b == preferred) {
			return a == preferred
		}
		ta, tb := obj(threads[a]), obj(threads[b])
		if (ta["status"] == "active") != (tb["status"] == "active") {
			return ta["status"] == "active"
		}
		if num(ta["updatedAt"]) != num(tb["updatedAt"]) {
			return num(ta["updatedAt"]) > num(tb["updatedAt"])
		}
		return a < b
	})
	result := M{}
	for key, value := range snapshot {
		result[key] = value
	}
	selected := M{}
	for _, id := range ids[:defaultSyncThreads] {
		selected[id] = threads[id]
	}
	result["threads"] = selected
	return result
}
func legacyReplaySafe(snapshot M, events []M) bool {
	ids := map[string]bool{}
	for id := range obj(snapshot["threads"]) {
		ids[id] = true
	}
	for _, event := range events {
		change := obj(event["change"])
		if change["type"] == "thread.updated" {
			ids[str(obj(change["thread"])["id"])] = true
		}
		if change["type"] == "thread.removed" {
			ids[str(change["threadId"])] = true
		}
	}
	return len(ids) <= defaultSyncThreads
}
