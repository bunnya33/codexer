import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "../../../packages/shared/src/accounts.js";
import { jsonForStorage } from "../../../packages/shared/src/json.js";
import { authSettingsSchema, DEFAULT_IDLE_TIMEOUT_MINUTES } from "../../../packages/shared/src/session-policy.js";
import type { AuthSettings } from "../../../packages/shared/src/session-policy.js";
import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { reduceEvent } from "../../../packages/protocol/src/index.js";
import type { CommandResult, DeviceCatalog, DeviceSnapshot, ImagePayload, RemoteCommand, RemoteEvent } from "../../../packages/protocol/src/index.js";
import { WeixinStore } from './weixin-store.js';

type Row = Record<string, unknown>;
type Sql = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
export type Principal = { kind: "admin" | "user"; id: string; sessionHash?: string; expiresAt?: number };
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export class RelayStore {
  readonly weixin: WeixinStore;
  private constructor(private readonly sql: Sql, private readonly transaction: <T>(operation: (sql: Sql) => Promise<T>) => Promise<T>, readonly close: () => Promise<void>) { this.weixin = new WeixinStore(sql,transaction); }
  static async open(databaseUrl?: string, directory?: string): Promise<RelayStore> {
    let store: RelayStore;
    if (databaseUrl) {
      const pool = new Pool({ connectionString: databaseUrl });
      store = new RelayStore(pool, async operation => {
        const client = await pool.connect();
        try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
        catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      }, () => pool.end());
    } else {
      if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
      const db = new PGlite(directory);
      await db.waitReady;
      store = new RelayStore(db, operation => db.transaction(tx => operation(tx)), () => db.close());
    }
    await store.initialize();
    await store.weixin.initialize();
    return store;
  }
  private async initialize(): Promise<void> {
    for (const sql of [
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
    ]) await this.sql.query(sql);
    await this.sql.query("INSERT INTO auth_settings(id,idle_timeout_minutes) VALUES(1,$1) ON CONFLICT(id) DO NOTHING", [DEFAULT_IDLE_TIMEOUT_MINUTES]);
    await this.sql.query("UPDATE commands SET status='unknown', result=jsonb_build_object('commandId',id,'deviceId',device_id,'status','unknown','code','relay-restarted') WHERE status='pending'");
  }
  async createUser(name: string, password: string, role: "admin" | "user" = "user"): Promise<{ id: string; name: string; role: string }> {
    name = name.trim();
    if (!name || name.length > 100) throw new Error("invalid-account-name");
    const passwordHash = await hashPassword(password), id = randomUUID();
    await this.sql.query("INSERT INTO users(id,name,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5)", [id, name, passwordHash, role, Date.now()]);
    return { id, name, role };
  }
  async hasAdmin(): Promise<boolean> {
    return (await this.sql.query("SELECT id FROM users WHERE role='admin' AND password_hash IS NOT NULL AND revoked_at IS NULL")).rows.length > 0;
  }
  async listUsers(role?: "admin" | "user"): Promise<Row[]> {
    return (await this.sql.query("SELECT id,name,role,created_at,revoked_at,(password_hash IS NOT NULL) AS login_enabled FROM users WHERE ($1::text IS NULL OR role=$1) ORDER BY created_at", [role ?? null])).rows;
  }
  async checkPassword(name: string, password: string, role: "admin" | "user" = "user"): Promise<{ id: string; kind: "admin" | "user" } | null> {
    const row = (await this.sql.query("SELECT id,role,password_hash FROM users WHERE lower(name)=lower($1) AND role=$2 AND password_hash IS NOT NULL AND revoked_at IS NULL", [name.trim(), role])).rows[0];
    if (!await verifyPassword(password, row ? String(row.password_hash) : null)) return null;
    return { id: String(row!.id), kind: row!.role === "admin" ? "admin" : "user" };
  }
  async userActive(id: string): Promise<boolean> {
    return (await this.sql.query("SELECT id FROM users WHERE id=$1 AND revoked_at IS NULL AND password_hash IS NOT NULL", [id])).rows.length === 1;
  }
  async createSession(userId: string, deviceId: string | null = null): Promise<{ session: string; expiresAt: number }> {
    const now = Date.now(), timeout = deviceId === null ? (await this.authSettings()).idleTimeoutMinutes * 60000 : 7 * 86400000;
    const session = randomBytes(32).toString("base64url"), expiresAt = now + timeout;
    await this.sql.query("INSERT INTO sessions(hash,user_id,device_id,expires_at,last_active_at) SELECT $1,id,$3,$4,$5 FROM users WHERE id=$2 AND revoked_at IS NULL AND password_hash IS NOT NULL", [hash(session), userId, deviceId, expiresAt, now]);
    return { session, expiresAt };
  }
  async authSettings(): Promise<AuthSettings> {
    const row = (await this.sql.query("SELECT idle_timeout_minutes FROM auth_settings WHERE id=1")).rows[0]!;
    return {idleTimeoutMinutes: Number(row.idle_timeout_minutes)};
  }
  async setAuthSettings(value: AuthSettings): Promise<AuthSettings> {
    const settings = authSettingsSchema.parse(value), now = Date.now();
    await this.transaction(async sql => {
      // Extending the policy must never revive an already expired login.
      await sql.query("DELETE FROM sessions WHERE device_id IS NULL AND expires_at<=$1", [now]);
      await sql.query("UPDATE auth_settings SET idle_timeout_minutes=$1 WHERE id=1", [settings.idleTimeoutMinutes]);
      await sql.query("UPDATE sessions SET expires_at=last_active_at+$1 WHERE device_id IS NULL", [settings.idleTimeoutMinutes * 60000]);
      await sql.query("DELETE FROM tickets WHERE session_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions WHERE hash=tickets.session_hash)");
    });
    return settings;
  }
  async touchSession(sessionHash: string): Promise<{expiresAt: number; idleTimeoutMinutes: number} | null> {
    const now = Date.now();
    const row = (await this.sql.query("UPDATE sessions SET last_active_at=$2,expires_at=$2+(SELECT idle_timeout_minutes::bigint*60000 FROM auth_settings WHERE id=1) WHERE hash=$1 AND device_id IS NULL AND expires_at>$2 AND EXISTS(SELECT 1 FROM users WHERE id=sessions.user_id AND revoked_at IS NULL AND password_hash IS NOT NULL) RETURNING expires_at,(SELECT idle_timeout_minutes FROM auth_settings WHERE id=1) AS timeout", [sessionHash, now])).rows[0];
    return row ? {expiresAt: Number(row.expires_at), idleTimeoutMinutes: Number(row.timeout)} : null;
  }
  async sessionPrincipal(session: string, deviceId: string | null = null): Promise<Principal | null> {
    return this.sessionForHash(hash(session), deviceId);
  }
  async sessionForHash(sessionHash: string, deviceId: string | null = null): Promise<Principal | null> {
    const row = (await this.sql.query("SELECT u.id,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>$2 AND s.device_id IS NOT DISTINCT FROM $3::text AND u.revoked_at IS NULL AND u.password_hash IS NOT NULL AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM devices d WHERE d.id=$3 AND d.owner_user_id=u.id AND d.revoked_at IS NULL))", [sessionHash, Date.now(), deviceId])).rows[0];
    return row ? { id: String(row.id), kind: row.role === "admin" ? "admin" : "user", sessionHash, expiresAt: Number(row.expires_at) } : null;
  }
  async logout(sessionHash: string): Promise<void> {
    await this.sql.query("DELETE FROM sessions WHERE hash=$1", [sessionHash]);
    await this.sql.query("DELETE FROM tickets WHERE session_hash=$1", [sessionHash]);
  }
  async revokeUser(id: string, role: "admin" | "user" = "user", actorId?: string): Promise<boolean> {
    return this.transaction(async sql => {
      if (role === "admin") {
        const admins = (await sql.query("SELECT id FROM users WHERE role='admin' AND revoked_at IS NULL AND password_hash IS NOT NULL FOR UPDATE")).rows;
        if (actorId === id || admins.length <= 1) throw new Error("admin-disable-protected");
      }
      const rows = (await sql.query("UPDATE users SET revoked_at=$2 WHERE id=$1 AND role=$3 AND revoked_at IS NULL RETURNING id", [id, Date.now(), role])).rows;
      if (!rows.length) return false;
      await sql.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await sql.query("DELETE FROM tickets WHERE owner_user_id=$1", [id]);
      await sql.query('DELETE FROM weixin_bindings WHERE user_id=$1', [id]);
      return true;
    });
  }
  async resetPassword(id: string, password: string, role: "admin" | "user" = "user"): Promise<boolean> {
    const encoded = await hashPassword(password);
    return this.transaction(async sql => {
      if (!(await sql.query("UPDATE users SET password_hash=$2,token_hash=NULL WHERE id=$1 AND role=$3 AND revoked_at IS NULL RETURNING id", [id, encoded, role])).rows.length) return false;
      await sql.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await sql.query("DELETE FROM tickets WHERE owner_user_id=$1", [id]);
      await sql.query('DELETE FROM weixin_bindings WHERE user_id=$1', [id]);
      return true;
    });
  }
  async registerAgent(ownerId: string, installationId: string, name: string, platform: string): Promise<string> {
    return this.transaction(async sql => {
      const rows = (await sql.query("INSERT INTO devices(id,name,platform,created_at,owner_user_id,installation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_user_id,installation_id) WHERE installation_id IS NOT NULL DO UPDATE SET name=EXCLUDED.name,platform=EXCLUDED.platform,revoked_at=NULL RETURNING id", [randomUUID(), name, platform, Date.now(), ownerId, installationId])).rows;
      const id = String(rows[0]!.id);
      await sql.query("DELETE FROM sessions WHERE device_id=$1", [id]);
      return id;
    });
  }
  async authorizeDevice(id: string, session: string): Promise<boolean> {
    return (await this.sessionPrincipal(session, id))?.kind === "user";
  }
  async ownsDevice(id: string, principal: Principal): Promise<boolean> {
    if (principal.kind !== "user") return false;
    if (principal.sessionHash && !await this.sessionForHash(principal.sessionHash)) return false;
    return (await this.sql.query("SELECT d.id FROM devices d JOIN users u ON u.id=d.owner_user_id WHERE d.id=$1 AND d.owner_user_id=$2 AND d.revoked_at IS NULL AND u.revoked_at IS NULL", [id, principal.id])).rows.length === 1;
  }
  async listDevices(principal: Principal): Promise<Row[]> {
    return (await this.sql.query("SELECT id,name,platform,created_at,last_seen_at FROM devices WHERE revoked_at IS NULL AND owner_user_id=$1 ORDER BY created_at", [principal.id])).rows;
  }
  async revoke(id: string): Promise<boolean> { return (await this.sql.query("UPDATE devices SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING id", [id, Date.now()])).rows.length === 1; }
  async touch(id: string): Promise<void> { await this.sql.query("UPDATE devices SET last_seen_at=$2 WHERE id=$1", [id, Date.now()]); }
  async ticket(principal: Principal): Promise<{ ticket: string; expiresAt: number }> {
    if (principal.kind !== "user") throw new Error("control-account-required");
    if (!principal.sessionHash || !await this.sessionForHash(principal.sessionHash)) throw new Error("session-expired");
    const ticket = randomBytes(32).toString("base64url"), expiresAt = Date.now() + 60000;
    await this.sql.query("INSERT INTO tickets(hash,expires_at,owner_user_id,session_hash) VALUES($1,$2,$3,$4)", [hash(ticket), expiresAt, principal.id, principal.sessionHash]);
    return { ticket, expiresAt };
  }
  async consumeTicket(ticket: string): Promise<Principal | null> {
    const row = (await this.sql.query("DELETE FROM tickets WHERE hash=$1 AND expires_at>$2 RETURNING session_hash", [hash(ticket), Date.now()])).rows[0];
    const principal = row?.session_hash ? await this.sessionForHash(String(row.session_hash)) : null;
    return principal?.kind === "user" ? principal : null;
  }
  async snapshot(id: string): Promise<DeviceSnapshot | null> {
    const { rows } = await this.sql.query("SELECT payload FROM snapshots WHERE device_id=$1 AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)", [id]);
    return rows[0] ? rows[0].payload as DeviceSnapshot : null;
  }
  async catalog(id: string): Promise<DeviceCatalog | null> {
    const { rows } = await this.sql.query("SELECT payload FROM catalogs WHERE device_id=$1 AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)", [id]);
    return rows[0] ? rows[0].payload as DeviceCatalog : null;
  }
  async saveCatalog(catalog: DeviceCatalog): Promise<void> {
    await this.sql.query("INSERT INTO catalogs(device_id,payload) VALUES($1,$2::jsonb) ON CONFLICT(device_id) DO UPDATE SET payload=EXCLUDED.payload", [catalog.deviceId, jsonForStorage(catalog)]);
  }
  async saveSnapshot(snapshot: DeviceSnapshot): Promise<void> {
    await this.transaction(async sql => {
      const existing = (await sql.query('SELECT payload FROM snapshots WHERE device_id=$1 FOR UPDATE',[snapshot.deviceId])).rows[0]?.payload as DeviceSnapshot | undefined;
      if (existing?.epoch === snapshot.epoch && existing.lastSeq > snapshot.lastSeq) throw new Error("stale-snapshot");
      await sql.query("INSERT INTO snapshots(device_id,epoch,seq,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(device_id) DO UPDATE SET epoch=EXCLUDED.epoch,seq=EXCLUDED.seq,payload=EXCLUDED.payload", [snapshot.deviceId, snapshot.epoch, snapshot.lastSeq, jsonForStorage(snapshot)]);
      await this.weixin.completions(sql,existing??null,snapshot);
    });
  }
  async saveEvent(event: RemoteEvent): Promise<DeviceSnapshot> {
    return this.transaction(async sql => {
      const { rows } = await sql.query("SELECT payload FROM snapshots WHERE device_id=$1 FOR UPDATE", [event.deviceId]);
      if (!rows[0]) throw new Error("snapshot-required");
      event = JSON.parse(jsonForStorage(event)) as RemoteEvent;
      const snapshot = reduceEvent(rows[0].payload as DeviceSnapshot, event);
      await sql.query("INSERT INTO events(device_id,epoch,seq,payload,created_at) VALUES($1,$2,$3,$4::jsonb,$5)", [event.deviceId, event.epoch, event.seq, jsonForStorage(event), Date.now()]);
      await sql.query("UPDATE snapshots SET seq=$2,payload=$3::jsonb WHERE device_id=$1", [event.deviceId, event.seq, jsonForStorage(snapshot)]);
      await this.weixin.completions(sql,rows[0].payload as DeviceSnapshot,snapshot);
      return snapshot;
    });
  }
  async replay(id: string, epoch: string, seq: number): Promise<RemoteEvent[] | null> {
    const snapshot = await this.snapshot(id);
    if (!snapshot || snapshot.epoch !== epoch || seq > snapshot.lastSeq) return null;
    if (seq === snapshot.lastSeq) return [];
    const { rows } = await this.sql.query("SELECT seq,payload FROM events WHERE device_id=$1 AND epoch=$2 AND seq>$3 ORDER BY seq LIMIT 1000", [id, epoch, seq]);
    if (rows.length !== snapshot.lastSeq - seq || rows.some((row, index) => Number(row.seq) !== seq + index + 1)) return null;
    return rows.map(row => row.payload as RemoteEvent);
  }
  async command(id: string, commandId: string): Promise<Row | null> { return (await this.sql.query("SELECT payload_hash,status,result FROM commands WHERE device_id=$1 AND id=$2", [id, commandId])).rows[0] ?? null; }
  async addCommand(command: RemoteCommand): Promise<void> {
    await this.sql.query("INSERT INTO commands(device_id,id,payload_hash,status,expires_at,created_at) VALUES($1,$2,$3,'pending',$4,$5)", [command.deviceId, command.commandId, hash(JSON.stringify(command)), command.expiresAt, Date.now()]);
  }
  async image(deviceId: string, threadId: string, id: string, uploadedOnly = false): Promise<ImagePayload | null> {
    const { rows } = await this.sql.query("SELECT payload FROM images WHERE device_id=$1 AND thread_id=$2 AND id=$3 AND (expires_at IS NULL OR expires_at>$4) AND ($5=FALSE OR uploaded=TRUE) AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)", [deviceId, threadId, id, Date.now(), uploadedOnly]);
    return rows[0]?.payload as ImagePayload ?? null;
  }
  async saveImage(deviceId: string, threadId: string, id: string, image: ImagePayload, uploaded: boolean): Promise<void> {
    const bytes = Buffer.byteLength(image.base64, "base64");
    const total = (await this.sql.query("SELECT COALESCE(SUM(bytes),0) AS total FROM images WHERE device_id=$1 AND NOT (thread_id=$2 AND id=$3)", [deviceId, threadId, id])).rows[0]?.total;
    if (Number(total) + bytes > 128 * 1024 * 1024) throw new Error("image-storage-full");
    await this.sql.query("INSERT INTO images(device_id,thread_id,id,payload,bytes,uploaded,expires_at,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT(device_id,thread_id,id) DO UPDATE SET payload=EXCLUDED.payload,expires_at=CASE WHEN images.expires_at IS NULL THEN NULL ELSE EXCLUDED.expires_at END", [deviceId, threadId, id, jsonForStorage(image), bytes, uploaded, Date.now() + (uploaded ? 86400000 : 7 * 86400000), Date.now()]);
  }
  async retainImages(deviceId: string, threadId: string, ids: string[]): Promise<void> {
    for (const id of ids) await this.sql.query("UPDATE images SET expires_at=$4 WHERE device_id=$1 AND thread_id=$2 AND id=$3 AND uploaded=TRUE", [deviceId, threadId, id, Date.now() + 7 * 86400000]);
  }
  async finishCommand(result: CommandResult): Promise<boolean> {
    return (await this.sql.query("UPDATE commands SET status=$3,result=$4::jsonb WHERE device_id=$1 AND id=$2 AND status='pending' RETURNING id", [result.deviceId, result.commandId, result.status, jsonForStorage(result)])).rows.length === 1;
  }
  async expireCommands(): Promise<CommandResult[]> {
    const { rows } = await this.sql.query("UPDATE commands SET status='unknown',result=jsonb_build_object('commandId',id,'deviceId',device_id,'status','unknown','code','command-outcome-unconfirmed') WHERE status='pending' AND expires_at<$1 RETURNING result", [Date.now() - 5000]);
    return rows.map(row => row.result as CommandResult);
  }
  async cleanup(): Promise<void> {
    const now = Date.now();
    await this.sql.query("DELETE FROM events WHERE created_at<$1", [now - 86400000]);
    await this.sql.query("DELETE FROM tickets WHERE expires_at<$1", [now]);
    await this.sql.query("DELETE FROM sessions WHERE expires_at<$1", [now]);
    await this.sql.query("DELETE FROM images WHERE expires_at<$1 OR EXISTS(SELECT 1 FROM devices WHERE id=images.device_id AND revoked_at IS NOT NULL)", [now]);
    await this.weixin.cleanup();
  }
}
