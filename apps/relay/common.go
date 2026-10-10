package relay

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type M = map[string]any
type Fault struct {
	Status int
	Code   string
}

func (e Fault) Error() string      { return e.Code }
func fail(status int, code string) { panic(Fault{status, code}) }
func now() int64                   { return time.Now().UnixMilli() }
func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
func num(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int64:
		return x
	case int:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	}
	return 0
}
func boolean(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case float64:
		return x != 0
	}
	return false
}
func obj(v any) M {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return M{}
}
func list(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	return []any{}
}
func js(v any) string {
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	if e := encoder.Encode(v); e != nil {
		panic(e)
	}
	return unescapeJSSeparators(strings.TrimSuffix(b.String(), "\n"))
}

// JSON embedded in an HTML script must still escape HTML delimiters.
func scriptJSON(v any) string {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return string(b)
}

func clone(v any) M        { var m M; _ = json.Unmarshal([]byte(js(v)), &m); return m }
func hash(v string) string { b := sha256.Sum256([]byte(v)); return hex.EncodeToString(b[:]) }
func token(n int) string {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func uuid() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func validID(v string) bool { return len(v) > 0 && jsLength(v) <= 160 }
func sanitize(v any) any {
	switch x := v.(type) {
	case string:
		return strings.ReplaceAll(x, "\x00", "�")
	case []any:
		for i, a := range x {
			x[i] = sanitize(a)
		}
	case map[string]any:
		for k, a := range x {
			nk := strings.ReplaceAll(k, "\x00", "�")
			if nk != k {
				delete(x, k)
			}
			x[nk] = sanitize(a)
		}
	}
	return v
}
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// Browser schema string limits count UTF-16 code units.
func jsLength(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}
func requestString(m M, key string) string {
	v, ok := m[key].(string)
	if !ok {
		fail(400, "invalid-request")
	}
	return v
}
