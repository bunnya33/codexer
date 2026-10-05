import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "../../../../packages/shared/src/accounts.js";
import type { Row, Sql, Transaction } from "../storage/types.js";

/** 账号、密码与禁用；敏感变更在事务中撤销会话及微信绑定。 */
export class AccountRepository {
  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction,
  ) {}

  async createUser(
    name: string,
    password: string,
    role: "admin" | "user" = "user",
  ): Promise<{ id: string; name: string; role: string }> {
    name = name.trim();
    if (!name || name.length > 100) throw new Error("invalid-account-name");
    const passwordHash = await hashPassword(password),
      id = randomUUID();
    await this.sql.query(
      "INSERT INTO users(id,name,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5)",
      [id, name, passwordHash, role, Date.now()],
    );
    return { id, name, role };
  }

  async hasAdmin(): Promise<boolean> {
    return (
      (
        await this.sql.query(
          "SELECT id FROM users WHERE role='admin' AND password_hash IS NOT NULL AND revoked_at IS NULL",
        )
      ).rows.length > 0
    );
  }

  async listUsers(role?: "admin" | "user"): Promise<Row[]> {
    return (
      await this.sql.query(
        "SELECT id,name,role,created_at,revoked_at,(password_hash IS NOT NULL) AS login_enabled FROM users WHERE ($1::text IS NULL OR role=$1) ORDER BY created_at",
        [role ?? null],
      )
    ).rows;
  }

  async checkPassword(
    name: string,
    password: string,
    role: "admin" | "user" = "user",
  ): Promise<{ id: string; kind: "admin" | "user" } | null> {
    const row = (
      await this.sql.query(
        "SELECT id,role,password_hash FROM users WHERE lower(name)=lower($1) AND role=$2 AND password_hash IS NOT NULL AND revoked_at IS NULL",
        [name.trim(), role],
      )
    ).rows[0];
    if (!(await verifyPassword(password, row ? String(row.password_hash) : null))) return null;
    return { id: String(row!.id), kind: row!.role === "admin" ? "admin" : "user" };
  }

  async userActive(id: string): Promise<boolean> {
    return (
      (
        await this.sql.query(
          "SELECT id FROM users WHERE id=$1 AND revoked_at IS NULL AND password_hash IS NOT NULL",
          [id],
        )
      ).rows.length === 1
    );
  }

  async revokeUser(
    id: string,
    role: "admin" | "user" = "user",
    actorId?: string,
  ): Promise<boolean> {
    return this.transaction(async (sql) => {
      if (role === "admin") {
        const admins = (
          await sql.query(
            "SELECT id FROM users WHERE role='admin' AND revoked_at IS NULL AND password_hash IS NOT NULL FOR UPDATE",
          )
        ).rows;
        if (actorId === id || admins.length <= 1) throw new Error("admin-disable-protected");
      }
      const rows = (
        await sql.query(
          "UPDATE users SET revoked_at=$2 WHERE id=$1 AND role=$3 AND revoked_at IS NULL RETURNING id",
          [id, Date.now(), role],
        )
      ).rows;
      if (!rows.length) return false;
      await sql.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await sql.query("DELETE FROM tickets WHERE owner_user_id=$1", [id]);
      await sql.query("DELETE FROM weixin_bindings WHERE user_id=$1", [id]);
      return true;
    });
  }

  async resetPassword(
    id: string,
    password: string,
    role: "admin" | "user" = "user",
  ): Promise<boolean> {
    const encoded = await hashPassword(password);
    return this.transaction(async (sql) => {
      if (
        !(
          await sql.query(
            "UPDATE users SET password_hash=$2,token_hash=NULL WHERE id=$1 AND role=$3 AND revoked_at IS NULL RETURNING id",
            [id, encoded, role],
          )
        ).rows.length
      )
        return false;
      await sql.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await sql.query("DELETE FROM tickets WHERE owner_user_id=$1", [id]);
      await sql.query("DELETE FROM weixin_bindings WHERE user_id=$1", [id]);
      return true;
    });
  }
}
