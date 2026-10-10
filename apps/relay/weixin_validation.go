package relay

import (
	"encoding/json"
	"strings"
)

func wxString(m M, key string, limit int, required bool) {
	v, exists := m[key]
	if !exists && !required {
		return
	}
	s, ok := v.(string)
	if !ok || jsLength(s) > limit {
		fail(502, "weixin-invalid-response")
	}
}
func wxNumber(m M, key string) {
	if v, ok := m[key]; ok {
		if _, ok := v.(json.Number); !ok {
			fail(502, "weixin-invalid-response")
		}
	}
}
func validateWeixinPayload(path string, m M) {
	switch strings.SplitN(path, "?", 2)[0] {
	case "ilink/bot/get_bot_qrcode":
		wxString(m, "qrcode", 4096, true)
		wxString(m, "qrcode_img_content", 8192, true)
	case "ilink/bot/get_qrcode_status":
		for key, limit := range map[string]int{"bot_token": 16384, "ilink_bot_id": 256, "ilink_user_id": 256, "baseurl": 2048, "redirect_host": 256} {
			wxString(m, key, limit, false)
		}
		switch m["status"] {
		case "wait", "scaned", "confirmed", "expired", "need_verifycode", "verify_code_blocked", "scaned_but_redirect", "binded_redirect":
		default:
			fail(502, "weixin-invalid-response")
		}
	case "ilink/bot/getupdates":
		wxString(m, "get_updates_buf", 1024*1024, false)
		if v, ok := m["msgs"]; ok {
			messages, ok := v.([]any)
			if !ok || len(messages) > 1000 {
				fail(502, "weixin-invalid-response")
			}
			for _, raw := range messages {
				message, ok := raw.(map[string]any)
				if !ok {
					fail(502, "weixin-invalid-response")
				}
				for key, limit := range map[string]int{"from_user_id": 256, "context_token": 16384, "group_id": 2 * 1024 * 1024} {
					wxString(message, key, limit, false)
				}
				for _, key := range []string{"message_type", "message_state", "create_time_ms"} {
					wxNumber(message, key)
				}
				for _, key := range []string{"message_id", "seq"} {
					if v, ok := message[key]; ok {
						switch v.(type) {
						case string, json.Number:
						default:
							fail(502, "weixin-invalid-response")
						}
					}
				}
				if raw, ok := message["item_list"]; ok {
					items, ok := raw.([]any)
					if !ok || len(items) > 100 {
						fail(502, "weixin-invalid-response")
					}
					for _, raw := range items {
						item, ok := raw.(map[string]any)
						if !ok || item["type"] == nil {
							fail(502, "weixin-invalid-response")
						}
						wxNumber(item, "type")
						if raw, ok := item["text_item"]; ok {
							text, ok := raw.(map[string]any)
							if !ok {
								fail(502, "weixin-invalid-response")
							}
							wxString(text, "text", 32000, true)
						}
					}
				}
			}
		}
	}
}
