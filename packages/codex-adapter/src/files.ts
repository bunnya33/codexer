import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import MarkdownIt from "markdown-it";
import { fileName, localFilePath } from "../../client-shared/src/file-links.js";
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES } from "../../protocol/src/files.js";
import type { FilePayload } from "../../protocol/src/files.js";
import type { HistoryTurn, RemoteThread } from "../../protocol/src/index.js";
import { previewReferences } from "../../client-shared/src/previews.js";

const parser = new MarkdownIt({ html: false });
parser.validateLink = (value) => localFilePath(value) !== null;

/** 仅登记官方会话消息中出现的链接；文件字节不进入快照、历史或数据库。 */
export class FileRegistry {
  private readonly sources = new Map<string, string>();
  observe(thread: Pick<RemoteThread, "id" | "turns">): void {
    for (const turn of thread.turns) this.observeTurn(thread.id, turn);
  }

  observeTurn(threadId: string, turn: Pick<HistoryTurn, "items">): void {
    for (const item of turn.items) {
      if (!["agentMessage", "userMessage", "steeringUserMessage"].includes(item.type) || !item.text)
        continue;
      for (const preview of previewReferences(item.text)) {
        if (preview.kind !== 'html' || !isAbsolute(preview.source)) continue;
        this.register(threadId, preview.source);
      }
      for (const token of parser.parse(item.text, {}))
        for (const child of token.children ?? []) {
          if (child.type !== "link_open") continue;
          const path = localFilePath(String(child.attrGet("href") ?? ""));
          if (!path || !isAbsolute(path) || path.length > 4096) continue;
          this.register(threadId, path);
        }
    }
  }

  private register(threadId: string, path: string): void {
    const key = JSON.stringify([threadId, path]);
    this.sources.delete(key);
    while (this.sources.size >= 10000) this.sources.delete(this.sources.keys().next().value!);
    this.sources.set(key, path);
  }

  async read(
    threadId: string,
    reference: string,
    offset?: number,
    expectedVersion?: string,
  ): Promise<FilePayload> {
    const normalized = localFilePath(reference);
    const path = normalized && this.sources.get(JSON.stringify([threadId, normalized]));
    if (!path) throw new Error("file-not-in-thread");
    const resolved = await realpath(path);
    // 非阻塞打开后检查普通文件，FIFO 等特殊文件不能占住整个读取队列。
    const file = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("file-unavailable");
      if (stat.size > MAX_FILE_BYTES) throw new Error("file-too-large");
      const versionFor = (value: typeof stat) =>
        createHash("sha256")
          .update(
            JSON.stringify([
              resolved,
              value.dev,
              value.ino,
              value.size,
              value.mtimeMs,
              value.ctimeMs,
            ]),
          )
          .digest("hex");
      const version = versionFor(stat);
      const info = { name: fileName(path).slice(0, 255), size: stat.size, version };
      if (offset === undefined) return info;
      if (version !== expectedVersion) throw new Error("file-changed");
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size)
        throw new Error("invalid-file-offset");
      const bytes = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, stat.size - offset));
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, offset + read);
        if (!result.bytesRead) throw new Error("file-changed");
        read += result.bytesRead;
      }
      if (versionFor(await file.stat()) !== version) throw new Error("file-changed");
      return { ...info, offset, base64: bytes.toString("base64") };
    } finally {
      await file.close();
    }
  }
}
