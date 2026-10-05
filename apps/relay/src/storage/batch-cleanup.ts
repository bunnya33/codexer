import { setImmediate } from "node:timers/promises";
import type { Sql } from "./types.js";

export type CleanupOptions = {
  batchSize?: number;
  maxBatches?: number;
  signal?: AbortSignal;
  onBatch?: (deleted: number) => void;
};
export type CleanupResult = {
  deleted: number;
  batches: number;
  capped: boolean;
  interrupted: boolean;
};
export type CleanupSummary = Record<string, CleanupResult>;

type CleanupTarget = {
  table: string;
  predicate: string;
  orderBy: string;
  params: unknown[];
};

/**
 * 表名和条件仅来自代码中的固定配置，不接收 HTTP 输入。
 * 每批独立提交并让出事件循环；ctid 只在当前语句内使用，不保存为记录身份。
 */
export async function deleteInBatches(
  sql: Sql,
  target: CleanupTarget,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const batchSize = options.batchSize ?? 500;
  const maxBatches = options.maxBatches ?? 20;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 10000 ||
    !Number.isInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > 1000
  ) {
    throw new Error("invalid-cleanup-options");
  }
  const result: CleanupResult = { deleted: 0, batches: 0, capped: false, interrupted: false };
  const limitParameter = target.params.length + 1;

  while (result.batches < maxBatches) {
    if (options.signal?.aborted) {
      result.interrupted = true;
      return result;
    }
    const { rows } = await sql.query(
      `DELETE FROM ${target.table}
       WHERE (${target.predicate}) AND ctid IN (
         SELECT ctid FROM ${target.table} WHERE ${target.predicate}
         ORDER BY ${target.orderBy} LIMIT $${limitParameter}
       ) RETURNING 1`,
      [...target.params, batchSize],
    );
    result.batches++;
    result.deleted += rows.length;
    options.onBatch?.(rows.length);
    if (rows.length < batchSize) return result;
    await setImmediate();
  }

  // 达到本轮预算后下次继续，避免过期数据堆积时一次清理长期占用数据库。
  result.capped = true;
  return result;
}
