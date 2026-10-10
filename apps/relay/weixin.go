package relay

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/skip2/go-qrcode"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const weixinBase = "https://ilinkai.weixin.qq.com"
const wxHelp = "Codexer 微信助手\n直接回复下一步要求，继续最近收到通知或提交确认的会话。\n发送「设备」查看电脑；发送「会话」或「会话 2」查看会话编号。\n切换会话可发送「继续 C会话编号 下一步要求」。\n审批与提问请在 Codexer 中处理。"

type WxLogin struct {
	ID, User, QR, Image, Base, Status string
	Expires                           int64
	Polling                           bool
	ctx                               context.Context
	cancel                            context.CancelFunc
}
type Weixin struct {
	s       *Server
	key     []byte
	client  *http.Client
	mu      sync.Mutex
	logins  map[string]*WxLogin
	runners map[string]context.CancelFunc
}

func NewWeixin(s *Server, o Options) (*Weixin, error) {
	key := o.WeixinKey
	if len(key) == 0 {
		dir := o.DataDir
		if dir == "" {
			return nil, fmt.Errorf("weixin-requires-data-dir-or-key")
		}
		path := filepath.Join(dir, "weixin.key")
		data, e := os.ReadFile(path)
		if os.IsNotExist(e) {
			key = make([]byte, 32)
			if _, e = rand.Read(key); e != nil {
				return nil, e
			}
			e = os.WriteFile(path, []byte(hex.EncodeToString(key)+"\n"), 0600)
			if e != nil {
				return nil, e
			}
		} else if e != nil {
			return nil, e
		} else {
			key, e = hex.DecodeString(strings.TrimSpace(string(data)))
			if e != nil {
				return nil, e
			}
		}
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("invalid-weixin-key")
	}
	return &Weixin{s: s, key: key, client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, logins: map[string]*WxLogin{}, runners: map[string]context.CancelFunc{}}, nil
}
func wxURL(raw string) string {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || !strings.HasSuffix(strings.ToLower(u.Hostname()), ".weixin.qq.com") {
		fail(502, "weixin-invalid-host")
	}
	return "https://" + u.Host
}
func (w *Weixin) seal(text, scope string) string {
	b, e := aes.NewCipher(w.key)
	if e != nil {
		panic(e)
	}
	g, _ := cipher.NewGCM(b)
	iv := make([]byte, 12)
	rand.Read(iv)
	c := g.Seal(nil, iv, []byte(text), []byte(scope))
	wire := append(iv, c[len(c)-16:]...)
	wire = append(wire, c[:len(c)-16]...)
	return base64.StdEncoding.EncodeToString(wire)
}
func (w *Weixin) open(text, scope string) string {
	wire, e := base64.StdEncoding.DecodeString(text)
	if e != nil || len(wire) < 28 {
		fail(502, "weixin-invalid-secret")
	}
	b, _ := aes.NewCipher(w.key)
	g, _ := cipher.NewGCM(b)
	c := append(append([]byte{}, wire[28:]...), wire[12:28]...)
	plain, e := g.Open(nil, wire[:12], c, []byte(scope))
	if e != nil {
		fail(502, "weixin-invalid-secret")
	}
	return string(plain)
}
func scope(b M, field string) string { return str(b["user_id"]) + ":" + str(b["id"]) + ":" + field }
func (w *Weixin) api(ctx context.Context, base, path string, payload M, secret string, timeout time.Duration) M {
	base = wxURL(base)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	method := "GET"
	var body io.Reader
	if payload != nil {
		method = "POST"
		if secret != "" {
			payload["base_info"] = M{"channel_version": "2.4.9", "bot_agent": "Codexer/" + w.s.Options.Version}
		}
		body = strings.NewReader(js(payload))
	}
	req, e := http.NewRequestWithContext(ctx, method, base+"/"+path, body)
	if e != nil {
		fail(502, "weixin-network-error")
	}
	req.Header.Set("iLink-App-Id", "bot")
	req.Header.Set("iLink-App-ClientVersion", "132105")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("AuthorizationType", "ilink_bot_token")
		b := make([]byte, 4)
		rand.Read(b)
		req.Header.Set("X-WECHAT-UIN", base64.StdEncoding.EncodeToString([]byte(fmt.Sprint(binary.BigEndian.Uint32(b)))))
	}
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	res, e := w.client.Do(req)
	if e != nil {
		fail(502, "weixin-network-error")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		fail(502, "weixin-http-error")
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024+1))
	if e != nil || len(data) > 2*1024*1024 {
		fail(502, "weixin-response-too-large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var m M
	if decoder.Decode(&m) != nil || m == nil {
		fail(502, "weixin-invalid-response")
	}
	for _, k := range []string{"ret", "errcode"} {
		if v, present := m[k]; present {
			number, ok := v.(json.Number)
			if !ok {
				fail(502, "weixin-invalid-response")
			}
			if _, e := number.Int64(); e != nil {
				fail(502, "weixin-invalid-response")
			}
			if num(v) == -14 {
				fail(502, "weixin-session-expired")
			}
			if num(v) != 0 {
				fail(502, "weixin-api-error")
			}
		}
	}
	validateWeixinPayload(path, m)
	return m
}
func (w *Weixin) Status(user string) M {
	b := w.s.Store.Binding(user)
	v := M{"available": true, "bound": false, "connected": false, "activated": false, "notifications": true, "replies": true, "lastError": nil, "pendingNotifications": 0}
	if b != nil {
		v["bound"] = true
		v["botId"] = b["bot_id"]
		v["connected"] = b["poll_error"] == nil && b["last_poll_at"] != nil && now()-num(b["last_poll_at"]) < 90000
		v["activated"] = str(b["context"]) != ""
		v["notifications"] = boolean(b["notifications"])
		v["replies"] = boolean(b["replies"])
		v["lastError"] = b["poll_error"]
		if v["lastError"] == nil {
			v["lastError"] = b["send_error"]
		}
		v["pendingNotifications"] = num(w.s.Store.One("SELECT COUNT(*) AS total FROM weixin_outbox WHERE binding_id=$1 AND state='pending'", b["id"])["total"])
	}
	return v
}
func loginView(l *WxLogin) M {
	v := M{"loginId": l.ID, "status": l.Status, "expiresAt": l.Expires}
	if l.Image != "" {
		v["qrImage"] = l.Image
	}
	return v
}
func (w *Weixin) Login(user string) M {
	ctx, cancel := context.WithCancel(w.s.ctx)
	l := &WxLogin{ID: uuid(), User: user, Base: weixinBase, Status: "wait", Expires: now() + 300000, ctx: ctx, cancel: cancel}
	w.mu.Lock()
	if old := w.logins[user]; old != nil {
		old.cancel()
	} else if len(w.logins) >= 1000 {
		w.mu.Unlock()
		cancel()
		fail(429, "weixin-login-busy")
	}
	w.logins[user] = l
	w.mu.Unlock()
	defer func() {
		if e := recover(); e != nil {
			w.mu.Lock()
			if w.logins[user] == l {
				delete(w.logins, user)
			}
			w.mu.Unlock()
			cancel()
			panic(e)
		}
	}()
	qr := w.api(ctx, l.Base, "ilink/bot/get_bot_qrcode?bot_type=3", M{"local_token_list": []any{}}, "", 15*time.Second)
	if str(qr["qrcode"]) == "" || jsLength(str(qr["qrcode"])) > 4096 || str(qr["qrcode_img_content"]) == "" || jsLength(str(qr["qrcode_img_content"])) > 8192 {
		fail(502, "weixin-invalid-response")
	}
	png, e := qrcode.Encode(str(qr["qrcode_img_content"]), qrcode.Medium, 256)
	if e != nil {
		fail(502, "weixin-invalid-response")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.logins[user] != l || ctx.Err() != nil {
		fail(409, "weixin-login-expired")
	}
	l.QR = str(qr["qrcode"])
	l.Image = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	return loginView(l)
}
func (w *Weixin) PollLogin(user, id, verify string) M {
	w.mu.Lock()
	l := w.logins[user]
	if l == nil || l.ID != id {
		w.mu.Unlock()
		fail(404, "weixin-login-not-found")
	}
	if l.Expires < now() {
		l.Status = "expired"
	}
	if l.Status == "confirmed" || l.Status == "expired" || l.Status == "verify_code_blocked" || l.Polling {
		v := loginView(l)
		w.mu.Unlock()
		return v
	}
	l.Polling = true
	base, qr := l.Base, l.QR
	w.mu.Unlock()
	defer func() { w.mu.Lock(); l.Polling = false; w.mu.Unlock() }()
	path := "ilink/bot/get_qrcode_status?qrcode=" + url.QueryEscape(qr)
	if verify != "" {
		path += "&verify_code=" + url.QueryEscape(verify)
	}
	result := w.api(l.ctx, base, path, nil, "", 35*time.Second)
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.logins[user] != l || l.ctx.Err() != nil || l.Expires < now() {
		fail(409, "weixin-login-expired")
	}
	if w.s.Store.One("SELECT id FROM users WHERE id=$1 AND role='user' AND revoked_at IS NULL AND password_hash IS NOT NULL", user) == nil {
		fail(409, "weixin-account-inactive")
	}
	switch result["status"] {
	case "scaned_but_redirect":
		l.Base = wxURL("https://" + str(result["redirect_host"]))
		l.Status = "scaned"
	case "binded_redirect":
		fail(409, "weixin-already-connected")
	case "confirmed":
		bot, peer, secret := str(result["ilink_bot_id"]), str(result["ilink_user_id"]), str(result["bot_token"])
		if bot == "" || peer == "" || secret == "" || jsLength(secret) > 16384 || jsLength(bot) > 256 || jsLength(peer) > 256 {
			fail(502, "weixin-invalid-response")
		}
		newBase := l.Base
		if result["baseurl"] != nil {
			newBase = wxURL(str(result["baseurl"]))
		}
		b := M{"id": uuid(), "user_id": user}
		w.s.Store.Tx(func(t *Store) {
			if t.One("SELECT id FROM users WHERE id=$1 AND role='user' AND revoked_at IS NULL AND password_hash IS NOT NULL FOR UPDATE", user) == nil {
				fail(409, "weixin-account-inactive")
			}
			if t.One("SELECT id FROM weixin_bindings WHERE (bot_id=$1 OR peer_id=$2) AND user_id<>$3", bot, peer, user) != nil {
				fail(409, "weixin-already-connected")
			}
			t.Q("DELETE FROM weixin_bindings WHERE user_id=$1", user)
			if t.One("INSERT INTO weixin_bindings(id,user_id,bot_id,peer_id,base_url,token,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id", b["id"], user, bot, peer, newBase, w.seal(secret, scope(b, "token")), now()) == nil {
				fail(409, "weixin-already-connected")
			}
		})
		l.Status = "confirmed"
		l.Image = ""
	case "wait", "scaned", "expired", "need_verifycode", "verify_code_blocked":
		l.Status = str(result["status"])
	default:
		fail(502, "weixin-invalid-response")
	}
	return loginView(l)
}
func pause(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
func (w *Weixin) Start() {
	if !w.s.beginJob() {
		return
	}
	go func() {
		defer w.s.wg.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		defer func() {
			w.mu.Lock()
			for _, c := range w.runners {
				c()
			}
			for _, l := range w.logins {
				l.cancel()
			}
			w.mu.Unlock()
		}()
		for {
			select {
			case <-w.s.ctx.Done():
				return
			case <-ticker.C:
				w.s.safe(w.reconcile)
			}
		}
	}()
}
func (w *Weixin) reconcile() {
	bindings := w.s.Store.Q("SELECT b.* FROM weixin_bindings b JOIN users u ON u.id=b.user_id WHERE u.revoked_at IS NULL AND u.role='user' AND u.password_hash IS NOT NULL")
	w.mu.Lock()
	defer w.mu.Unlock()
	ids := map[string]bool{}
	for _, b := range bindings {
		ids[str(b["id"])] = true
	}
	for id, cancel := range w.runners {
		if !ids[id] {
			cancel()
			delete(w.runners, id)
		}
	}
	for _, b := range bindings {
		id := str(b["id"])
		if w.runners[id] != nil {
			continue
		}
		ctx, cancel := context.WithCancel(w.s.ctx)
		w.runners[id] = cancel
		for _, kind := range []string{"poll", "send"} {
			if !w.s.beginJob() {
				cancel()
				return
			}
			go func(b M, kind string) {
				defer w.s.wg.Done()
				failures := 0
				for ctx.Err() == nil {
					delay := time.Second
					func() {
						defer func() {
							if e := recover(); e != nil {
								code := "weixin-unavailable"
								if f, ok := e.(Fault); ok {
									code = f.Code
								}
								w.s.safe(func() { w.s.Store.Q("UPDATE weixin_bindings SET "+kind+"_error=$2 WHERE id=$1", id, code) })
								if code == "weixin-session-expired" {
									delay = time.Hour
								} else {
									delay = time.Duration(min(60000, 2000*(1<<min(failures, 5)))) * time.Millisecond
								}
								failures++
							}
						}()
						current := w.current(b, ctx)
						if current == nil {
							cancel()
							return
						}
						if kind == "poll" {
							w.poll(current, ctx)
						} else {
							w.send(current, ctx)
						}
						failures = 0
					}()
					if !pause(ctx, delay) {
						return
					}
				}
			}(b, kind)
		}
	}
	for user, l := range w.logins {
		if l.Expires < now() {
			l.cancel()
			delete(w.logins, user)
		}
	}
}
func (w *Weixin) current(b M, ctx context.Context) M {
	if ctx.Err() != nil {
		return nil
	}
	current := w.s.Store.Binding(str(b["user_id"]))
	if current == nil || current["id"] != b["id"] {
		return nil
	}
	return current
}
func (w *Weixin) poll(b M, ctx context.Context) {
	cursor := ""
	if b["cursor"] != nil {
		cursor = w.open(str(b["cursor"]), scope(b, "cursor"))
	}
	result := w.api(ctx, str(b["base_url"]), "ilink/bot/getupdates", M{"get_updates_buf": cursor}, w.open(str(b["token"]), scope(b, "token")), 40*time.Second)
	if w.current(b, ctx) == nil {
		return
	}
	msgs := list(result["msgs"])
	if len(msgs) > 1000 || jsLength(str(result["get_updates_buf"])) > 1024*1024 {
		fail(502, "weixin-invalid-response")
	}
	for _, msg := range msgs {
		if w.current(b, ctx) == nil {
			return
		}
		w.receive(b, obj(msg), ctx)
	}
	var encoded any
	if result["get_updates_buf"] != nil {
		encoded = w.seal(str(result["get_updates_buf"]), scope(b, "cursor"))
	}
	w.s.Store.Q("UPDATE weixin_bindings SET cursor=COALESCE($2,cursor),last_poll_at=$3,poll_error=NULL WHERE id=$1", b["id"], encoded, now())
}
func (w *Weixin) receive(b, m M, ctx context.Context) {
	if num(m["message_type"]) != 1 || m["from_user_id"] != b["peer_id"] || str(m["group_id"]) != "" || (m["message_state"] != nil && num(m["message_state"]) != 0 && num(m["message_state"]) != 2) {
		return
	}
	id := str(m["message_id"])
	if id == "" {
		id = str(m["seq"])
	}
	if id == "" {
		return
	}
	store := w.s.Store
	if store.One("INSERT INTO weixin_inbox(binding_id,id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", b["id"], id, now()) == nil {
		return
	}
	if context := str(m["context_token"]); context != "" && jsLength(context) <= 16384 {
		store.Q("UPDATE weixin_bindings SET context=$2,last_poll_at=$3,poll_error=NULL WHERE id=$1", b["id"], w.seal(context, scope(b, "context")), now())
		store.Q("UPDATE weixin_outbox SET next_attempt_at=$2 WHERE binding_id=$1 AND state='pending'", b["id"], now())
	}
	parts := []string{}
	for _, item := range list(m["item_list"]) {
		if num(obj(item)["type"]) == 1 {
			parts = append(parts, str(obj(obj(item)["text_item"])["text"]))
		}
	}
	text := strings.TrimSpace(strings.Join(parts, "\n"))
	if jsLength(text) > 32000 {
		fail(502, "weixin-invalid-response")
	}
	reply, code := "目前支持文字指令。\n"+wxHelp, ""
	if text != "" {
		func() {
			defer func() {
				if e := recover(); e != nil {
					reply = "指令未确认，请打开 Codexer 核对会话状态后再试。"
					if f, ok := e.(Fault); ok {
						switch f.Code {
						case "device-offline":
							reply = "目标电脑离线，指令未提交。请启动 PC 连接器后重新发送。"
						case "device-not-found", "weixin-target-not-found":
							reply = "找不到这个账号下的会话编号。发送「会话」查看你的会话。"
						case "weixin-replies-disabled":
							reply = "微信续做已关闭，请在 Codexer 的微信设置中开启。"
						case "weixin-thread-unavailable":
							reply = "会话暂不可操作，请先在 Codexer 打开该会话，确认连接后再试。"
						}
					}
				}
			}()
			reply, code = w.handleText(b, text, num(m["create_time_ms"]), id, ctx)
		}()
	}
	if w.current(b, ctx) != nil {
		store.Enqueue(str(b["id"]), "reply:"+id, "reply", reply, "", code)
	}
}

var wxList = regexp.MustCompile(`^(?:会话|列表)(?:\s+(\d{1,4}))?$`)
var wxContinue = regexp.MustCompile(`(?i)^继续\s+(C[A-F0-9]{8})\s+([\s\S]+)$`)
var wxMalformed = regexp.MustCompile(`(?i)^继续\s+C\S*(?:\s|$)`)

func (w *Weixin) handleText(b M, text string, timestamp int64, messageID string, ctx context.Context) (string, string) {
	user := str(b["user_id"])
	p := &Principal{ID: user, Kind: "user"}
	store := w.s.Store
	if regexp.MustCompile(`(?i)^(帮助|help|你好|开始)$`).MatchString(text) {
		return wxHelp, ""
	}
	if text == "设备" {
		lines := []string{}
		for _, d := range store.Devices(p) {
			state := "离线"
			if w.s.agent(str(d["id"])) != nil {
				state = "在线"
			}
			lines = append(lines, str(d["name"])+" · "+state)
		}
		if len(lines) == 0 {
			return "这个账号还没有电脑，请先让 PC 连接器登录。", ""
		}
		return strings.Join(lines, "\n") + "\n\n发送「会话」选择任务。", ""
	}
	if match := wxList.FindStringSubmatch(text); match != nil {
		all := []M{}
		for _, d := range store.Devices(p) {
			c := store.Catalog(str(d["id"]))
			for _, v := range list(c["threads"]) {
				t := obj(v)
				if boolean(t["archived"]) {
					continue
				}
				project := str(t["cwd"])
				if project == "" {
					project = "未分组项目"
				}
				for _, p := range list(c["projects"]) {
					if obj(p)["id"] == t["projectId"] {
						project = str(obj(p)["name"])
					}
				}
				all = append(all, M{"device": d, "thread": t, "project": project})
			}
		}
		sort.SliceStable(all, func(i, j int) bool {
			return num(obj(all[i]["thread"])["updatedAt"]) > num(obj(all[j]["thread"])["updatedAt"])
		})
		page := max(int64(1), num(match[1]))
		start := min(len(all), int((page-1)*10))
		end := min(len(all), int(page*10))
		if start == end {
			if len(all) > 0 {
				return "这一页没有会话。发送「会话」查看第一页。", ""
			}
			return "还没有同步会话，请让 PC 连接器在线并打开项目。", ""
		}
		lines := []string{}
		for _, v := range all[start:end] {
			d, t := obj(v["device"]), obj(v["thread"])
			code := store.Target(user, str(d["id"]), str(t["id"]))
			state := ""
			if w.s.agent(str(d["id"])) == nil {
				state = "（离线）"
			}
			lines = append(lines, code+" · "+truncate(str(d["name"]), 80)+state+"\n"+truncate(str(v["project"]), 100)+" / "+truncate(str(t["title"]), 150))
		}
		return fmt.Sprintf("会话 %d/%d\n\n%s\n\n发送「继续 编号 下一步要求」切换会话；直接回复要求继续最近的会话。发送「会话 页码」翻页。", page, (len(all)+9)/10, strings.Join(lines, "\n\n")), ""
	}
	match := wxContinue.FindStringSubmatch(text)
	if match == nil && wxMalformed.MatchString(text) {
		return wxHelp, ""
	}
	current := w.current(b, ctx)
	if current == nil {
		fail(409, "weixin-account-inactive")
	}
	if !boolean(current["replies"]) {
		fail(409, "weixin-replies-disabled")
	}
	if timestamp == 0 || now()-timestamp > 300000 || timestamp > now()+60000 {
		return "这条指令已过期，未执行。请重新发送你的下一步要求。", ""
	}
	code := str(current["reply_target_code"])
	if match != nil {
		code = strings.ToUpper(match[1])
		text = strings.TrimSpace(match[2])
	}
	target := store.ResolveTarget(user, code)
	if target == nil {
		if match != nil {
			fail(404, "weixin-target-not-found")
		}
		return "还没有可直接回复的会话。收到任务完成通知后可直接回复，或发送「会话」查看编号，再用「继续 编号 下一步要求」指定会话。", ""
	}
	device, threadID := str(target["device_id"]), str(target["thread_id"])
	if w.s.agent(device) == nil {
		fail(409, "device-offline")
	}
	if !store.InCatalog(device, threadID, false) {
		fail(404, "weixin-target-not-found")
	}
	snapshot := store.Snapshot(device)
	if snapshot != nil && obj(snapshot["threads"])[threadID] == nil {
		watch := M{"commandId": uuid(), "deviceId": device, "expectedEpoch": snapshot["epoch"], "expiresAt": now() + 60000, "payload": M{"type": "thread.watch", "threadId": threadID}}
		w.dispatch(b, watch, ctx)
		deadline := now() + 15000
		for now() < deadline && ctx.Err() == nil {
			c := store.Command(device, str(watch["commandId"]))
			if c["status"] != "pending" {
				break
			}
			pause(ctx, 100*time.Millisecond)
		}
		snapshot = store.Snapshot(device)
	}
	thread, runtime := obj(obj(snapshot["threads"])[threadID]), obj(snapshot["runtime"])
	if !boolean(runtime["connected"]) || !boolean(obj(runtime["capabilities"])["startTurn"]) || !boolean(thread["ownerAvailable"]) || (thread["status"] != "idle" && thread["status"] != "active") {
		fail(409, "weixin-thread-unavailable")
	}
	kind, label := "turn.start", "已提交续做指令"
	if thread["status"] == "active" {
		kind, label = "turn.queue", "已提交排队请求"
	}
	command := M{"commandId": uuid(), "deviceId": device, "expectedEpoch": snapshot["epoch"], "expiresAt": now() + 60000, "payload": M{"type": kind, "threadId": threadID, "text": text}}
	store.Q("UPDATE weixin_inbox SET device_id=$3,command_id=$4 WHERE binding_id=$1 AND id=$2", b["id"], messageID, device, command["commandId"])
	result := w.dispatch(b, command, ctx)
	if result["type"] == "command.result" {
		return "指令的提交结果尚未确认，请打开 Codexer 查看实际状态。", ""
	}
	return label + "：" + code + " / " + truncate(str(thread["title"]), 150) + "。\n任务完成后会另行通知。", code
}
func (w *Weixin) dispatch(b, command M, ctx context.Context) M {
	var result M
	w.s.lane(str(command["deviceId"]), func() {
		if w.current(b, ctx) == nil {
			fail(409, "weixin-account-inactive")
		}
		if !w.s.Store.Owns(str(command["deviceId"]), &Principal{ID: str(b["user_id"]), Kind: "user"}) {
			fail(404, "device-not-found")
		}
		w.s.Validate("command", command)
		result = w.s.Submit(command)
	})
	return result
}
func (w *Weixin) send(b M, ctx context.Context) {
	store := w.s.Store
	item := store.One("SELECT * FROM weixin_outbox WHERE binding_id=$1 AND state='pending' AND next_attempt_at<=$2 ORDER BY created_at,id LIMIT 1", b["id"], now())
	if item == nil {
		return
	}
	id := str(item["id"])
	attempts := num(item["attempts"])
	retry := func(code string, terminal bool) {
		state := "pending"
		if terminal {
			state = "failed"
		}
		store.Q("UPDATE weixin_outbox SET attempts=$3,next_attempt_at=$4,error=$5,state=$6 WHERE binding_id=$1 AND id=$2", b["id"], id, attempts, now()+min(int64(300000), 5000*(1<<min(attempts, 6))), code, state)
		store.Q("UPDATE weixin_bindings SET send_error=$2 WHERE id=$1", b["id"], code)
	}
	if now()-num(item["created_at"]) > 86400000 {
		retry("weixin-notification-expired", true)
		return
	}
	device := str(item["device_id"])
	if device != "" && !store.Owns(device, &Principal{ID: str(b["user_id"]), Kind: "user"}) {
		retry("device-not-found", true)
		return
	}
	if str(b["context"]) == "" {
		return
	}
	if item["kind"] == "completion" && !boolean(b["notifications"]) {
		target := store.ResolveTarget(str(b["user_id"]), str(item["target_code"]))
		if target == nil || !store.ThreadNotification(str(b["user_id"]), device, str(target["thread_id"])) {
			store.Delivered(str(b["id"]), id, false)
			return
		}
	}
	defer func() {
		if e := recover(); e != nil {
			if ctx.Err() == nil {
				code := "weixin-unavailable"
				if f, ok := e.(Fault); ok {
					code = f.Code
				}
				attempts++
				retry(code, attempts >= 12)
			}
		}
	}()
	msg := M{"from_user_id": "", "to_user_id": b["peer_id"], "client_id": item["client_id"], "message_type": 2, "message_state": 2, "context_token": w.open(str(b["context"]), scope(b, "context")), "item_list": []any{M{"type": 1, "text_item": M{"text": item["text"]}}}}
	if w.current(b, ctx) == nil {
		return
	}
	w.api(ctx, str(b["base_url"]), "ilink/bot/sendmessage", M{"msg": msg}, w.open(str(b["token"]), scope(b, "token")), 15*time.Second)
	if ctx.Err() == nil {
		store.Delivered(str(b["id"]), id, true)
	}
}
func (w *Weixin) CommandResult(result M) {
	if result["status"] == "succeeded" {
		return
	}
	for _, row := range w.s.Store.Q("SELECT i.binding_id,i.id FROM weixin_inbox i JOIN weixin_bindings b ON b.id=i.binding_id JOIN users u ON u.id=b.user_id WHERE i.device_id=$1 AND i.command_id=$2 AND u.revoked_at IS NULL", result["deviceId"], result["commandId"]) {
		text := "这条指令未能执行，请确认 PC 在线且会话可操作，再打开 Codexer 查看详情。"
		if result["status"] == "unknown" {
			text = "这条指令的执行结果尚未确认，请打开 Codexer 查看实际会话，再决定是否重试。"
		}
		w.s.Store.Enqueue(str(row["binding_id"]), "result:"+str(result["deviceId"])+":"+str(result["commandId"]), "reply", text, "", "")
	}
}
