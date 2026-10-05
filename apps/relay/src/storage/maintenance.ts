import type { Sql } from "./types.js";
import type { WeixinStore } from "../weixin/repository.js";
import { deleteInBatches } from "./batch-cleanup.js";
import type { CleanupOptions, CleanupSummary } from "./batch-cleanup.js";

/** 清理短期缓存；命令幂等记录不在这里删除。 */
export async function cleanupStorage(
  sql: Sql,
  weixin: WeixinStore,
  options: CleanupOptions = {},
): Promise<CleanupSummary> {
  const now = Date.now();
  const summary: CleanupSummary = {};
  summary.events = await deleteInBatches(
    sql,
    {
      table: "events",
      predicate: "created_at<$1",
      orderBy: "created_at",
      params: [now - 86400000],
    },
    options,
  );
  summary.tickets = await deleteInBatches(
    sql,
    { table: "tickets", predicate: "expires_at<$1", orderBy: "expires_at", params: [now] },
    options,
  );
  summary.sessions = await deleteInBatches(
    sql,
    { table: "sessions", predicate: "expires_at<$1", orderBy: "expires_at", params: [now] },
    options,
  );
  // 分开过期和撤销两类条件，分别使用 expires_at 与 device_id 索引。
  summary.expiredImages = await deleteInBatches(
    sql,
    { table: "images", predicate: "expires_at<$1", orderBy: "expires_at", params: [now] },
    options,
  );
  summary.revokedImages = await deleteInBatches(
    sql,
    {
      table: "images",
      predicate: "device_id IN (SELECT id FROM devices WHERE revoked_at IS NOT NULL)",
      orderBy: "device_id,thread_id,id",
      params: [],
    },
    options,
  );
  return { ...summary, ...(await weixin.cleanup(options)) };
}
