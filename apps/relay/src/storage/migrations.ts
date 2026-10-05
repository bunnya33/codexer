import { DEFAULT_IDLE_TIMEOUT_MINUTES } from "../../../../packages/shared/src/session-policy.js";
import type { Database } from "./types.js";

/** 启动时先补齐旧版结构，再原子迁移快照；不会重置已有账号与事件。 */
export async function migrateDatabase(database: Database): Promise<void> {
  const { sql, transaction } = database;
  for (const statement of [
    "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at BIGINT NOT NULL, last_seen_at BIGINT, revoked_at BIGINT)",
    "CREATE TABLE IF NOT EXISTS snapshots (device_id TEXT PRIMARY KEY REFERENCES devices(id), epoch TEXT NOT NULL, seq BIGINT NOT NULL, payload JSONB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS catalogs (device_id TEXT PRIMARY KEY REFERENCES devices(id), payload JSONB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS events (device_id TEXT NOT NULL REFERENCES devices(id), epoch TEXT NOT NULL, seq BIGINT NOT NULL, payload JSONB NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(device_id, epoch, seq))",
    "CREATE TABLE IF NOT EXISTS commands (device_id TEXT NOT NULL REFERENCES devices(id), id TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, result JSONB, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(device_id,id))",
    "CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS images (device_id TEXT NOT NULL REFERENCES devices(id), thread_id TEXT NOT NULL, id TEXT NOT NULL, payload JSONB NOT NULL, bytes BIGINT NOT NULL, uploaded BOOLEAN NOT NULL, expires_at BIGINT, created_at BIGINT NOT NULL, PRIMARY KEY(device_id,thread_id,id))",
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at BIGINT NOT NULL, revoked_at BIGINT)",
    "ALTER TABLE devices ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id)",
    "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'",
    "ALTER TABLE users ALTER COLUMN token_hash DROP NOT NULL",
    "ALTER TABLE devices ALTER COLUMN token_hash DROP NOT NULL",
    "ALTER TABLE devices ADD COLUMN IF NOT EXISTS installation_id TEXT",
    "CREATE UNIQUE INDEX IF NOT EXISTS account_role_login ON users(role,lower(name)) WHERE password_hash IS NOT NULL",
    "DROP INDEX IF EXISTS account_login",
    "CREATE UNIQUE INDEX IF NOT EXISTS account_installation ON devices(owner_user_id,installation_id) WHERE installation_id IS NOT NULL",
    "CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), device_id TEXT REFERENCES devices(id), expires_at BIGINT NOT NULL)",
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_active_at BIGINT",
    "UPDATE sessions SET last_active_at=GREATEST(0,expires_at-604800000) WHERE last_active_at IS NULL",
    "ALTER TABLE sessions ALTER COLUMN last_active_at SET NOT NULL",
    "CREATE TABLE IF NOT EXISTS auth_settings (id INTEGER PRIMARY KEY CHECK(id=1), idle_timeout_minutes INTEGER NOT NULL)",
    "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS session_hash TEXT",
  ])
    await sql.query(statement);

  await sql.query(
    "INSERT INTO auth_settings(id,idle_timeout_minutes) VALUES(1,$1) ON CONFLICT(id) DO NOTHING",
    [DEFAULT_IDLE_TIMEOUT_MINUTES],
  );

  await sql.query(
    "UPDATE commands SET status='unknown', result=jsonb_build_object('commandId',id,'deviceId',device_id,'status','unknown','code','relay-restarted') WHERE status='pending'",
  );
  await sql.query(
    "CREATE TABLE IF NOT EXISTS snapshot_threads (device_id TEXT NOT NULL REFERENCES snapshots(device_id) ON DELETE CASCADE, thread_id TEXT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY(device_id,thread_id))",
  );
  // 迁移与移除旧 threads 字段在同一事务内，失败后旧数据仍完整可读。
  await transaction(async (sql) => {
    await sql.query(`INSERT INTO snapshot_threads(device_id,thread_id,payload)
SELECT s.device_id,t.key,t.value FROM snapshots s
CROSS JOIN LATERAL jsonb_each(s.payload->'threads') AS t(key,value)
WHERE s.payload ? 'threads'
ON CONFLICT(device_id,thread_id) DO UPDATE SET payload=EXCLUDED.payload`);
    await sql.query("UPDATE snapshots SET payload=payload-'threads' WHERE payload ? 'threads'");
  });

  for (const statement of [
    "CREATE INDEX IF NOT EXISTS events_cleanup ON events(created_at)",
    "CREATE INDEX IF NOT EXISTS commands_pending_expiry ON commands(expires_at,device_id) WHERE status='pending'",
    "CREATE INDEX IF NOT EXISTS tickets_cleanup ON tickets(expires_at)",
    "CREATE INDEX IF NOT EXISTS sessions_cleanup ON sessions(expires_at)",
    "CREATE INDEX IF NOT EXISTS images_cleanup ON images(expires_at) WHERE expires_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS devices_revoked ON devices(id) WHERE revoked_at IS NOT NULL",
  ]) {
    await sql.query(statement);
  }
}
