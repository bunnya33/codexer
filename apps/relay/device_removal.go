package relay

import "net/http"

// Removing cached data is deliberately separate from revoking credentials.
// Keep only the installation identity and its existing session so an unchanged
// Agent can authenticate again and publish a fresh snapshot/catalog.
func (s *Store) RemoveDeviceData(id string) []string {
	keys := []string{}
	s.Tx(func(t *Store) {
		t.Q("INSERT INTO removed_devices(device_id,removed_at) VALUES($1,$2) ON CONFLICT(device_id) DO UPDATE SET removed_at=EXCLUDED.removed_at", id, now())
		for _, row := range t.Q("SELECT token FROM preview_shares WHERE device_id=$1", id) {
			keys = append(keys, str(row["token"]))
		}
		// Clear reply targets before deleting their per-device routing records.
		t.Q("UPDATE weixin_bindings SET reply_target_code=NULL WHERE reply_target_code IN(SELECT code FROM weixin_targets WHERE device_id=$1)", id)
		for _, table := range []string{"preview_shares", "weixin_targets", "weixin_thread_notifications", "weixin_outbox", "weixin_inbox", "images", "commands", "events", "catalogs", "snapshot_threads", "snapshots"} {
			t.Q("DELETE FROM "+table+" WHERE device_id=$1", id)
		}
	})
	return keys
}

func (s *Server) removeDeviceRoutes() {
	s.route("DELETE /v1/devices/{deviceId}/data", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		id := r.PathValue("deviceId")
		s.lane(id, func() {
			if p.Kind != "user" || s.Store.SessionHash(p.Hash, "") == nil {
				fail(404, "device-not-found")
			}
			// Allow retry after a partial filesystem failure, but never expose
			// another account's device or restore a revoked device.
			if !validID(id) || s.Store.One("SELECT id FROM devices WHERE id=$1 AND owner_user_id=$2 AND revoked_at IS NULL", id, p.ID) == nil {
				fail(404, "device-not-found")
			}
			if s.agent(id) != nil {
				fail(409, "device-online")
			}
			for _, key := range s.Store.RemoveDeviceData(id) {
				s.closePreviewShare(key)
			}
			s.FailPending(id, "device-removed")
			s.mu.Lock()
			for token, preview := range s.previews {
				if preview.Device == id {
					delete(s.previews, token)
				}
			}
			for token, audio := range s.audio {
				if audio.Device == id {
					audio.cancel()
					delete(s.audio, token)
				}
			}
			for client := range s.clients {
				delete(client.devices, id)
			}
			s.mu.Unlock()
			s.uploads.removeDevice(id)
			s.BroadcastAccount(p.ID, M{"type": "device.removed", "deviceId": id})
		})
		return M{"removed": true}
	})
}
