import { randomUUID } from "node:crypto";
import { jsonForStorage } from "../../../../packages/shared/src/json.js";
import type { Principal } from "../auth/types.js";
import type { DeviceCatalog } from "../../../../packages/protocol/src/index.js";
import type { Row, Sql, Transaction } from "../storage/types.js";
import type { SessionRepository } from "../auth/sessions.js";

/** 设备归属、注册与目录；在线连接由 transport 独立维护。 */
export class DeviceRepository {
  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction,
    private readonly sessions: SessionRepository,
  ) {}

  async registerAgent(
    ownerId: string,
    installationId: string,
    name: string,
    platform: string,
  ): Promise<string> {
    return this.transaction(async (sql) => {
      const rows = (
        await sql.query(
          "INSERT INTO devices(id,name,platform,created_at,owner_user_id,installation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_user_id,installation_id) WHERE installation_id IS NOT NULL DO UPDATE SET name=EXCLUDED.name,platform=EXCLUDED.platform,revoked_at=NULL RETURNING id",
          [randomUUID(), name, platform, Date.now(), ownerId, installationId],
        )
      ).rows;
      const id = String(rows[0]!.id);
      await sql.query("DELETE FROM sessions WHERE device_id=$1", [id]);
      return id;
    });
  }

  async authorizeDevice(id: string, session: string): Promise<boolean> {
    return (await this.sessions.sessionPrincipal(session, id))?.kind === "user";
  }

  async ownsDevice(id: string, principal: Principal): Promise<boolean> {
    if (principal.kind !== "user") return false;
    if (principal.sessionHash && !(await this.sessions.sessionForHash(principal.sessionHash)))
      return false;
    return (
      (
        await this.sql.query(
          "SELECT d.id FROM devices d JOIN users u ON u.id=d.owner_user_id WHERE d.id=$1 AND d.owner_user_id=$2 AND d.revoked_at IS NULL AND u.revoked_at IS NULL",
          [id, principal.id],
        )
      ).rows.length === 1
    );
  }

  async listDevices(principal: Principal): Promise<Row[]> {
    return (
      await this.sql.query(
        "SELECT id,name,platform,created_at,last_seen_at FROM devices WHERE revoked_at IS NULL AND owner_user_id=$1 ORDER BY created_at",
        [principal.id],
      )
    ).rows;
  }

  async revoke(id: string): Promise<boolean> {
    return (
      (
        await this.sql.query(
          "UPDATE devices SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING id",
          [id, Date.now()],
        )
      ).rows.length === 1
    );
  }

  async touch(id: string): Promise<void> {
    await this.sql.query("UPDATE devices SET last_seen_at=$2 WHERE id=$1", [id, Date.now()]);
  }

  async catalog(id: string): Promise<DeviceCatalog | null> {
    const { rows } = await this.sql.query(
      "SELECT payload FROM catalogs WHERE device_id=$1 AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)",
      [id],
    );
    return rows[0] ? (rows[0].payload as DeviceCatalog) : null;
  }

  async saveCatalog(catalog: DeviceCatalog): Promise<void> {
    await this.sql.query(
      "INSERT INTO catalogs(device_id,payload) VALUES($1,$2::jsonb) ON CONFLICT(device_id) DO UPDATE SET payload=EXCLUDED.payload",
      [catalog.deviceId, jsonForStorage(catalog)],
    );
  }
}
