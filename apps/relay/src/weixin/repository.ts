import { randomBytes, randomUUID } from "node:crypto";
import type {
  CommandResult,
  DeviceCatalog,
  DeviceSnapshot,
  RemoteCommand,
  RemoteThread,
} from "../../../../packages/protocol/src/index.js";
import { WeixinError } from "./api.js";
import { deleteInBatches } from "../storage/batch-cleanup.js";
import type { CleanupOptions, CleanupSummary } from "../storage/batch-cleanup.js";

type Row = Record<string, unknown>;
export type WeixinSql = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> };
type Transaction = <T>(operation: (sql: WeixinSql) => Promise<T>) => Promise<T>;
export type WeixinBinding = {
  id: string;
  userId: string;
  botId: string;
  peerId: string;
  baseUrl: string;
  token: string;
  context: string | null;
  cursor: string | null;
  createdAt: number;
  lastPollAt: number | null;
  notifications: boolean;
  replies: boolean;
  pollError: string | null;
  sendError: string | null;
};
function binding(row: Row): WeixinBinding {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    botId: String(row.bot_id),
    peerId: String(row.peer_id),
    baseUrl: String(row.base_url),
    token: String(row.token),
    context: row.context as string | null,
    cursor: row.cursor as string | null,
    createdAt: Number(row.created_at),
    lastPollAt: row.last_poll_at == null ? null : Number(row.last_poll_at),
    notifications: Boolean(row.notifications),
    replies: Boolean(row.replies),
    pollError: row.poll_error as string | null,
    sendError: row.send_error as string | null,
  };
}
export function completedTurns(
  before: DeviceSnapshot | null,
  after: DeviceSnapshot,
): { thread: RemoteThread; turn: RemoteThread["turns"][number] }[] {
  if (!before) return []; // Initial sync is a baseline, not a flood of old work.
  const result: { thread: RemoteThread; turn: RemoteThread["turns"][number] }[] = [];
  for (const thread of Object.values(after.threads)) {
    const previous = before.threads[thread.id];
    if (!previous) continue;
    for (const turn of thread.turns) {
      const old = previous.turns.find((value) => value.id === turn.id);
      // Agent updates are coalesced. A short new turn may arrive already
      // completed, without a separately published inProgress state.
      const fresh =
        !old &&
        turn.startedAtMs != null &&
        turn.completedAtMs != null &&
        turn.startedAtMs >= before.generatedAt - 1000 &&
        turn.completedAtMs >= before.generatedAt;
      if (
        turn.status === "completed" &&
        (old?.status === "inProgress" || previous.activeTurnId === turn.id || fresh)
      )
        result.push({ thread, turn });
    }
  }
  return result;
}

export class WeixinStore {
  constructor(
    private readonly sql: WeixinSql,
    private readonly transaction: Transaction,
  ) {}

  async initialize() {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS weixin_bindings (id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id), bot_id TEXT UNIQUE NOT NULL, peer_id TEXT UNIQUE NOT NULL, base_url TEXT NOT NULL, token TEXT NOT NULL, context TEXT, cursor TEXT, created_at BIGINT NOT NULL, last_poll_at BIGINT, notifications BOOLEAN NOT NULL DEFAULT TRUE, replies BOOLEAN NOT NULL DEFAULT TRUE, poll_error TEXT, send_error TEXT)",
      "CREATE TABLE IF NOT EXISTS weixin_targets (user_id TEXT NOT NULL REFERENCES users(id), code TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id), thread_id TEXT NOT NULL, PRIMARY KEY(user_id,code), UNIQUE(user_id,device_id,thread_id))",
      "CREATE TABLE IF NOT EXISTS weixin_thread_notifications (user_id TEXT NOT NULL REFERENCES users(id), device_id TEXT NOT NULL REFERENCES devices(id), thread_id TEXT NOT NULL, PRIMARY KEY(user_id,device_id,thread_id))",
      "CREATE TABLE IF NOT EXISTS weixin_outbox (binding_id TEXT NOT NULL REFERENCES weixin_bindings(id) ON DELETE CASCADE, id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, client_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at BIGINT NOT NULL, created_at BIGINT NOT NULL, error TEXT, PRIMARY KEY(binding_id,id))",
      "CREATE TABLE IF NOT EXISTS weixin_inbox (binding_id TEXT NOT NULL REFERENCES weixin_bindings(id) ON DELETE CASCADE, id TEXT NOT NULL, created_at BIGINT NOT NULL, device_id TEXT, command_id TEXT, PRIMARY KEY(binding_id,id))",
      "CREATE INDEX IF NOT EXISTS weixin_pending ON weixin_outbox(binding_id,next_attempt_at) WHERE state='pending'",
      "ALTER TABLE weixin_outbox ADD COLUMN IF NOT EXISTS device_id TEXT REFERENCES devices(id)",
      "ALTER TABLE weixin_outbox ADD COLUMN IF NOT EXISTS target_code TEXT",
      "ALTER TABLE weixin_bindings ADD COLUMN IF NOT EXISTS reply_target_code TEXT",
      "CREATE INDEX IF NOT EXISTS weixin_outbox_cleanup ON weixin_outbox(created_at) WHERE state<>'pending'",
      "CREATE INDEX IF NOT EXISTS weixin_inbox_cleanup ON weixin_inbox(created_at)",
    ])
      await this.sql.query(sql);
  }

  async get(userId: string): Promise<WeixinBinding | null> {
    const row = (
      await this.sql.query(
        "SELECT b.* FROM weixin_bindings b JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 AND u.revoked_at IS NULL AND u.role='user' AND u.password_hash IS NOT NULL",
        [userId],
      )
    ).rows[0];
    return row ? binding(row) : null;
  }

  async active(): Promise<WeixinBinding[]> {
    return (
      await this.sql.query(
        "SELECT b.* FROM weixin_bindings b JOIN users u ON u.id=b.user_id WHERE u.revoked_at IS NULL AND u.role='user' AND u.password_hash IS NOT NULL",
      )
    ).rows.map(binding);
  }

  async current(id: string, userId: string): Promise<boolean> {
    return (await this.get(userId))?.id === id;
  }

  async bind(
    value: Pick<WeixinBinding, "id" | "userId" | "botId" | "peerId" | "baseUrl" | "token">,
  ) {
    try {
      await this.transaction(async (sql) => {
        if (
          !(
            await sql.query(
              "SELECT id FROM users WHERE id=$1 AND role='user' AND revoked_at IS NULL AND password_hash IS NOT NULL FOR UPDATE",
              [value.userId],
            )
          ).rows.length
        )
          throw new WeixinError("weixin-account-inactive", 403);
        const conflict = (
          await sql.query(
            "SELECT user_id FROM weixin_bindings WHERE (bot_id=$1 OR peer_id=$2) AND user_id<>$3",
            [value.botId, value.peerId, value.userId],
          )
        ).rows[0];
        if (conflict) throw new WeixinError("weixin-bot-already-bound", 409);
        await sql.query("DELETE FROM weixin_bindings WHERE user_id=$1", [value.userId]);
        await sql.query(
          "INSERT INTO weixin_bindings(id,user_id,bot_id,peer_id,base_url,token,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            value.id,
            value.userId,
            value.botId,
            value.peerId,
            value.baseUrl,
            value.token,
            Date.now(),
          ],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new WeixinError("weixin-bot-already-bound", 409);
      throw error;
    }
  }

  async unbind(userId: string) {
    await this.sql.query("DELETE FROM weixin_bindings WHERE user_id=$1", [userId]);
  }

  async settings(userId: string, notifications: boolean, replies: boolean) {
    await this.transaction(async (sql) => {
      await sql.query("UPDATE weixin_bindings SET notifications=$2,replies=$3 WHERE user_id=$1", [
        userId,
        notifications,
        replies,
      ]);
      if (!notifications)
        await sql.query(
          "DELETE FROM weixin_outbox o WHERE kind='completion' AND binding_id IN (SELECT id FROM weixin_bindings WHERE user_id=$1) AND NOT EXISTS (SELECT 1 FROM weixin_targets t JOIN weixin_thread_notifications n ON n.user_id=t.user_id AND n.device_id=t.device_id AND n.thread_id=t.thread_id WHERE t.user_id=$1 AND t.code=o.target_code AND t.device_id=o.device_id)",
          [userId],
        );
    });
  }

  /** 仅存储显式开启的会话，缺省关闭；偏好独立于微信绑定和登录设备。 */
  async threadNotifications(
    userId: string,
    deviceId: string,
    threadId: string,
    sql = this.sql,
  ): Promise<boolean> {
    return (
      (
        await sql.query(
          "SELECT 1 FROM weixin_thread_notifications WHERE user_id=$1 AND device_id=$2 AND thread_id=$3",
          [userId, deviceId, threadId],
        )
      ).rows.length > 0
    );
  }

  async setThreadNotifications(
    userId: string,
    deviceId: string,
    threadId: string,
    enabled: boolean,
  ) {
    await this.transaction(async (sql) => {
      if (enabled)
        await sql.query(
          "INSERT INTO weixin_thread_notifications(user_id,device_id,thread_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [userId, deviceId, threadId],
        );
      else {
        await sql.query(
          "DELETE FROM weixin_thread_notifications WHERE user_id=$1 AND device_id=$2 AND thread_id=$3",
          [userId, deviceId, threadId],
        );
        await sql.query(
          "DELETE FROM weixin_outbox o WHERE kind='completion' AND device_id=$2 AND binding_id IN (SELECT id FROM weixin_bindings WHERE user_id=$1 AND notifications=FALSE) AND target_code IN (SELECT code FROM weixin_targets WHERE user_id=$1 AND device_id=$2 AND thread_id=$3)",
          [userId, deviceId, threadId],
        );
      }
    });
  }

  async completionAllowed(
    userId: string,
    deviceId: string | null,
    targetCode: string | null,
  ): Promise<boolean> {
    if (!deviceId || !targetCode) return false;
    return (
      (
        await this.sql.query(
          "SELECT 1 FROM weixin_targets t JOIN weixin_thread_notifications n ON n.user_id=t.user_id AND n.device_id=t.device_id AND n.thread_id=t.thread_id WHERE t.user_id=$1 AND t.device_id=$2 AND t.code=$3",
          [userId, deviceId, targetCode],
        )
      ).rows.length > 0
    );
  }

  async polled(id: string, cursor?: string, context?: string) {
    await this.sql.query(
      "UPDATE weixin_bindings SET cursor=COALESCE($2,cursor),context=COALESCE($3,context),last_poll_at=$4,poll_error=NULL WHERE id=$1",
      [id, cursor ?? null, context ?? null, Date.now()],
    );
    if (context)
      await this.sql.query(
        "UPDATE weixin_outbox SET next_attempt_at=$2 WHERE binding_id=$1 AND state='pending'",
        [id, Date.now()],
      );
  }

  async error(id: string, field: "poll" | "send", code: string | null) {
    await this.sql.query(
      `UPDATE weixin_bindings SET ${field === "poll" ? "poll_error" : "send_error"}=$2 WHERE id=$1`,
      [id, code],
    );
  }

  private async targetWithSql(
    sql: WeixinSql,
    userId: string,
    deviceId: string,
    threadId: string,
  ): Promise<string> {
    const row = (
      await sql.query(
        "SELECT code FROM weixin_targets WHERE user_id=$1 AND device_id=$2 AND thread_id=$3",
        [userId, deviceId, threadId],
      )
    ).rows[0];
    if (row) return String(row.code);
    for (let i = 0; i < 5; i++) {
      const code = `C${randomBytes(4).toString("hex").toUpperCase()}`;
      const saved = (
        await sql.query(
          "INSERT INTO weixin_targets(user_id,code,device_id,thread_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING code",
          [userId, code, deviceId, threadId],
        )
      ).rows[0];
      if (saved) return String(saved.code);
      const existing = (
        await sql.query(
          "SELECT code FROM weixin_targets WHERE user_id=$1 AND device_id=$2 AND thread_id=$3",
          [userId, deviceId, threadId],
        )
      ).rows[0];
      if (existing) return String(existing.code);
    }
    throw new Error("weixin-target-conflict");
  }

  async target(userId: string, deviceId: string, threadId: string): Promise<string> {
    if (
      !(
        await this.sql.query(
          "SELECT d.id FROM devices d JOIN users u ON u.id=d.owner_user_id WHERE d.id=$1 AND d.owner_user_id=$2 AND d.revoked_at IS NULL AND u.revoked_at IS NULL AND u.role='user'",
          [deviceId, userId],
        )
      ).rows.length
    )
      throw new WeixinError("device-not-found", 404);
    return this.targetWithSql(this.sql, userId, deviceId, threadId);
  }

  async resolve(
    userId: string,
    code: string,
  ): Promise<{ deviceId: string; threadId: string } | null> {
    const row = (
      await this.sql.query(
        "SELECT t.device_id,t.thread_id FROM weixin_targets t JOIN devices d ON d.id=t.device_id JOIN users u ON u.id=t.user_id WHERE t.user_id=$1 AND t.code=$2 AND d.owner_user_id=t.user_id AND d.revoked_at IS NULL AND u.revoked_at IS NULL AND u.role='user'",
        [userId, code],
      )
    ).rows[0];
    return row ? { deviceId: String(row.device_id), threadId: String(row.thread_id) } : null;
  }

  /** 只使用这个绑定最近成功发出的会话，归属失效时不回退到其他会话。 */
  async replyTarget(bindingId: string, userId: string) {
    const row = (
      await this.sql.query(
        "SELECT reply_target_code FROM weixin_bindings WHERE id=$1 AND user_id=$2",
        [bindingId, userId],
      )
    ).rows[0];
    if (!row?.reply_target_code) return null;
    const code = String(row.reply_target_code);
    const target = await this.resolve(userId, code);
    return target ? { ...target, code } : null;
  }

  private async enqueueSql(
    sql: WeixinSql,
    id: string,
    key: string,
    kind: string,
    text: string,
    deviceId?: string,
    targetCode?: string,
  ) {
    const pending = Number(
      (
        await sql.query(
          "SELECT COUNT(*) AS n FROM weixin_outbox WHERE binding_id=$1 AND state='pending'",
          [id],
        )
      ).rows[0]?.n ?? 0,
    );
    if (pending >= 200) {
      await sql.query("UPDATE weixin_bindings SET send_error='weixin-queue-full' WHERE id=$1", [
        id,
      ]);
      return;
    }
    await sql.query(
      "INSERT INTO weixin_outbox(binding_id,id,kind,text,client_id,next_attempt_at,created_at,device_id,target_code) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        id,
        key,
        kind,
        text.replaceAll("\u0000", "").slice(0, 3900),
        `codexer-${randomUUID()}`,
        Date.now(),
        deviceId ?? null,
        targetCode ?? null,
      ],
    );
  }

  async enqueue(id: string, key: string, kind: string, text: string, targetCode?: string) {
    await this.enqueueSql(this.sql, id, key, kind, text, undefined, targetCode);
  }

  // Called inside the same transaction that saves the device state. A crash
  // cannot persist a completion while losing its queued notification.
  async completions(sql: WeixinSql, before: DeviceSnapshot | null, after: DeviceSnapshot) {
    const completed = completedTurns(before, after);
    if (!completed.length) return;
    const row = (
      await sql.query(
        "SELECT b.*,d.name AS device_name,c.payload AS catalog FROM devices d JOIN users u ON u.id=d.owner_user_id JOIN weixin_bindings b ON b.user_id=u.id LEFT JOIN catalogs c ON c.device_id=d.id WHERE d.id=$1 AND d.revoked_at IS NULL AND u.revoked_at IS NULL AND u.role='user'",
        [after.deviceId],
      )
    ).rows[0];
    if (!row) return;
    const catalog = row.catalog as DeviceCatalog | null;
    for (const { thread, turn } of completed) {
      if (
        !row.notifications &&
        !(await this.threadNotifications(String(row.user_id), after.deviceId, thread.id, sql))
      )
        continue;
      if (turn.completedAtMs != null && turn.completedAtMs < Number(row.created_at)) continue;
      const code = await this.targetWithSql(sql, String(row.user_id), after.deviceId, thread.id);
      const entry = catalog?.threads.find((value) => value.id === thread.id);
      const project =
        catalog?.projects.find((value) => value.id === entry?.projectId)?.name ??
        thread.cwd ??
        "未分组项目";
      const final =
        [...turn.items]
          .reverse()
          .find((value) => value.type === "agentMessage" && value.phase === "final_answer") ??
        [...turn.items].reverse().find((value) => value.type === "agentMessage");
      const summary = final?.text?.trim().slice(0, 1000) ?? "请打开 Codexer 查看执行结果。";
      await this.enqueueSql(
        sql,
        String(row.id),
        `completion:${after.deviceId}:${thread.id}:${turn.id}`,
        "completion",
        `本轮执行完成\n设备：${String(row.device_name).slice(0, 150)}\n项目：${project.slice(0, 300)}\n会话：${thread.title.slice(0, 300)}\n编号：${code}\n\n${summary}\n\n直接回复你的下一步要求即可续做。收到多个会话的通知时，默认继续最近一条对应的会话。`,
        after.deviceId,
        code,
      );
    }
  }

  async claim(id: string, messageId: string): Promise<boolean> {
    return (
      (
        await this.sql.query(
          "INSERT INTO weixin_inbox(binding_id,id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
          [id, messageId, Date.now()],
        )
      ).rows.length === 1
    );
  }

  async command(id: string, messageId: string, command: RemoteCommand) {
    await this.sql.query(
      "UPDATE weixin_inbox SET device_id=$3,command_id=$4 WHERE binding_id=$1 AND id=$2",
      [id, messageId, command.deviceId, command.commandId],
    );
  }

  async commandResult(result: CommandResult) {
    if (result.status === "succeeded") return;
    const rows = (
      await this.sql.query(
        "SELECT i.binding_id,i.id FROM weixin_inbox i JOIN weixin_bindings b ON b.id=i.binding_id JOIN users u ON u.id=b.user_id WHERE i.device_id=$1 AND i.command_id=$2 AND u.revoked_at IS NULL",
        [result.deviceId, result.commandId],
      )
    ).rows;
    for (const row of rows)
      await this.enqueue(
        String(row.binding_id),
        `result:${result.deviceId}:${result.commandId}`,
        "reply",
        result.status === "unknown"
          ? "这条指令的执行结果尚未确认，请打开 Codexer 查看实际会话，再决定是否重试。"
          : "这条指令未能执行，请确认 PC 在线且会话可操作，再打开 Codexer 查看详情。",
      );
  }

  async next(id: string): Promise<{
    id: string;
    text: string;
    clientId: string;
    attempts: number;
    createdAt: number;
    kind: string;
    deviceId: string | null;
    targetCode: string | null;
  } | null> {
    const row = (
      await this.sql.query(
        "SELECT * FROM weixin_outbox WHERE binding_id=$1 AND state='pending' AND next_attempt_at<=$2 ORDER BY created_at,id LIMIT 1",
        [id, Date.now()],
      )
    ).rows[0];
    return row
      ? {
          id: String(row.id),
          text: String(row.text),
          clientId: String(row.client_id),
          attempts: Number(row.attempts),
          createdAt: Number(row.created_at),
          kind: String(row.kind),
          deviceId: row.device_id as string | null,
          targetCode: row.target_code as string | null,
        }
      : null;
  }

  async delivered(id: string, key: string, rememberTarget = true) {
    // 投递状态和默认回复目标一起提交，失败重试或无关提示不会切换会话。
    await this.transaction(async (sql) => {
      const row = (
        await sql.query(
          "UPDATE weixin_outbox SET state='sent',error=NULL WHERE binding_id=$1 AND id=$2 AND state='pending' RETURNING target_code",
          [id, key],
        )
      ).rows[0];
      await sql.query(
        "UPDATE weixin_bindings SET send_error=NULL,reply_target_code=COALESCE($2,reply_target_code) WHERE id=$1",
        [id, rememberTarget ? (row?.target_code ?? null) : null],
      );
    });
  }

  async retry(id: string, key: string, code: string, attempts: number, terminal = false) {
    await this.sql.query(
      "UPDATE weixin_outbox SET attempts=$3,next_attempt_at=$4,error=$5,state=$6 WHERE binding_id=$1 AND id=$2",
      [
        id,
        key,
        attempts,
        Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)),
        code,
        terminal ? "failed" : "pending",
      ],
    );
    await this.error(id, "send", code);
  }

  async pending(id: string): Promise<number> {
    return Number(
      (
        await this.sql.query(
          "SELECT COUNT(*) AS n FROM weixin_outbox WHERE binding_id=$1 AND state='pending'",
          [id],
        )
      ).rows[0]?.n ?? 0,
    );
  }

  async cleanup(options: CleanupOptions = {}): Promise<CleanupSummary> {
    const cutoff = Date.now() - 30 * 86400000;
    const weixinOutbox = await deleteInBatches(
      this.sql,
      {
        table: "weixin_outbox",
        predicate: "state<>'pending' AND created_at<$1",
        orderBy: "created_at",
        params: [cutoff],
      },
      options,
    );
    const weixinInbox = await deleteInBatches(
      this.sql,
      {
        table: "weixin_inbox",
        predicate: "created_at<$1",
        orderBy: "created_at",
        params: [cutoff],
      },
      options,
    );
    return { weixinOutbox, weixinInbox };
  }
}
