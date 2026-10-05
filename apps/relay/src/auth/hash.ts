import { createHash } from "node:crypto";

/** 只保存凭据摘要；命令摘要保留现有 JSON 字节兼容性。 */
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
