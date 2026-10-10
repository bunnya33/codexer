package relay

import (
	"bytes"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// JSON schema covers structure; these checks preserve the original protocol's
// cross-field and encoded-size constraints, which JSON schema cannot express.
func validateRefinements(v any) {
	switch x := v.(type) {
	case []any:
		for _, v := range x {
			validateRefinements(v)
		}
	case map[string]any:
		for k, v := range x {
			if (k == "details" || k == "result") && v != nil && len(js(v)) > 16384 {
				fail(400, "invalid-message")
			}
			if k == "tokenUsage" && x["turns"] != nil && v != nil && len(js(v)) > 4096 {
				fail(400, "invalid-message")
			}
			if k == "subAgents" {
				ids := map[string]bool{}
				for _, a := range list(v) {
					id := str(obj(a)["threadId"])
					if ids[id] {
						fail(400, "invalid-message")
					}
					ids[id] = true
				}
			}
			validateRefinements(v)
		}
		if x["cachedInputTokens"] != nil && (num(x["cachedInputTokens"]) > num(x["inputTokens"]) || num(x["reasoningOutputTokens"]) > num(x["outputTokens"])) {
			fail(400, "invalid-message")
		}
	}
}
func (s *Server) refine(name string, m M) {
	if name == "client" && m["type"] == "client.command" {
		s.refine("command", obj(m["command"]))
	}
	validateRefinements(m)
	if name == "command" {
		p := obj(m["payload"])
		if p["type"] == "thread.model.update" {
			model := strings.TrimSpace(str(p["model"]))
			if regexp.MustCompile(`[\s\x00-\x1f]`).MatchString(model) || model == "" {
				fail(400, "invalid-request")
			}
			p["model"] = model
		}
		if p["type"] == "thread.rename" {
			p["name"] = strings.TrimSpace(str(p["name"]))
			if p["name"] == "" {
				fail(400, "invalid-request")
			}
		}
		if p["type"] == "input.respond" && len(obj(p["answers"])) > 20 {
			fail(400, "invalid-request")
		}
	}
	if name == "device" {
		switch m["type"] {
		case "device.history":
			if m["page"] != nil && len(js(m["page"])) > 6*1024*1024 {
				fail(400, "invalid-message")
			}
		case "device.event":
			change := obj(obj(m["event"])["change"])
			if change["type"] == "thread.updated" && len(js(change["thread"])) > 256*1024 {
				fail(400, "invalid-message")
			}
		}
	}
}
func commandHash(m M, raw ...[]byte) string {
	encode := func(v any) string {
		var b bytes.Buffer
		e := json.NewEncoder(&b)
		e.SetEscapeHTML(false)
		e.Encode(v)
		return unescapeJSSeparators(strings.TrimSuffix(b.String(), "\n"))
	}
	fields := func(m M, names []string) string {
		parts := []string{}
		for _, k := range names {
			if v, ok := m[k]; ok {
				value := encode(v)
				if k == "answers" {
					value = orderedAnswers(obj(v), raw, encode)
				}
				parts = append(parts, encode(k)+":"+value)
			}
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	p := obj(m["payload"])
	keys := map[string][]string{
		"thread.create": {"type", "projectId"}, "thread.rename": {"type", "threadId", "name"}, "thread.archive": {"type", "threadId"}, "thread.delete": {"type", "threadId"}, "thread.watch": {"type", "threadId"}, "turn.start": {"type", "threadId", "text", "images"}, "turn.queue": {"type", "threadId", "text", "images"}, "turn.queue.steer": {"type", "threadId", "turnId", "queueId"}, "turn.queue.remove": {"type", "threadId", "queueId"}, "turn.steer": {"type", "threadId", "turnId", "text", "images"}, "thread.model.update": {"type", "threadId", "model", "expectedModel"}, "thread.effort.update": {"type", "threadId", "effort", "expectedModel", "expectedEffort"}, "thread.mode.update": {"type", "threadId", "mode", "expectedMode", "expectedModel", "expectedEffort"}, "turn.interrupt": {"type", "threadId", "turnId"}, "approval.respond": {"type", "threadId", "turnId", "requestId", "decision"}, "input.respond": {"type", "threadId", "turnId", "requestId", "answers"}}
	prefix := fields(m, []string{"commandId", "deviceId", "expectedEpoch", "expiresAt"})
	return hash(strings.TrimSuffix(prefix, "}") + ",\"payload\":" + fields(p, keys[str(p["type"])]) + "}")
}

// JSON.stringify leaves these two Unicode separators literal. Preserve literal
// backslash sequences while matching hashes written by the old server.
func unescapeJSSeparators(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			if strings.HasPrefix(s[i:], `\u2028`) {
				out.WriteRune('\u2028')
				i += 5
				continue
			}
			if strings.HasPrefix(s[i:], `\u2029`) {
				out.WriteRune('\u2029')
				i += 5
				continue
			}
			out.WriteByte(s[i])
			i++
			out.WriteByte(s[i])
			continue
		}
		out.WriteByte(s[i])
	}
	return out.String()
}
func orderedAnswers(answers M, raw [][]byte, encode func(any) string) string {
	keys := []string{}
	if len(raw) > 0 {
		var root map[string]json.RawMessage
		json.Unmarshal(raw[0], &root)
		if root["command"] != nil {
			json.Unmarshal(root["command"], &root)
		}
		var payload map[string]json.RawMessage
		json.Unmarshal(root["payload"], &payload)
		d := json.NewDecoder(bytes.NewReader(payload["answers"]))
		token, e := d.Token()
		if e == nil && token == json.Delim('{') {
			seen := map[string]bool{}
			for d.More() {
				key, e := d.Token()
				if e != nil {
					break
				}
				var value json.RawMessage
				if d.Decode(&value) != nil {
					break
				}
				k, ok := key.(string)
				if ok && !seen[k] {
					seen[k] = true
					keys = append(keys, k)
				}
			}
		}
	}
	if len(keys) != len(answers) {
		keys = keys[:0]
		for k := range answers {
			keys = append(keys, k)
		}
		sort.Strings(keys)
	}
	// JavaScript enumerates integer index keys first, in numeric order.
	index := func(k string) (uint64, bool) {
		n, e := strconv.ParseUint(k, 10, 32)
		return n, e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == k
	}
	sort.SliceStable(keys, func(i, j int) bool {
		a, ai := index(keys[i])
		b, bi := index(keys[j])
		if ai && bi {
			return a < b
		}
		return ai && !bi
	})
	parts := []string{}
	for _, k := range keys {
		parts = append(parts, encode(k)+":"+`{"answers":`+encode(obj(answers[k])["answers"])+"}")
	}
	return "{" + strings.Join(parts, ",") + "}"
}
