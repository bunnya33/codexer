package relay

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (s *Store) Bootstrap(path, username, password string) error {
	if s.One("SELECT id FROM users WHERE role='admin' AND revoked_at IS NULL AND password_hash IS NOT NULL LIMIT 1") != nil {
		return nil
	}
	if username == "" || password == "" {
		data, e := os.ReadFile(path)
		if os.IsNotExist(e) {
			username, password = "admin", token(18)
			if e = AtomicJSON(path, M{"username": username, "password": password}, 0600); e != nil {
				return e
			}
		} else if e != nil {
			return e
		} else {
			var account M
			if json.Unmarshal(data, &account) != nil {
				return fmt.Errorf("invalid-admin-account-file")
			}
			username, password = str(account["username"]), str(account["password"])
		}
	}
	s.CreateUser(username, password, "admin")
	return nil
}
func AdminEnvPassword() string {
	if value := os.Getenv("RELAY_ADMIN_PASSWORD_B64"); value != "" {
		b, e := base64.StdEncoding.DecodeString(value)
		if e == nil {
			return string(b)
		}
		return ""
	}
	return os.Getenv("RELAY_ADMIN_PASSWORD")
}
func LegacyData(dir string) bool {
	for _, name := range []string{"PG_VERSION", "base", "global"} {
		if _, e := os.Stat(filepath.Join(dir, name)); e == nil {
			return true
		}
	}
	return false
}
func EnvDefault(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}
func SplitOrigins(value string) []string {
	out := []string{}
	for _, v := range strings.Split(value, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}
