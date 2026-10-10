package relay

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"golang.org/x/crypto/scrypt"
	"strings"
)

type Principal struct {
	ID      string
	Kind    string
	Hash    string
	Expires int64
	Device  string
}

var passwordSlots = make(chan struct{}, 2)

func passwordKey(password, salt string) []byte {
	passwordSlots <- struct{}{}
	defer func() { <-passwordSlots }()
	b, e := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 64)
	if e != nil {
		panic(e)
	}
	return b
}
func HashPassword(password string) string {
	if n := jsLength(password); n < 12 || n > 128 {
		fail(400, "password-must-be-12-to-128-characters")
	}
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	salt := hex.EncodeToString(b)
	return "scrypt:" + salt + ":" + hex.EncodeToString(passwordKey(password, salt))
}
func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, ":")
	valid := len(parts) == 3 && parts[0] == "scrypt" && len(parts[1]) == 32 && len(parts[2]) == 128
	if !valid {
		parts = []string{"scrypt", strings.Repeat("0", 32), strings.Repeat("0", 128)}
	}
	expected, _ := hex.DecodeString(parts[2])
	actual := passwordKey(password, parts[1])
	return subtle.ConstantTimeCompare(actual, expected) == 1 && valid
}
func (s *Store) CreateUser(name, password, role string) M {
	name = strings.TrimSpace(name)
	if !validID(name) || jsLength(name) > 100 {
		fail(400, "invalid-account-name")
	}
	if role != "admin" {
		role = "user"
	}
	encoded := HashPassword(password)
	id := uuid()
	if s.One("SELECT id FROM users WHERE role=$1 AND lower(name)=lower($2) AND password_hash IS NOT NULL", role, name) != nil {
		fail(409, "account-name-taken")
	}
	if s.One("INSERT INTO users(id,name,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id", id, name, encoded, role, now()) == nil {
		fail(409, "account-name-taken")
	}
	return M{"id": id, "name": name, "role": role}
}
func (s *Store) Users(role string) []M {
	rows := s.Q("SELECT id,name,role,created_at,revoked_at,(password_hash IS NOT NULL) AS login_enabled FROM users WHERE ($1='' OR role=$1) ORDER BY created_at", role)
	for _, r := range rows {
		r["login_enabled"] = boolean(r["login_enabled"])
	}
	return rows
}
func (s *Store) CheckPassword(name, password, role string) *Principal {
	r := s.One("SELECT id,password_hash FROM users WHERE lower(name)=lower($1) AND role=$2 AND password_hash IS NOT NULL AND revoked_at IS NULL", strings.TrimSpace(name), role)
	encoded := ""
	if r != nil {
		encoded = str(r["password_hash"])
	}
	if !VerifyPassword(password, encoded) {
		return nil
	}
	return &Principal{ID: str(r["id"]), Kind: role}
}
func (s *Store) ResetUser(id, password, role string) bool {
	encoded := HashPassword(password)
	ok := false
	s.Tx(func(t *Store) {
		ok = t.One("UPDATE users SET password_hash=$2,token_hash=NULL WHERE id=$1 AND role=$3 AND revoked_at IS NULL RETURNING id", id, encoded, role) != nil
		if ok {
			t.RevokeSessions(id)
		}
	})
	return ok
}
func (s *Store) DisableUser(id, role, actor string) bool {
	ok := false
	s.Tx(func(t *Store) {
		if role == "admin" {
			admins := t.Q("SELECT id FROM users WHERE role='admin' AND revoked_at IS NULL AND password_hash IS NOT NULL FOR UPDATE")
			if id == actor || len(admins) <= 1 {
				fail(409, "admin-disable-protected")
			}
		}
		ok = t.One("UPDATE users SET revoked_at=$2 WHERE id=$1 AND role=$3 AND revoked_at IS NULL RETURNING id", id, now(), role) != nil
		if ok {
			t.RevokeSessions(id)
		}
	})
	return ok
}
func (s *Store) RevokeSessions(id string) {
	s.Q("DELETE FROM sessions WHERE user_id=$1", id)
	s.Q("DELETE FROM tickets WHERE owner_user_id=$1", id)
	s.Q("DELETE FROM weixin_bindings WHERE user_id=$1", id)
}
func (s *Store) IdleTimeout() int64 {
	return num(s.One("SELECT idle_timeout_minutes FROM auth_settings WHERE id=1")["idle_timeout_minutes"])
}
func (s *Store) Settings(minutes int64) M {
	if minutes < 1 || minutes > 43200 {
		fail(400, "invalid-request")
	}
	s.Tx(func(t *Store) {
		t.Q("DELETE FROM sessions WHERE device_id IS NULL AND expires_at<=$1", now())
		t.Q("UPDATE auth_settings SET idle_timeout_minutes=$1 WHERE id=1", minutes)
		t.Q("UPDATE sessions SET expires_at=last_active_at+$1 WHERE device_id IS NULL", minutes*60000)
		t.Q("DELETE FROM tickets WHERE session_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions WHERE hash=tickets.session_hash)")
	})
	return M{"idleTimeoutMinutes": minutes}
}
func (s *Store) CreateSession(id, device string) M {
	timeout := s.IdleTimeout() * 60000
	if device != "" {
		timeout = 604800000
	}
	session := token(32)
	expires := now() + timeout
	if s.One("INSERT INTO sessions(hash,user_id,device_id,expires_at,last_active_at) SELECT $1,id,$3,$4,$5 FROM users WHERE id=$2 AND revoked_at IS NULL AND password_hash IS NOT NULL RETURNING hash", hash(session), id, nullable(device), expires, now()) == nil {
		fail(401, "unauthorized")
	}
	return M{"session": session, "expiresAt": expires}
}
func (s *Store) Session(session, device string) *Principal {
	return s.SessionHash(hash(session), device)
}
func (s *Store) SessionHash(h, device string) *Principal {
	q := "SELECT u.id,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>$2 AND u.revoked_at IS NULL AND u.password_hash IS NOT NULL"
	args := []any{h, now()}
	if device == "" {
		q += " AND s.device_id IS NULL"
	} else {
		q += " AND u.role='user' AND s.device_id=$3 AND EXISTS(SELECT 1 FROM devices d WHERE d.id=$3 AND d.owner_user_id=u.id AND d.revoked_at IS NULL)"
		args = append(args, device)
	}
	r := s.One(q, args...)
	if r == nil {
		return nil
	}
	return &Principal{ID: str(r["id"]), Kind: str(r["role"]), Hash: h, Expires: num(r["expires_at"]), Device: device}
}
func (s *Store) TouchSession(h string) M {
	minutes := s.IdleTimeout()
	r := s.One("UPDATE sessions SET last_active_at=$2,expires_at=$3 WHERE hash=$1 AND device_id IS NULL AND expires_at>$2 AND EXISTS(SELECT 1 FROM users WHERE id=sessions.user_id AND revoked_at IS NULL AND password_hash IS NOT NULL) RETURNING expires_at", h, now(), now()+minutes*60000)
	if r == nil {
		return nil
	}
	return M{"expiresAt": r["expires_at"], "idleTimeoutMinutes": minutes}
}
func (s *Store) Logout(h string) {
	s.Q("DELETE FROM sessions WHERE hash=$1", h)
	s.Q("DELETE FROM tickets WHERE session_hash=$1", h)
}
func (s *Store) Ticket(p *Principal) M {
	if p == nil || p.Kind != "user" {
		fail(403, "control-account-required")
	}
	ticket := token(32)
	expires := now() + 60000
	s.Q("INSERT INTO tickets(hash,expires_at,owner_user_id,session_hash) VALUES($1,$2,$3,$4)", hash(ticket), expires, p.ID, p.Hash)
	return M{"ticket": ticket, "expiresAt": expires}
}
func (s *Store) ConsumeTicket(ticket string) *Principal {
	r := s.One("DELETE FROM tickets WHERE hash=$1 AND expires_at>$2 RETURNING session_hash", hash(ticket), now())
	if r == nil {
		return nil
	}
	p := s.SessionHash(str(r["session_hash"]), "")
	if p != nil && p.Kind == "user" {
		return p
	}
	return nil
}
func (s *Store) Register(owner, installation, name, platform string) string {
	id := ""
	s.Tx(func(t *Store) {
		r := t.One("INSERT INTO devices(id,name,platform,created_at,owner_user_id,installation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_user_id,installation_id) WHERE installation_id IS NOT NULL DO UPDATE SET name=EXCLUDED.name,platform=EXCLUDED.platform,revoked_at=NULL RETURNING id", uuid(), name, platform, now(), owner, installation)
		id = str(r["id"])
		t.Q("DELETE FROM sessions WHERE device_id=$1", id)
	})
	return id
}
func (s *Store) Owns(id string, p *Principal) bool {
	if p == nil || p.Kind != "user" {
		return false
	}
	if p.Hash != "" && s.SessionHash(p.Hash, "") == nil {
		return false
	}
	return s.One("SELECT d.id FROM devices d JOIN users u ON u.id=d.owner_user_id WHERE d.id=$1 AND d.owner_user_id=$2 AND d.revoked_at IS NULL AND u.revoked_at IS NULL", id, p.ID) != nil
}
func (s *Store) Devices(p *Principal) []M {
	return s.Q("SELECT id,name,platform,created_at,last_seen_at FROM devices WHERE revoked_at IS NULL AND owner_user_id=$1 ORDER BY created_at", p.ID)
}
func (s *Store) Catalog(id string) M {
	r := s.One("SELECT payload FROM catalogs WHERE device_id=$1 AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)", id)
	if r == nil {
		return nil
	}
	return obj(r["payload"])
}
func (s *Store) SaveCatalog(c M) {
	sanitize(c)
	s.Q("INSERT INTO catalogs(device_id,payload) VALUES($1,$2::jsonb) ON CONFLICT(device_id) DO UPDATE SET payload=EXCLUDED.payload", c["deviceId"], js(c))
}
func (s *Store) InCatalog(device, thread string, archived bool) bool {
	for _, v := range list(s.Catalog(device)["threads"]) {
		t := obj(v)
		if str(t["id"]) == thread && (archived || !boolean(t["archived"])) {
			return true
		}
	}
	return false
}
