package relay

import (
	"net/http"
	"regexp"
	"strings"
)

func (s *Server) weixinRoutes() {
	required := func() *Weixin {
		if s.wx == nil {
			fail(503, "weixin-disabled")
		}
		return s.wx
	}
	for _, method := range []string{"GET", "PUT"} {
		method := method
		s.route(method+" /v1/devices/{deviceId}/threads/{threadId}/weixin-notification", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
			w.Header().Set("Cache-Control", "no-store")
			device, thread := r.PathValue("deviceId"), r.PathValue("threadId")
			var enabled *bool
			if method == "PUT" {
				b := body(r)
				v, ok := b["enabled"].(bool)
				if len(b) != 1 || !ok {
					fail(400, "invalid-request")
				}
				enabled = &v
			}
			var notification M
			s.lane(device, func() {
				s.authorizeThread(p, device, thread, false)
				if enabled != nil {
					s.Store.Tx(func(t *Store) {
						if *enabled {
							t.Q("INSERT INTO weixin_thread_notifications(user_id,device_id,thread_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", p.ID, device, thread)
						} else {
							t.Q("DELETE FROM weixin_thread_notifications WHERE user_id=$1 AND device_id=$2 AND thread_id=$3", p.ID, device, thread)
							t.Q("DELETE FROM weixin_outbox WHERE kind='completion' AND device_id=$2 AND binding_id IN(SELECT id FROM weixin_bindings WHERE user_id=$1 AND notifications=FALSE) AND target_code IN(SELECT code FROM weixin_targets WHERE user_id=$1 AND device_id=$2 AND thread_id=$3)", p.ID, device, thread)
						}
					})
				}
				binding := s.Store.Binding(p.ID)
				notification = M{"enabled": s.Store.ThreadNotification(p.ID, device, thread), "allEnabled": boolean(binding["notifications"]), "available": s.wx != nil, "bound": binding != nil}
				if enabled != nil {
					s.BroadcastAccount(p.ID, M{"type": "weixin.thread-notification", "deviceId": device, "threadId": thread, "notification": notification})
				}
			})
			return notification
		})
	}
	s.route("GET /v1/weixin", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		if s.wx != nil {
			return s.wx.Status(p.ID)
		}
		return M{"available": false, "bound": false, "connected": false, "activated": false, "notifications": true, "replies": true, "lastError": nil, "pendingNotifications": 0}
	})
	s.route("POST /v1/weixin/login", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any { return required().Login(p.ID) })
	s.route("POST /v1/weixin/login/{loginId}/poll", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		b := body(r)
		verify := strings.TrimSpace(str(b["verifyCode"]))
		if len(b) > 1 || b["verifyCode"] != nil && !regexp.MustCompile(`^[a-zA-Z0-9]{1,16}$`).MatchString(verify) || !uuidPattern.MatchString(r.PathValue("loginId")) {
			fail(400, "invalid-request")
		}
		return required().PollLogin(p.ID, r.PathValue("loginId"), verify)
	})
	s.route("PUT /v1/weixin", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		wx := required()
		b := body(r)
		_, n := b["notifications"].(bool)
		_, v := b["replies"].(bool)
		if len(b) != 2 || !n || !v {
			fail(400, "invalid-request")
		}
		if s.Store.Binding(p.ID) == nil {
			fail(409, "weixin-not-bound")
		}
		s.Store.Tx(func(t *Store) {
			t.Q("UPDATE weixin_bindings SET notifications=$2,replies=$3 WHERE user_id=$1", p.ID, b["notifications"], b["replies"])
			if !boolean(b["notifications"]) {
				t.Q("DELETE FROM weixin_outbox WHERE binding_id IN(SELECT id FROM weixin_bindings WHERE user_id=$1) AND kind='completion' AND NOT EXISTS(SELECT 1 FROM weixin_targets t JOIN weixin_thread_notifications n ON n.user_id=t.user_id AND n.device_id=t.device_id AND n.thread_id=t.thread_id WHERE t.user_id=$1 AND t.code=weixin_outbox.target_code)", p.ID)
			}
		})
		status := wx.Status(p.ID)
		s.BroadcastAccount(p.ID, M{"type": "weixin.settings", "status": status})
		return status
	})
	s.route("DELETE /v1/weixin", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		wx := required()
		wx.mu.Lock()
		if l := wx.logins[p.ID]; l != nil {
			l.cancel()
			delete(wx.logins, p.ID)
		}
		wx.mu.Unlock()
		s.Store.Q("DELETE FROM weixin_bindings WHERE user_id=$1", p.ID)
		wx.reconcile()
		return M{"unbound": true}
	})
	s.route("POST /v1/weixin/test", "user", func(w http.ResponseWriter, r *http.Request, p *Principal) any {
		required()
		b := s.Store.Binding(p.ID)
		if b == nil {
			fail(409, "weixin-not-bound")
		}
		if b["context"] == nil {
			fail(409, "weixin-not-activated")
		}
		s.Store.Enqueue(str(b["id"]), "test:"+uuid(), "test", "Codexer 微信连接测试：你的账号已绑定。所属电脑的任务完成后，会在这里发送设备、项目、会话和结果摘要。", "", "")
		return M{"queued": true}
	})
}
