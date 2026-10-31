package relay

import (
	"bufio"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

const serverLogCapacity = 2000
const serverLogFileBytes = 2 * 1024 * 1024

type logIssue struct {
	Path string `json:"path"`
	Rule string `json:"rule"`
}
type logContext struct {
	ConnectionID string `json:"connectionId,omitempty"`
	DeviceID     string `json:"deviceId,omitempty"`
	ThreadID     string `json:"threadId,omitempty"`
	MessageType  string `json:"messageType,omitempty"`
	AgentVersion string `json:"agentVersion,omitempty"`
	Seq          int64  `json:"seq,omitempty"`
	MessageBytes int64  `json:"messageBytes,omitempty"`
	ThreadBytes  int64  `json:"threadBytes,omitempty"`
	ThreadCount  int    `json:"threadCount,omitempty"`
}
type serverLogEntry struct {
	ID         int64      `json:"id"`
	At         int64      `json:"at"`
	Level      string     `json:"level"`
	Category   string     `json:"category"`
	Code       string     `json:"code"`
	Source     string     `json:"source,omitempty"`
	Initiator  string     `json:"initiator,omitempty"`
	DurationMS int64      `json:"durationMs,omitempty"`
	CloseCode  int        `json:"closeCode,omitempty"`
	HTTPStatus int        `json:"httpStatus,omitempty"`
	Route      string     `json:"route,omitempty"`
	SQLState   string     `json:"sqlState,omitempty"`
	Issues     []logIssue `json:"issues,omitempty"`
	logContext
}
type serverLogs struct {
	mu         sync.Mutex
	entries    []serverLogEntry
	serial     int64
	path       string
	fileBytes  int64
	persistent bool
	maxBytes   int64
}

// Only structured metadata enters this log. Payloads, exception strings, URLs,
// query strings, tokens and user text are deliberately absent from the type.
func newServerLogs(directory string) *serverLogs {
	l := &serverLogs{entries: []serverLogEntry{}, maxBytes: serverLogFileBytes}
	if directory == "" {
		return l
	}
	l.path = filepath.Join(directory, "server-logs.jsonl")
	if os.MkdirAll(directory, 0700) != nil {
		return l
	}
	for _, path := range []string{l.path + ".1", l.path} {
		f, e := os.Open(path)
		if e != nil {
			continue
		}
		info, e := f.Stat()
		if e == nil && path == l.path {
			l.fileBytes = info.Size()
		}
		if e != nil || info.Size() > l.maxBytes {
			f.Close()
			continue
		}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 4096), 8192)
		for scanner.Scan() {
			var entry serverLogEntry
			if json.Unmarshal(scanner.Bytes(), &entry) == nil && entry.ID > l.serial {
				l.serial = entry.ID
				l.entries = append(l.entries, entry)
				if len(l.entries) > serverLogCapacity {
					l.entries = l.entries[1:]
				}
			}
		}
		if path == l.path {
			l.fileBytes = info.Size()
		}
		f.Close()
	}
	f, e := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e == nil {
		l.persistent = f.Chmod(0600) == nil
		f.Close()
	}
	return l
}
func (l *serverLogs) add(entry serverLogEntry) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.serial++
	entry.ID, entry.At = l.serial, now()
	l.entries = append(l.entries, entry)
	if len(l.entries) > serverLogCapacity {
		copy(l.entries, l.entries[1:])
		l.entries = l.entries[:serverLogCapacity]
	}
	if l.path == "" {
		return
	}
	b, e := json.Marshal(entry)
	if e != nil {
		return
	}
	b = append(b, '\n')
	if l.fileBytes+int64(len(b)) > l.maxBytes {
		if e = os.Remove(l.path + ".1"); e != nil && !os.IsNotExist(e) {
			l.writeFailed()
			return
		}
		if e = os.Rename(l.path, l.path+".1"); e != nil && !os.IsNotExist(e) {
			l.writeFailed()
			return
		}
		l.fileBytes = 0
	}
	f, e := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		l.writeFailed()
		return
	}
	n, e := f.Write(b)
	closeError := f.Close()
	l.fileBytes += int64(n)
	if e != nil || closeError != nil {
		l.writeFailed()
		return
	}
	l.persistent = true
}
func (l *serverLogs) writeFailed() {
	if l.persistent {
		log.Print(`{"type":"relay.diagnostic","code":"server-log-write-failed"}`)
	}
	l.persistent = false
}
func (s *Server) logRoutes() {
	s.route("GET /v1/admin/system/logs", "admin", func(w http.ResponseWriter, r *http.Request, _ *Principal) any {
		w.Header().Set("Cache-Control", "no-store")
		q := r.URL.Query()
		limit := 100
		if raw := q.Get("limit"); raw != "" {
			v, e := strconv.Atoi(raw)
			if e != nil || v < 1 || v > 200 {
				fail(400, "invalid-log-filter")
			}
			limit = v
		}
		before := int64(0)
		if raw := q.Get("before"); raw != "" {
			v, e := strconv.ParseInt(raw, 10, 64)
			if e != nil || v < 1 {
				fail(400, "invalid-log-filter")
			}
			before = v
		}
		level, category, device, code := q.Get("level"), q.Get("category"), q.Get("deviceId"), q.Get("code")
		if level != "" && level != "info" && level != "warn" && level != "error" || category != "" && category != "connection" && category != "protocol" && category != "storage" && category != "http" && category != "background" || len(device) > 160 || len(code) > 100 {
			fail(400, "invalid-log-filter")
		}
		l := s.logs
		l.mu.Lock()
		defer l.mu.Unlock()
		entries := []serverLogEntry{}
		var next any
		for i := len(l.entries) - 1; i >= 0; i-- {
			entry := l.entries[i]
			if before > 0 && entry.ID >= before || level != "" && entry.Level != level || category != "" && entry.Category != category || device != "" && entry.DeviceID != device || code != "" && !strings.Contains(entry.Code, code) {
				continue
			}
			if len(entries) == limit {
				next = entries[len(entries)-1].ID
				break
			}
			entries = append(entries, entry)
		}
		return M{"entries": entries, "nextCursor": next, "retained": len(l.entries), "capacity": serverLogCapacity, "persistent": l.persistent, "file": "server-logs.jsonl", "maxFileBytes": l.maxBytes, "fileCount": 2, "capturedAt": now()}
	})
}

var loggedVersion = regexp.MustCompile(`^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,30})?$`)

// Some HTTP faults carry a code supplied by a preview peer. Keep only known
// diagnostic codes; a syntactically plausible token is still private data.
func httpLogCode(code string) string {
	for _, known := range strings.Fields("server-error relay-closing rate-limited unauthorized origin-denied client-release-storage-error client-release-delete-error agent-release-storage-error audio-busy preview-shares-busy previews-busy historys-busy images-busy files-busy history-timeout image-timeout file-timeout preview-timeout invalid-preview-response invalid-file-response invalid-image-response invalid-history-response preview-external-redirect invalid-release release-assets-missing invalid-release-url release-check-failed github-rate-limited release-response-too-large updates-unavailable invalid-tags weixin-invalid-host weixin-invalid-secret weixin-network-error weixin-http-error weixin-response-too-large weixin-invalid-response preview-unavailable preview-fetch-failed preview-network-error preview-not-found device-offline") {
		if code == known {
			return code
		}
	}
	return "server-error"
}

func deviceLogContext(connection, device string, m M, bytes int) logContext {
	c := logContext{ConnectionID: connection, DeviceID: device, MessageBytes: int64(bytes)}
	typeName := str(m["type"])
	for _, known := range []string{"device.snapshot", "device.event", "device.catalog", "device.capabilities", "device.history", "device.image", "device.file", "device.preview", "command.result"} {
		if typeName == known {
			c.MessageType = known
			break
		}
	}
	var thread M
	if typeName == "device.event" {
		event := obj(m["event"])
		c.Seq = num(event["seq"])
		change := obj(event["change"])
		thread = obj(change["thread"])
		c.ThreadID = str(thread["id"])
		if c.ThreadID == "" {
			c.ThreadID = str(change["threadId"])
		}
	}
	if typeName == "device.snapshot" {
		v := obj(m["snapshot"])
		c.Seq = num(v["lastSeq"])
		c.ThreadCount = len(obj(v["threads"]))
		version := str(v["agentVersion"])
		if loggedVersion.MatchString(version) {
			c.AgentVersion = version
		}
	}
	if typeName == "device.history" || typeName == "device.image" || typeName == "device.file" {
		c.ThreadID = str(m["threadId"])
	}
	if !uuidPattern.MatchString(c.ThreadID) {
		c.ThreadID = ""
	}
	if thread != nil {
		c.ThreadBytes = int64(len(js(thread)))
	}
	return c
}
func (s *Server) protocolIssues(m M) []logIssue {
	// Never use ValidationError.Error(): it embeds rejected values.
	schema := s.schemas["device"]
	for _, branch := range append(append([]*jsonschema.Schema{}, schema.AnyOf...), schema.OneOf...) {
		kind, _ := m["type"].(string)
		if discriminator := branch.Properties["type"]; discriminator != nil && discriminator.Const != nil && kind != "" && *discriminator.Const == kind {
			schema = branch
			break
		}
	}
	err := schema.Validate(m)
	var validation *jsonschema.ValidationError
	issues := []logIssue{}
	if issue := refinementIssue(m, ""); issue != nil {
		return []logIssue{*issue}
	}
	if issue := deviceConstraintIssue(m); issue != nil {
		return []logIssue{*issue}
	}
	if issue := deviceTransferIssue(m); issue != nil {
		return []logIssue{*issue}
	}
	if issue := projectProtocolAt(obj(s.schemaValues["device"]), m, ""); issue != nil {
		return []logIssue{*issue}
	}
	if errors.As(err, &validation) {
		var visit func(*jsonschema.ValidationError)
		visit = func(v *jsonschema.ValidationError) {
			if len(issues) >= 8 {
				return
			}
			if len(v.Causes) > 0 {
				for _, child := range v.Causes {
					visit(child)
				}
				return
			}
			rule := "schema"
			if keywords := v.ErrorKind.KeywordPath(); len(keywords) > 0 {
				rule = keywords[0]
			}
			issues = append(issues, logIssue{Path: safeLogPath(v.InstanceLocation), Rule: rule})
		}
		visit(validation)
	}
	if len(issues) == 0 {
		issues = append(issues, logIssue{Path: "/", Rule: "protocol-constraint"})
	}
	return issues
}

func safeLogPath(parts []string) string {
	clean := []string{}
	for _, part := range parts {
		if _, e := strconv.ParseUint(part, 10, 32); e == nil || protocolLogFields[part] {
			clean = append(clean, part)
		} else {
			clean = append(clean, "*")
		}
		if len(clean) >= 24 {
			break
		}
	}
	return "/" + strings.Join(clean, "/")
}

var protocolLogFields = func() map[string]bool {
	fields := map[string]bool{}
	var value any
	json.Unmarshal(schemaFile, &value)
	var visit func(any)
	visit = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for key, item := range x {
				if key == "properties" {
					for name := range obj(item) {
						fields[name] = true
					}
				}
				visit(item)
			}
		case []any:
			for _, item := range x {
				visit(item)
			}
		}
	}
	visit(value)
	return fields
}()

func (s *Server) deviceFailure(p *Peer, m M, bytes int, e any) {
	entry := serverLogEntry{Level: "error", Category: "storage", Code: "relay-storage-error", Source: "device", logContext: deviceLogContext(p.connectionID, p.Principal().Device, m, bytes)}
	if f, ok := e.(Fault); ok {
		entry.Level, entry.Category, entry.Code = "warn", "protocol", f.Code
		if f.Code == "invalid-message" {
			entry.Issues = s.protocolIssues(m)
		}
	} else {
		entry.SQLState = str(storageFailureEvent(e)["sqlState"])
	}
	s.logs.add(entry)
}

func closeReason(reason string) string {
	for _, code := range []string{"invalid-message", "invalid-device-state", "device-mismatch", "stale-snapshot", "thread-limit", "sequence-gap", "invalid-command", "invalid-history-request", "invalid-image-request", "invalid-file-request", "payload-too-large", "text-required", "backpressure", "storage-error", "session-expired", "revoked", "connection-replaced", "user-disconnected", "relay-closing", "connection-closed", "client-closed", "transport-error", "heartbeat-timeout", "write-error", "authentication-required", "invalid-ticket", "rate-limited", "origin-denied"} {
		if reason == code {
			return reason
		}
	}
	return "peer-closed"
}
