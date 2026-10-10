// Test-only IPC driver. It is never included in server release artifacts.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	relay "github.com/bunnya33/codexer/apps/relay"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	var store *relay.Store
	var s *relay.Server
	var h *http.Server
	listenerURL := ""
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 16*1024*1024)
	for scanner.Scan() {
		var req struct {
			ID     int               `json:"id"`
			Method string            `json:"method"`
			Args   []json.RawMessage `json:"args"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			continue
		}
		result := relay.M{"id": req.ID}
		func() {
			defer func() {
				if e := recover(); e != nil {
					result["error"] = fmt.Sprint(e)
				}
			}()
			arg := func(i int) string {
				if i >= len(req.Args) {
					return ""
				}
				var v string
				json.Unmarshal(req.Args[i], &v)
				return v
			}
			maparg := func(i int) relay.M { var v relay.M; json.Unmarshal(req.Args[i], &v); return v }
			principal := func(i int) *relay.Principal {
				m := maparg(i)
				return &relay.Principal{ID: fmt.Sprint(m["id"]), Kind: fmt.Sprint(m["kind"]), Hash: text(m["sessionHash"])}
			}
			value := any(nil)
			switch req.Method {
			case "rewritePreviewContent":
				value = relay.RewritePreviewContent(arg(0), arg(1), arg(2), arg(3), arg(4))
			case "open":
				var e error
				store, e = relay.Open(arg(0), arg(1))
				if e != nil {
					panic(e)
				}
			case "server":
				o := maparg(0)
				heartbeat := time.Duration(number(o["heartbeatMs"])) * time.Millisecond
				cleanup := time.Duration(number(o["cleanupMs"])) * time.Millisecond
				origins := []string{}
				if raw, ok := o["allowedOrigins"].([]any); ok {
					for _, v := range raw {
						origins = append(origins, fmt.Sprint(v))
					}
				}
				var e error
				s, e = relay.New(store, relay.Options{Version: text(o["version"]), WebRoot: text(o["webRoot"]), AdminRoot: text(o["adminRoot"]), Origins: origins, HeartbeatInterval: heartbeat, CleanupInterval: cleanup})
				if e != nil {
					panic(e)
				}
				l, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", number(o["port"])))
				if e != nil {
					panic(e)
				}
				h = &http.Server{Handler: s.Handler()}
				go h.Serve(l)
				listenerURL = "http://" + l.Addr().String()
				value = listenerURL
			case "listen":
				if h != nil {
					h.Close()
				}
				var port int64
				json.Unmarshal(req.Args[0], &port)
				l, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
				if e != nil {
					panic(e)
				}
				h = &http.Server{Handler: s.Handler()}
				go h.Serve(l)
				listenerURL = "http://" + l.Addr().String()
				value = listenerURL
			case "close":
				if s != nil {
					s.Close()
					s = nil
				}
				if h != nil {
					h.Close()
					h = nil
				}
				if store != nil {
					store.Close()
					store = nil
				}
			case "createUser":
				value = store.CreateUser(arg(0), arg(1), arg(2))
			case "createSession":
				value = store.CreateSession(arg(0), arg(1))
			case "registerAgent":
				value = store.Register(arg(0), arg(1), arg(2), arg(3))
			case "sessionPrincipal":
				value = principalView(store.Session(arg(0), arg(1)))
			case "checkPassword":
				value = principalView(store.CheckPassword(arg(0), arg(1), arg(2)))
			case "authorizeDevice":
				value = store.Session(arg(1), arg(0)) != nil
			case "ticket":
				value = store.Ticket(principal(0))
			case "consumeTicket":
				value = principalView(store.ConsumeTicket(arg(0)))
			case "listUsers":
				value = store.Users(arg(0))
			case "resetPassword":
				role := arg(2)
				if role == "" {
					role = "user"
				}
				value = store.ResetUser(arg(0), arg(1), role)
			case "revokeUser":
				role := arg(1)
				if role == "" {
					role = "user"
				}
				value = store.DisableUser(arg(0), role, arg(2))
			case "ownsDevice":
				value = store.Owns(arg(0), principal(1))
			case "listDevices":
				value = store.Devices(principal(0))
			case "revoke":
				store.Q("UPDATE devices SET revoked_at=$2 WHERE id=$1", arg(0), time.Now().UnixMilli())
			case "snapshot":
				value = store.Snapshot(arg(0))
			case "snapshotMetadata":
				r := store.Snapshot(arg(0))
				delete(r, "threads")
				value = r
			case "saveSnapshot":
				m := maparg(0)
				store.SaveSnapshot(m)
			case "catalog":
				value = store.Catalog(arg(0))
			case "saveCatalog":
				store.SaveCatalog(maparg(0))
			case "saveEvent":
				store.SaveEvent(maparg(0))
			case "replay":
				var seq int64
				json.Unmarshal(req.Args[2], &seq)
				rows, ok := store.Replay(arg(0), arg(1), seq)
				if ok {
					value = rows
				}
			case "command":
				value = store.Command(arg(0), arg(1))
			case "addCommand":
				c := maparg(0)
				encoded, _ := json.Marshal(c)
				sum := sha256.Sum256(encoded)
				store.Q("INSERT INTO commands(device_id,id,payload_hash,status,expires_at,created_at) VALUES($1,$2,$3,'pending',$4,$5)", c["deviceId"], c["commandId"], hex.EncodeToString(sum[:]), int64(c["expiresAt"].(float64)), time.Now().UnixMilli())
			case "finishCommand":
				value = store.Finish(maparg(0))
			case "authSettings":
				value = relay.M{"idleTimeoutMinutes": store.IdleTimeout()}
			case "setAuthSettings":
				value = store.Settings(number(maparg(0)["idleTimeoutMinutes"]))
			case "touchSession":
				value = store.TouchSession(arg(0))
			case "query":
				var args []any
				if len(req.Args) > 1 {
					json.Unmarshal(req.Args[1], &args)
				}
				for i, v := range args {
					if x, ok := v.(float64); ok {
						args[i] = int64(x)
					}
				}
				value = relay.M{"rows": store.Q(arg(0), args...)}
			default:
				panic("unknown-test-method:" + req.Method)
			}
			result["value"] = value
		}()
		b, _ := json.Marshal(result)
		fmt.Println(string(b))
	}
	if s != nil {
		s.Close()
	}
	if h != nil {
		h.Close()
	}
	if store != nil {
		store.Close()
	}
}
func text(v any) string { s, _ := v.(string); return s }
func number(v any) int64 {
	if n, ok := v.(float64); ok {
		return int64(n)
	}
	return 0
}
func principalView(p *relay.Principal) any {
	if p == nil {
		return nil
	}
	m := relay.M{"id": p.ID, "kind": p.Kind}
	if p.Hash != "" {
		m["sessionHash"] = p.Hash
		m["expiresAt"] = p.Expires
	}
	return m
}
