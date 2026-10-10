package relay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"
)

func (s *Store) Binding(user string) M {
	return s.One("SELECT b.* FROM weixin_bindings b JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 AND u.revoked_at IS NULL AND u.role='user' AND u.password_hash IS NOT NULL", user)
}
func (s *Store) Target(user, device, thread string) string {
	if r := s.One("SELECT code FROM weixin_targets WHERE user_id=$1 AND device_id=$2 AND thread_id=$3", user, device, thread); r != nil {
		return str(r["code"])
	}
	for {
		b := make([]byte, 4)
		rand.Read(b)
		code := "C" + strings.ToUpper(hex.EncodeToString(b))
		if s.One("INSERT INTO weixin_targets(user_id,code,device_id,thread_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING code", user, code, device, thread) != nil {
			return code
		}
		if r := s.One("SELECT code FROM weixin_targets WHERE user_id=$1 AND device_id=$2 AND thread_id=$3", user, device, thread); r != nil {
			return str(r["code"])
		}
	}
}
func (s *Store) ResolveTarget(user, code string) M {
	return s.One("SELECT t.code,t.device_id,t.thread_id FROM weixin_targets t JOIN devices d ON d.id=t.device_id JOIN users u ON u.id=t.user_id WHERE t.user_id=$1 AND t.code=$2 AND d.owner_user_id=t.user_id AND d.revoked_at IS NULL AND u.revoked_at IS NULL AND u.role='user'", user, code)
}
func (s *Store) ThreadNotification(user, device, thread string) bool {
	return s.One("SELECT 1 FROM weixin_thread_notifications WHERE user_id=$1 AND device_id=$2 AND thread_id=$3", user, device, thread) != nil
}
func (s *Store) Enqueue(binding, key, kind, text, device, code string) {
	if num(s.One("SELECT COUNT(*) AS total FROM weixin_outbox WHERE binding_id=$1 AND state='pending'", binding)["total"]) >= 200 {
		s.Q("UPDATE weixin_bindings SET send_error='weixin-queue-full' WHERE id=$1", binding)
		return
	}
	s.Q("INSERT INTO weixin_outbox(binding_id,id,kind,text,client_id,next_attempt_at,created_at,device_id,target_code) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8) ON CONFLICT DO NOTHING", binding, key, kind, truncate(strings.ReplaceAll(text, "\x00", ""), 3900), "codexer-"+uuid(), now(), nullable(device), nullable(code))
}
func truncate(v string, n int) string {
	r := []rune(v)
	if len(r) > n {
		return string(r[:n])
	}
	return v
}
func (s *Store) Completions(before, after M) {
	if before == nil {
		return
	}
	for id, v := range obj(after["threads"]) {
		thread := obj(v)
		previous := obj(obj(before["threads"])[id])
		if len(previous) == 0 {
			continue
		}
		for _, entry := range list(thread["turns"]) {
			turn := obj(entry)
			if turn["status"] != "completed" {
				continue
			}
			var old M
			for _, t := range list(previous["turns"]) {
				if obj(t)["id"] == turn["id"] {
					old = obj(t)
					break
				}
			}
			fresh := old == nil && turn["startedAtMs"] != nil && turn["completedAtMs"] != nil && num(turn["startedAtMs"]) >= num(before["generatedAt"])-1000 && num(turn["completedAtMs"]) >= num(before["generatedAt"])
			if old["status"] != "inProgress" && previous["activeTurnId"] != turn["id"] && !fresh {
				continue
			}
			row := s.One("SELECT b.*,d.name AS device_name,c.payload AS catalog FROM devices d JOIN users u ON u.id=d.owner_user_id JOIN weixin_bindings b ON b.user_id=u.id LEFT JOIN catalogs c ON c.device_id=d.id WHERE d.id=$1 AND d.revoked_at IS NULL AND u.revoked_at IS NULL AND u.role='user'", after["deviceId"])
			if row == nil {
				continue
			}
			user, device := str(row["user_id"]), str(after["deviceId"])
			if !boolean(row["notifications"]) && !s.ThreadNotification(user, device, id) {
				continue
			}
			if turn["completedAtMs"] != nil && num(turn["completedAtMs"]) < num(row["created_at"]) {
				continue
			}
			code := s.Target(user, device, id)
			catalog := obj(row["catalog"])
			project := str(thread["cwd"])
			if project == "" {
				project = "未分组项目"
			}
			for _, t := range list(catalog["threads"]) {
				if obj(t)["id"] == id {
					for _, p := range list(catalog["projects"]) {
						if obj(p)["id"] == obj(t)["projectId"] {
							project = str(obj(p)["name"])
						}
					}
				}
			}
			summary := "请打开 Codexer 查看执行结果。"
			items := list(turn["items"])
			for pass := 0; pass < 2; pass++ {
				found := false
				for n := len(items) - 1; n >= 0; n-- {
					item := obj(items[n])
					if item["type"] == "agentMessage" && (pass == 1 || item["phase"] == "final_answer") {
						summary = truncate(strings.TrimSpace(str(item["text"])), 1000)
						found = true
						break
					}
				}
				if found {
					break
				}
			}
			text := "本轮执行完成\n设备：" + truncate(str(row["device_name"]), 150) + "\n项目：" + truncate(project, 300) + "\n会话：" + truncate(str(thread["title"]), 300) + "\n编号：" + code + "\n\n" + summary + "\n\n直接回复你的下一步要求即可续做。收到多个会话的通知时，默认继续最近一条对应的会话。"
			s.Enqueue(str(row["id"]), "completion:"+device+":"+id+":"+str(turn["id"]), "completion", text, device, code)
		}
	}
}
func (s *Store) Delivered(binding, id string, remember bool) {
	s.Tx(func(t *Store) {
		r := t.One("UPDATE weixin_outbox SET state='sent',error=NULL WHERE binding_id=$1 AND id=$2 AND state='pending' RETURNING target_code", binding, id)
		var code any
		if remember && r != nil {
			code = r["target_code"]
		}
		t.Q("UPDATE weixin_bindings SET send_error=NULL,reply_target_code=COALESCE($2,reply_target_code) WHERE id=$1", binding, code)
	})
}
func (s *Store) Cleanup(ctx context.Context) (capped bool) {
	start := time.Now()
	deleted := int64(0)
	defer func() {
		e := recover()
		s.Metrics.Observe("cleanup", start, e != nil)
		if e != nil {
			panic(e)
		}
	}()
	entries := []struct {
		table, predicate, order, key string
		args                         []any
	}{{"events", "created_at<$1", "created_at", "device_id,epoch,seq", []any{now() - 86400000}}, {"tickets", "expires_at<$1", "expires_at", "hash", []any{now()}}, {"sessions", "expires_at<$1", "expires_at", "hash", []any{now()}}, {"images", "expires_at<$1", "expires_at", "device_id,thread_id,id", []any{now()}}, {"images", "device_id IN(SELECT id FROM devices WHERE revoked_at IS NOT NULL)", "device_id,thread_id,id", "device_id,thread_id,id", nil}, {"weixin_outbox", "state<>'pending' AND created_at<$1", "created_at", "binding_id,id", []any{now() - 30*86400000}}, {"weixin_inbox", "created_at<$1", "created_at", "binding_id,id", []any{now() - 30*86400000}}}
	summary := M{}
	for _, e := range entries {
		count := 0
		for batch := 0; batch < 20; batch++ {
			if ctx.Err() != nil {
				return
			}
			keys := e.key
			if strings.Contains(keys, ",") {
				keys = "(" + keys + ")"
			}
			rows := s.Q("DELETE FROM "+e.table+" WHERE ("+e.predicate+") AND "+keys+" IN(SELECT "+e.key+" FROM "+e.table+" WHERE "+e.predicate+" ORDER BY "+e.order+" LIMIT 500) RETURNING 1", e.args...)
			count += len(rows)
			if len(rows) < 500 {
				break
			}
			if batch == 19 {
				capped = true
				s.Metrics.Inc("cleanupCapped", 1)
			}
		}
		deleted += int64(count)
		summary[e.table] = count
	}
	s.Metrics.Inc("cleanupDeleted", deleted)
	s.Metrics.mu.Lock()
	s.Metrics.lastCleanup = M{"at": now(), "deletedRows": deleted, "summary": summary}
	s.Metrics.mu.Unlock()
	return
}
