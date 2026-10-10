package relay

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
)

func postgresFixture(t *testing.T) (string, *sql.DB) {
	t.Helper()
	raw := os.Getenv("CODEXER_TEST_POSTGRES_URL")
	if raw == "" {
		t.Skip("set CODEXER_TEST_POSTGRES_URL for a disposable PostgreSQL database")
	}
	admin, e := sql.Open("pgx", raw)
	if e != nil {
		t.Fatal(e)
	}
	schema := "codexer_test_" + strings.ReplaceAll(uuid(), "-", "")
	if _, e = admin.Exec("CREATE SCHEMA " + schema); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { admin.Exec("DROP SCHEMA " + schema + " CASCADE"); admin.Close() })
	u, e := url.Parse(raw)
	if e != nil {
		t.Fatal(e)
	}
	q := u.Query()
	q.Set("options", "-csearch_path="+schema)
	u.RawQuery = q.Encode()
	db, e := sql.Open("pgx", u.String())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	return u.String(), db
}
func TestPostgresAccountsSnapshotsAndCompletionRollback(t *testing.T) {
	raw, _ := postgresFixture(t)
	store, e := Open(raw, "")
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	user := store.CreateUser("Same", "test-password-12345", "user")
	store.CreateUser("Same", "test-password-12345", "admin")
	id := str(user["id"])
	device := store.Register(id, uuid(), "PC", "darwin")
	session := store.CreateSession(id, "")
	p := store.Session(str(session["session"]), "")
	ticket := store.Ticket(p)
	if store.ConsumeTicket(str(ticket["ticket"])) == nil {
		t.Fatal("ticket")
	}
	snapshot := state(t, device)
	store.SaveSnapshot(snapshot)
	event := M{"protocolVersion": 1, "deviceId": device, "epoch": snapshot["epoch"], "seq": 1, "timestamp": now(), "change": M{"type": "runtime.status", "connected": false}}
	store.SaveEvent(event)
	expectFault(t, "sequence-gap", func() { store.SaveEvent(event) })
	if num(store.Snapshot(device)["lastSeq"]) != 1 {
		t.Fatal("rollback")
	}
	store.ResetUser(id, "new-password-123456", "user")
	if store.SessionHash(p.Hash, "") != nil {
		t.Fatal("revocation")
	}
	store.Cleanup(t.Context())
}
func TestPostgresLegacySnapshotMigrationIsAtomic(t *testing.T) {
	raw, db := postgresFixture(t)
	statements := []string{
		"CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE,password_hash TEXT,role TEXT DEFAULT 'user',created_at BIGINT NOT NULL,revoked_at BIGINT)",
		"CREATE UNIQUE INDEX account_login ON users(lower(name)) WHERE password_hash IS NOT NULL",
		"CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,platform TEXT NOT NULL,token_hash TEXT UNIQUE,created_at BIGINT NOT NULL,last_seen_at BIGINT,revoked_at BIGINT)",
		"CREATE TABLE sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),device_id TEXT REFERENCES devices(id),expires_at BIGINT NOT NULL)",
		"CREATE TABLE snapshots(device_id TEXT PRIMARY KEY REFERENCES devices(id),epoch TEXT NOT NULL,seq BIGINT NOT NULL,payload JSONB NOT NULL)",
		"INSERT INTO users(id,name,password_hash,role,created_at) VALUES('admin','Same','scrypt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:ca72ab774197f76a14a92fb2184d28343f1ffdae1b5d67cff7a9a0994d3acd33313e22cf4948f165a86afeb913696aad61cb5c77081becc05264f21c52fb2419','admin',1)",
		"INSERT INTO devices(id,name,platform,created_at) VALUES('pc','PC','darwin',1)",
		fmt.Sprintf("INSERT INTO sessions VALUES('legacy','admin',NULL,%d)", now()+604800000),
		"CREATE FUNCTION fail_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$",
		"CREATE TRIGGER fail BEFORE UPDATE ON snapshots FOR EACH ROW EXECUTE FUNCTION fail_migration()",
	}
	for _, q := range statements {
		if _, e := db.Exec(q); e != nil {
			t.Fatal(e)
		}
	}
	snapshot := state(t, "pc")
	if _, e := db.Exec("INSERT INTO snapshots VALUES('pc',$1,0,$2::jsonb)", snapshot["epoch"], js(snapshot)); e != nil {
		t.Fatal(e)
	}
	if store, e := Open(raw, ""); e == nil {
		store.Close()
		t.Fatal("failed migration committed")
	}
	var count int
	db.QueryRow("SELECT COUNT(*) FROM snapshot_threads").Scan(&count)
	if count != 0 {
		t.Fatal("partial thread migration")
	}
	if _, e := db.Exec("DROP TRIGGER fail ON snapshots"); e != nil {
		t.Fatal(e)
	}
	store, e := Open(raw, "")
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	if store.CheckPassword("Same", "test-password-12345", "admin").ID != "admin" {
		t.Fatal("old scrypt")
	}
	store.CreateUser("Same", "test-password-12345", "user")
	if js(store.Snapshot("pc")) != js(snapshot) {
		t.Fatal("snapshot changed")
	}
	if store.One("SELECT last_active_at FROM sessions WHERE hash='legacy'")["last_active_at"] == nil {
		t.Fatal("activity migration")
	}
}
