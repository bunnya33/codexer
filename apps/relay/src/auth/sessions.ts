import { randomBytes } from "node:crypto";
import { authSettingsSchema } from "../../../../packages/shared/src/session-policy.js";
import type { AuthSettings } from "../../../../packages/shared/src/session-policy.js";
import { hash } from "../auth/hash.js";
import type { Principal } from "../auth/types.js";
import type { Sql, Transaction } from "../storage/types.js";

/** 会话与一次性票据；控制端使用空闲超时，Agent 会话固定为七天。 */
export class SessionRepository {
  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction,
  ) {}

  async createSession(
    userId: string,
    deviceId: string | null = null,
  ): Promise<{ session: string; expiresAt: number }> {
    const now = Date.now(),
      timeout =
        deviceId === null ? (await this.authSettings()).idleTimeoutMinutes * 60000 : 7 * 86400000;
    const session = randomBytes(32).toString("base64url"),
      expiresAt = now + timeout;
    await this.sql.query(
      "INSERT INTO sessions(hash,user_id,device_id,expires_at,last_active_at) SELECT $1,id,$3,$4,$5 FROM users WHERE id=$2 AND revoked_at IS NULL AND password_hash IS NOT NULL",
      [hash(session), userId, deviceId, expiresAt, now],
    );
    return { session, expiresAt };
  }

  async authSettings(): Promise<AuthSettings> {
    const row = (await this.sql.query("SELECT idle_timeout_minutes FROM auth_settings WHERE id=1"))
      .rows[0]!;
    return { idleTimeoutMinutes: Number(row.idle_timeout_minutes) };
  }

  async setAuthSettings(value: AuthSettings): Promise<AuthSettings> {
    const settings = authSettingsSchema.parse(value),
      now = Date.now();
    await this.transaction(async (sql) => {
      // Extending the policy must never revive an already expired login.
      await sql.query("DELETE FROM sessions WHERE device_id IS NULL AND expires_at<=$1", [now]);
      await sql.query("UPDATE auth_settings SET idle_timeout_minutes=$1 WHERE id=1", [
        settings.idleTimeoutMinutes,
      ]);
      await sql.query("UPDATE sessions SET expires_at=last_active_at+$1 WHERE device_id IS NULL", [
        settings.idleTimeoutMinutes * 60000,
      ]);
      await sql.query(
        "DELETE FROM tickets WHERE session_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sessions WHERE hash=tickets.session_hash)",
      );
    });
    return settings;
  }

  async touchSession(
    sessionHash: string,
  ): Promise<{ expiresAt: number; idleTimeoutMinutes: number } | null> {
    const now = Date.now();
    const row = (
      await this.sql.query(
        "UPDATE sessions SET last_active_at=$2,expires_at=$2+(SELECT idle_timeout_minutes::bigint*60000 FROM auth_settings WHERE id=1) WHERE hash=$1 AND device_id IS NULL AND expires_at>$2 AND EXISTS(SELECT 1 FROM users WHERE id=sessions.user_id AND revoked_at IS NULL AND password_hash IS NOT NULL) RETURNING expires_at,(SELECT idle_timeout_minutes FROM auth_settings WHERE id=1) AS timeout",
        [sessionHash, now],
      )
    ).rows[0];
    return row
      ? { expiresAt: Number(row.expires_at), idleTimeoutMinutes: Number(row.timeout) }
      : null;
  }

  async sessionPrincipal(
    session: string,
    deviceId: string | null = null,
  ): Promise<Principal | null> {
    return this.sessionForHash(hash(session), deviceId);
  }

  async sessionForHash(
    sessionHash: string,
    deviceId: string | null = null,
  ): Promise<Principal | null> {
    const row = (
      await this.sql.query(
        "SELECT u.id,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>$2 AND s.device_id IS NOT DISTINCT FROM $3::text AND u.revoked_at IS NULL AND u.password_hash IS NOT NULL AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM devices d WHERE d.id=$3 AND d.owner_user_id=u.id AND d.revoked_at IS NULL))",
        [sessionHash, Date.now(), deviceId],
      )
    ).rows[0];
    return row
      ? {
          id: String(row.id),
          kind: row.role === "admin" ? "admin" : "user",
          sessionHash,
          expiresAt: Number(row.expires_at),
        }
      : null;
  }

  async logout(sessionHash: string): Promise<void> {
    await this.sql.query("DELETE FROM sessions WHERE hash=$1", [sessionHash]);
    await this.sql.query("DELETE FROM tickets WHERE session_hash=$1", [sessionHash]);
  }

  async ticket(principal: Principal): Promise<{ ticket: string; expiresAt: number }> {
    if (principal.kind !== "user") throw new Error("control-account-required");
    if (!principal.sessionHash || !(await this.sessionForHash(principal.sessionHash)))
      throw new Error("session-expired");
    const ticket = randomBytes(32).toString("base64url"),
      expiresAt = Date.now() + 60000;
    await this.sql.query(
      "INSERT INTO tickets(hash,expires_at,owner_user_id,session_hash) VALUES($1,$2,$3,$4)",
      [hash(ticket), expiresAt, principal.id, principal.sessionHash],
    );
    return { ticket, expiresAt };
  }

  async consumeTicket(ticket: string): Promise<Principal | null> {
    const row = (
      await this.sql.query(
        "DELETE FROM tickets WHERE hash=$1 AND expires_at>$2 RETURNING session_hash",
        [hash(ticket), Date.now()],
      )
    ).rows[0];
    const principal = row?.session_hash
      ? await this.sessionForHash(String(row.session_hash))
      : null;
    return principal?.kind === "user" ? principal : null;
  }
}
