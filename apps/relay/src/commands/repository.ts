import { jsonForStorage } from "../../../../packages/shared/src/json.js";
import { hash } from "../auth/hash.js";
import type { CommandResult } from "../../../../packages/protocol/src/index.js";
import type { RemoteCommand } from "../../../../packages/protocol/src/index.js";
import type { Row, Sql } from "../storage/types.js";

/** 命令幂等记录与结果；终态只能从 pending 提交一次。 */
export class CommandRepository {
  constructor(private readonly sql: Sql) {}

  async command(id: string, commandId: string): Promise<Row | null> {
    return (
      (
        await this.sql.query(
          "SELECT payload_hash,status,result FROM commands WHERE device_id=$1 AND id=$2",
          [id, commandId],
        )
      ).rows[0] ?? null
    );
  }

  async addCommand(command: RemoteCommand): Promise<void> {
    await this.sql.query(
      "INSERT INTO commands(device_id,id,payload_hash,status,expires_at,created_at) VALUES($1,$2,$3,'pending',$4,$5)",
      [
        command.deviceId,
        command.commandId,
        hash(JSON.stringify(command)),
        command.expiresAt,
        Date.now(),
      ],
    );
  }

  async finishCommand(result: CommandResult): Promise<boolean> {
    return (
      (
        await this.sql.query(
          "UPDATE commands SET status=$3,result=$4::jsonb WHERE device_id=$1 AND id=$2 AND status='pending' RETURNING id",
          [result.deviceId, result.commandId, result.status, jsonForStorage(result)],
        )
      ).rows.length === 1
    );
  }

  async expiredCommandDevices(): Promise<string[]> {
    const { rows } = await this.sql.query(
      "SELECT DISTINCT device_id FROM commands WHERE status='pending' AND expires_at<$1",
      [Date.now() - 5000],
    );
    return rows.map((row) => String(row.device_id));
  }

  async expireCommands(deviceId?: string): Promise<CommandResult[]> {
    const { rows } = await this.sql.query(
      `UPDATE commands SET status='unknown',result=jsonb_build_object('commandId',id,'deviceId',device_id,'status','unknown','code','command-outcome-unconfirmed') WHERE status='pending' AND expires_at<$1${deviceId === undefined ? "" : " AND device_id=$2"} RETURNING result`,
      deviceId === undefined ? [Date.now() - 5000] : [Date.now() - 5000, deviceId],
    );
    return rows.map((row) => row.result as CommandResult);
  }
}
