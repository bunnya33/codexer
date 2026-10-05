import { MAX_THREADS, reduceEvent } from "../../../../packages/protocol/src/index.js";
import type {
  DeviceSnapshot,
  RemoteEvent,
  RemoteThread,
} from "../../../../packages/protocol/src/index.js";
import { jsonForStorage } from "../../../../packages/shared/src/json.js";
import type { Sql, Transaction } from "../storage/types.js";
import type { WeixinStore } from "../weixin/repository.js";

export type SnapshotMetadata = Omit<DeviceSnapshot, "threads">;

function metadata(snapshot: DeviceSnapshot): SnapshotMetadata {
  const { threads: _threads, ...head } = snapshot;
  return head;
}

/**
 * 设备元数据与会话预览分别存储；高频事件只读写受影响的会话。
 * 完整快照只在同步读取时组装，单条查询保证元数据和会话来自同一数据库视图。
 */
export class SyncRepository {
  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction,
    private readonly weixin: WeixinStore,
  ) {}

  async snapshot(id: string): Promise<DeviceSnapshot | null> {
    return this.readSnapshot(this.sql, id, true);
  }

  async snapshotMetadata(id: string): Promise<SnapshotMetadata | null> {
    const { rows } = await this.sql.query(
      "SELECT payload FROM snapshots WHERE device_id=$1 AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)",
      [id],
    );

    return rows[0] ? (rows[0].payload as SnapshotMetadata) : null;
  }

  private async readSnapshot(
    sql: Sql,
    id: string,
    requireActive = false,
  ): Promise<DeviceSnapshot | null> {
    const { rows } = await sql.query(
      `SELECT s.payload,
        COALESCE((SELECT jsonb_object_agg(t.thread_id,t.payload)
          FROM snapshot_threads t WHERE t.device_id=s.device_id),'{}'::jsonb) AS threads
       FROM snapshots s WHERE s.device_id=$1
         AND ($2=FALSE OR EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL))`,
      [id, requireActive],
    );
    const row = rows[0];

    return row
      ? { ...(row.payload as SnapshotMetadata), threads: row.threads as DeviceSnapshot["threads"] }
      : null;
  }

  async saveSnapshot(input: DeviceSnapshot): Promise<void> {
    const snapshot = JSON.parse(jsonForStorage(input)) as DeviceSnapshot;

    await this.transaction(async (sql) => {
      // 首次同步还没有 snapshots 行，锁设备行可避免两个初始化同时写入。
      await sql.query("SELECT id FROM devices WHERE id=$1 FOR UPDATE", [snapshot.deviceId]);
      await sql.query("SELECT device_id FROM snapshots WHERE device_id=$1 FOR UPDATE", [
        snapshot.deviceId,
      ]);
      const existing = await this.readSnapshot(sql, snapshot.deviceId);

      if (existing?.epoch === snapshot.epoch && existing.lastSeq > snapshot.lastSeq) {
        throw new Error("stale-snapshot");
      }

      await sql.query(
        `INSERT INTO snapshots(device_id,epoch,seq,payload) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(device_id) DO UPDATE SET epoch=EXCLUDED.epoch,seq=EXCLUDED.seq,payload=EXCLUDED.payload`,
        [snapshot.deviceId, snapshot.epoch, snapshot.lastSeq, jsonForStorage(metadata(snapshot))],
      );

      // 全量同步是替换而非合并，删除旧会话以免重连后恢复已移除的数据。
      await sql.query("DELETE FROM snapshot_threads WHERE device_id=$1", [snapshot.deviceId]);
      for (const [threadId, thread] of Object.entries(snapshot.threads)) {
        await this.writeThread(sql, snapshot.deviceId, threadId, thread);
      }

      await this.weixin.completions(sql, existing, snapshot);
    });
  }

  async saveEvent(input: RemoteEvent): Promise<void> {
    const event = JSON.parse(jsonForStorage(input)) as RemoteEvent;

    await this.transaction(async (sql) => {
      // 元数据行是同设备事件的顺序锁，事务失败不会推进 seq。
      const { rows } = await sql.query(
        "SELECT payload FROM snapshots WHERE device_id=$1 FOR UPDATE",
        [event.deviceId],
      );
      if (!rows[0]) throw new Error("snapshot-required");
      const head = rows[0].payload as SnapshotMetadata;
      const before: DeviceSnapshot = { ...head, threads: {} };

      if (event.change.type === "thread.updated") {
        const threadId = event.change.thread.id;
        const previous = (
          await sql.query(
            "SELECT payload FROM snapshot_threads WHERE device_id=$1 AND thread_id=$2",
            [event.deviceId, threadId],
          )
        ).rows[0];

        if (previous) {
          before.threads[threadId] = previous.payload as RemoteThread;
        } else {
          const count = (
            await sql.query("SELECT COUNT(*) AS total FROM snapshot_threads WHERE device_id=$1", [
              event.deviceId,
            ])
          ).rows[0];
          if (Number(count?.total) >= MAX_THREADS) throw new Error("thread-limit");
        }
      }

      // reducer 继续负责 epoch/seq 与运行状态语义。只传受影响会话，避免读取其它预览。
      const after = reduceEvent(before, event);
      await sql.query(
        "INSERT INTO events(device_id,epoch,seq,payload,created_at) VALUES($1,$2,$3,$4::jsonb,$5)",
        [event.deviceId, event.epoch, event.seq, jsonForStorage(event), Date.now()],
      );

      if (event.change.type === "thread.updated") {
        await this.writeThread(sql, event.deviceId, event.change.thread.id, event.change.thread);
      } else if (event.change.type === "thread.removed") {
        await sql.query("DELETE FROM snapshot_threads WHERE device_id=$1 AND thread_id=$2", [
          event.deviceId,
          event.change.threadId,
        ]);
      }

      await sql.query("UPDATE snapshots SET seq=$2,payload=$3::jsonb WHERE device_id=$1", [
        event.deviceId,
        event.seq,
        jsonForStorage(metadata(after)),
      ]);
      // 只比较变化会话，完成通知与事件/状态同时提交或同时回滚。
      await this.weixin.completions(sql, before, after);
    });
  }

  private async writeThread(
    sql: Sql,
    deviceId: string,
    threadId: string,
    thread: RemoteThread,
  ): Promise<void> {
    await sql.query(
      `INSERT INTO snapshot_threads(device_id,thread_id,payload) VALUES($1,$2,$3::jsonb)
       ON CONFLICT(device_id,thread_id) DO UPDATE SET payload=EXCLUDED.payload`,
      [deviceId, threadId, jsonForStorage(thread)],
    );
  }

  async replay(id: string, epoch: string, seq: number): Promise<RemoteEvent[] | null> {
    const head = await this.snapshotMetadata(id);
    if (!head || head.epoch !== epoch || seq > head.lastSeq) return null;
    if (seq === head.lastSeq) return [];
    const { rows } = await this.sql.query(
      "SELECT seq,payload FROM events WHERE device_id=$1 AND epoch=$2 AND seq>$3 ORDER BY seq LIMIT 1000",
      [id, epoch, seq],
    );

    if (
      rows.length !== head.lastSeq - seq ||
      rows.some((row, index) => Number(row.seq) !== seq + index + 1)
    )
      return null;
    return rows.map((row) => row.payload as RemoteEvent);
  }
}
