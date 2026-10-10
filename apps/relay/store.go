package relay

import (
	"context"
	"database/sql"
	"database/sql/driver"
	_ "embed"
	"encoding/json"
	_ "github.com/jackc/pgx/v5/stdlib"
	"modernc.org/sqlite"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// SQLite's built-in lower only folds ASCII; account lookup must also support
// the Unicode names accepted by the existing PostgreSQL implementation.
func init() {
	sqlite.MustRegisterDeterministicScalarFunction("lower", 1, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
		if args[0] == nil {
			return nil, nil
		}
		value, ok := args[0].(string)
		if !ok {
			return args[0], nil
		}
		return strings.ToLower(value), nil
	})
}

//go:embed postgres.sql
var postgresSchema string

type querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}
type Store struct {
	DB      *sql.DB
	q       querier
	SQLite  bool
	Metrics *Metrics
}

var casts = regexp.MustCompile(`::(?:jsonb|text|bigint)`)

func Open(databaseURL, directory string) (*Store, error) {
	driver, dsn := "pgx", databaseURL
	if databaseURL == "" {
		driver = "sqlite"
		dsn = ":memory:"
		if directory != "" {
			if e := os.MkdirAll(directory, 0700); e != nil {
				return nil, e
			}
			dsn = filepath.Join(directory, "relay.sqlite")
			if LegacyData(directory) {
				if _, e := os.Stat(dsn); os.IsNotExist(e) {
					return nil, Fault{409, "legacy-migration-required"}
				}
			}
			f, e := os.OpenFile(dsn, os.O_CREATE|os.O_RDWR, 0600)
			if e != nil {
				return nil, e
			}
			f.Close()
			os.Chmod(dsn, 0600)
		}
	}
	db, e := sql.Open(driver, dsn)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	s := &Store{DB: db, q: db, SQLite: driver == "sqlite", Metrics: NewMetrics()}
	if s.SQLite {
		db.SetMaxOpenConns(1)
		for _, q := range []string{"PRAGMA foreign_keys=ON", "PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=10000", "PRAGMA cache_size=-8192"} {
			if _, e = db.Exec(q); e != nil {
				db.Close()
				return nil, e
			}
		}
	}
	schema := postgresSchema
	if s.SQLite {
		schema = sqliteSchema
	}
	for _, q := range strings.Split(schema, ";\n") {
		if strings.TrimSpace(q) == "" {
			continue
		}
		if _, e = db.Exec(q); e != nil {
			db.Close()
			return nil, e
		}
	}
	_, e = db.Exec("INSERT INTO auth_settings(id,idle_timeout_minutes) VALUES(1,10080) ON CONFLICT(id) DO NOTHING")
	if e != nil {
		db.Close()
		return nil, e
	}
	if !s.SQLite {
		tx, err := db.Begin()
		if err != nil {
			db.Close()
			return nil, err
		}
		_, err = tx.Exec(`INSERT INTO snapshot_threads(device_id,thread_id,payload) SELECT s.device_id,t.key,t.value FROM snapshots s CROSS JOIN LATERAL jsonb_each(s.payload->'threads') AS t(key,value) WHERE s.payload ? 'threads' ON CONFLICT(device_id,thread_id) DO UPDATE SET payload=EXCLUDED.payload`)
		if err == nil {
			_, err = tx.Exec("UPDATE snapshots SET payload=payload-'threads' WHERE payload ? 'threads'")
		}
		if err != nil {
			tx.Rollback()
			db.Close()
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			db.Close()
			return nil, err
		}
	}
	s.Q("UPDATE commands SET status='unknown',result=" + s.jsonObject("'commandId',id,'deviceId',device_id,'status','unknown','code','relay-restarted'") + " WHERE status='pending'")
	return s, nil
}
func (s *Store) Close() error { return s.DB.Close() }
func (s *Store) jsonObject(fields string) string {
	if s.SQLite {
		return "json_object(" + fields + ")"
	}
	return "jsonb_build_object(" + fields + ")"
}
func (s *Store) SQL(q string) string {
	if s.SQLite {
		q = casts.ReplaceAllString(q, "")
		q = strings.ReplaceAll(q, " FOR UPDATE", "")
	}
	return q
}
func (s *Store) Q(q string, args ...any) []M {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	rows, e := s.q.QueryContext(ctx, s.SQL(q), args...)
	if e != nil {
		s.Metrics.Observe("database", start, true)
		panic(e)
	}
	defer rows.Close()
	names, e := rows.Columns()
	if e != nil {
		panic(e)
	}
	out := []M{}
	for rows.Next() {
		values := make([]any, len(names))
		ptrs := make([]any, len(names))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if e = rows.Scan(ptrs...); e != nil {
			panic(e)
		}
		row := M{}
		for i, k := range names {
			v := values[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			if (k == "payload" || k == "result" || k == "catalog") && v != nil {
				switch x := v.(type) {
				case string:
					var decoded any
					if json.Unmarshal([]byte(x), &decoded) == nil {
						v = decoded
					}
				}
			}
			row[k] = v
		}
		out = append(out, row)
	}
	if e = rows.Err(); e != nil {
		panic(e)
	}
	s.Metrics.Observe("database", start, false)
	return out
}
func (s *Store) One(q string, args ...any) M {
	rows := s.Q(q, args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}
func (s *Store) Tx(fn func(*Store)) {
	start := time.Now()
	tx, e := s.DB.BeginTx(context.Background(), nil)
	if e != nil {
		panic(e)
	}
	done := false
	defer func() {
		if !done {
			_ = tx.Rollback()
			s.Metrics.Observe("transactions", start, true)
		}
	}()
	fn(&Store{DB: s.DB, q: tx, SQLite: s.SQLite, Metrics: s.Metrics})
	if e = tx.Commit(); e != nil {
		panic(e)
	}
	done = true
	s.Metrics.Observe("transactions", start, false)
}

const sqliteSchema = `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE,password_hash TEXT,role TEXT NOT NULL DEFAULT 'user',created_at BIGINT NOT NULL,revoked_at BIGINT);
CREATE UNIQUE INDEX IF NOT EXISTS account_role_login ON users(role,lower(name)) WHERE password_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,platform TEXT NOT NULL,token_hash TEXT UNIQUE,created_at BIGINT NOT NULL,last_seen_at BIGINT,revoked_at BIGINT,owner_user_id TEXT REFERENCES users(id),installation_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS account_installation ON devices(owner_user_id,installation_id) WHERE installation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS snapshots(device_id TEXT PRIMARY KEY REFERENCES devices(id),epoch TEXT NOT NULL,seq BIGINT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshot_threads(device_id TEXT NOT NULL REFERENCES snapshots(device_id) ON DELETE CASCADE,thread_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(device_id,thread_id));
CREATE TABLE IF NOT EXISTS catalogs(device_id TEXT PRIMARY KEY REFERENCES devices(id),payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(device_id TEXT NOT NULL REFERENCES devices(id),epoch TEXT NOT NULL,seq BIGINT NOT NULL,payload TEXT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(device_id,epoch,seq));
CREATE INDEX IF NOT EXISTS events_cleanup ON events(created_at);
CREATE TABLE IF NOT EXISTS commands(device_id TEXT NOT NULL REFERENCES devices(id),id TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT,expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(device_id,id));
CREATE INDEX IF NOT EXISTS commands_pending_expiry ON commands(expires_at,device_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),device_id TEXT REFERENCES devices(id),expires_at BIGINT NOT NULL,last_active_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_cleanup ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY,expires_at BIGINT NOT NULL,owner_user_id TEXT REFERENCES users(id),session_hash TEXT);
CREATE INDEX IF NOT EXISTS tickets_cleanup ON tickets(expires_at);
CREATE TABLE IF NOT EXISTS auth_settings(id INTEGER PRIMARY KEY CHECK(id=1),idle_timeout_minutes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS images(device_id TEXT NOT NULL REFERENCES devices(id),thread_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,bytes BIGINT NOT NULL,uploaded BOOLEAN NOT NULL,expires_at BIGINT,created_at BIGINT NOT NULL,PRIMARY KEY(device_id,thread_id,id));
CREATE INDEX IF NOT EXISTS images_cleanup ON images(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS weixin_bindings(id TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL REFERENCES users(id),bot_id TEXT UNIQUE NOT NULL,peer_id TEXT UNIQUE NOT NULL,base_url TEXT NOT NULL,token TEXT NOT NULL,context TEXT,cursor TEXT,created_at BIGINT NOT NULL,last_poll_at BIGINT,notifications BOOLEAN NOT NULL DEFAULT TRUE,replies BOOLEAN NOT NULL DEFAULT TRUE,poll_error TEXT,send_error TEXT,reply_target_code TEXT);
CREATE TABLE IF NOT EXISTS weixin_targets(user_id TEXT NOT NULL REFERENCES users(id),code TEXT NOT NULL,device_id TEXT NOT NULL REFERENCES devices(id),thread_id TEXT NOT NULL,PRIMARY KEY(user_id,code),UNIQUE(user_id,device_id,thread_id));
CREATE TABLE IF NOT EXISTS weixin_thread_notifications(user_id TEXT NOT NULL REFERENCES users(id),device_id TEXT NOT NULL REFERENCES devices(id),thread_id TEXT NOT NULL,PRIMARY KEY(user_id,device_id,thread_id));
CREATE TABLE IF NOT EXISTS weixin_outbox(binding_id TEXT NOT NULL REFERENCES weixin_bindings(id) ON DELETE CASCADE,id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,client_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at BIGINT NOT NULL,created_at BIGINT NOT NULL,error TEXT,device_id TEXT REFERENCES devices(id),target_code TEXT,PRIMARY KEY(binding_id,id));
CREATE INDEX IF NOT EXISTS weixin_pending ON weixin_outbox(binding_id,next_attempt_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS weixin_inbox(binding_id TEXT NOT NULL REFERENCES weixin_bindings(id) ON DELETE CASCADE,id TEXT NOT NULL,created_at BIGINT NOT NULL,device_id TEXT,command_id TEXT,PRIMARY KEY(binding_id,id));
CREATE INDEX IF NOT EXISTS weixin_outbox_cleanup ON weixin_outbox(created_at) WHERE state<>'pending';
CREATE INDEX IF NOT EXISTS weixin_inbox_cleanup ON weixin_inbox(created_at);
`
