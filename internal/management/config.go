package management

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	relay "github.com/bunnya33/codexer/apps/relay"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

func DecodeKey(v string) ([]byte, error) {
	key, e := hex.DecodeString(v)
	if e != nil || len(key) != 32 {
		return nil, errors.New("invalid-weixin-key")
	}
	return key, nil
}
func ParseEnv(source string) map[string]string {
	values := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(source))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key, value := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		if strings.HasPrefix(value, "\"") {
			var decoded string
			if json.Unmarshal([]byte(value), &decoded) == nil {
				value = decoded
			} else if len(value) >= 2 {
				value = strings.Trim(value, "\"")
			}
		} else if strings.HasPrefix(value, "'") {
			value = strings.Trim(value, "'")
		} else if i := strings.Index(value, " #"); i >= 0 {
			value = strings.TrimSpace(value[:i])
		}
		values[key] = value
	}
	return values
}
func LoadEnv(path string, override bool) error {
	source, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	for k, v := range ParseEnv(string(source)) {
		if _, ok := os.LookupEnv(k); !ok || override {
			os.Setenv(k, v)
		}
	}
	return nil
}
func Origin(raw string, public bool) (string, int, error) {
	u, e := url.Parse(strings.TrimSpace(raw))
	if e != nil {
		return "", 0, e
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && (!public && u.Scheme != "https" || public) || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || public && (u.Hostname() == "0.0.0.0" || u.Hostname() == "192.0.2.10") {
		return "", 0, errors.New("invalid-browser-origin")
	}
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if u.Port() != "" {
		port, e = strconv.Atoi(u.Port())
		if e != nil || port < 1 || port > 65535 {
			return "", 0, errors.New("invalid-port")
		}
	}
	hostname := strings.ToLower(u.Hostname())
	host := hostname
	if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	if u.Scheme == "http" && port != 80 || u.Scheme == "https" && port != 443 {
		host = net.JoinHostPort(hostname, strconv.Itoa(port))
	}
	return u.Scheme + "://" + host, port, nil
}
func Configure(source, address, username, password, origins string) (string, error) {
	origin, port, e := Origin(address, true)
	if e != nil {
		return "", e
	}
	if username == "" || len(username) > 100 || len(password) < 12 || len(password) > 128 {
		return "", errors.New("invalid-admin-account")
	}
	values := ParseEnv(source)
	allowed := []string{origin}
	seen := map[string]bool{origin: true}
	for _, raw := range strings.Split(origins, ",") {
		if raw = strings.TrimSpace(raw); raw != "" {
			o, _, e := Origin(raw, false)
			if e != nil {
				return "", e
			}
			if !seen[o] {
				seen[o] = true
				allowed = append(allowed, o)
			}
		}
	}
	values["RELAY_HOST"] = "0.0.0.0"
	values["RELAY_PORT"] = fmt.Sprint(port)
	values["RELAY_ALLOWED_ORIGINS"] = strings.Join(allowed, ",")
	values["RELAY_ADMIN_USERNAME"] = strings.TrimSpace(username)
	values["RELAY_ADMIN_PASSWORD_B64"] = base64.StdEncoding.EncodeToString([]byte(password))
	values["RELAY_DATA_DIR"] = "/var/lib/codexer/relay"
	values["RELAY_ADMIN_FILE"] = "/var/lib/codexer/admin-account.secret"
	delete(values, "RELAY_ADMIN_TOKEN")
	delete(values, "RELAY_ADMIN_PASSWORD")
	delete(values, "RELAY_WEB_DIR")
	delete(values, "RELAY_ADMIN_DIR")
	out := ""
	for _, key := range sortedKeys(values) {
		b, _ := json.Marshal(values[key])
		out += key + "=" + string(b) + "\n"
	}
	return out, nil
}
func ServiceUnit() string {
	return `# Managed by Codexer installer
[Unit]
Description=Codexer Relay, Web and Admin (Go)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5
[Service]
Type=simple
User=codexer
Group=codexer
WorkingDirectory=/opt/codexer/current
EnvironmentFile=/etc/codexer/relay.env
ExecStart=/opt/codexer/current/codexer serve
StateDirectory=codexer
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/codexer /var/lib/codexer-updater/inbox
[Install]
WantedBy=multi-user.target
`
}

var _ = relay.M{}
