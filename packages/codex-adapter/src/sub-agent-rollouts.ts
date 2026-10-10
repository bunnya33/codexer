import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { RemoteSubAgent } from "../../protocol/src/index.js";
import { record } from "./normalize.js";
import type { RecordValue } from "./normalize.js";

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
const INDEX_INTERVAL_MS = 15000;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.slice(0, max).toWellFormed().replaceAll("\0", "\uFFFD")
    : undefined;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function parseLines(bytes: Buffer, offset = 0): RecordValue[] {
  const lines = bytes.toString("utf8").split("\n");
  if (offset) lines.shift();
  // The writer may still be appending its last JSON line.
  lines.pop();
  return lines.flatMap((line) => {
    try {
      return [record(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

/** Read visible messages only. Encrypted blocks and reasoning are never forwarded. */
function visibleText(content: unknown): string | undefined {
  const parts = array(content)
    .map(record)
    .filter(
      (value) =>
        ["input_text", "output_text", "text"].includes(String(value.type)) &&
        typeof value.text === "string",
    );
  return parts.length
    ? parts
        .map((value) => String(value.text))
        .join("\n")
        .trim()
    : undefined;
}

function readEvents(events: RecordValue[], details: RemoteSubAgent, startOrdinal: number): void {
  for (const event of events) {
    if (typeof event.ordinal === "number" && event.ordinal < startOrdinal) continue;
    const payload = record(event.payload);
    if (event.type === "turn_context" && text(payload.model, 200))
      details.model = text(payload.model, 200);
    if (event.type === "event_msg") {
      if (payload.type === "task_started") {
        details.status = "running";
        delete details.message;
      } else if (payload.type === "task_complete") {
        details.status = "completed";
        if (text(payload.last_agent_message, 2000))
          details.message = text(payload.last_agent_message, 2000);
      } else if (["turn_aborted", "task_interrupted"].includes(String(payload.type))) {
        details.status = "interrupted";
      } else if (payload.type === "task_failed") {
        details.status = "errored";
      }
      if (
        typeof payload.last_agent_message === "string" &&
        payload.last_agent_message.length > 2000
      )
        details.truncated = true;
    }
    if (event.type !== "response_item") continue;
    let task: string | undefined;
    if (payload.type === "agent_message") {
      const plain = visibleText(payload.content);
      // Native multi-agent messages can contain only a plaintext envelope followed by encrypted content.
      // An envelope without a readable payload is not a task description.
      if (plain && /^Message Type: (NEW_TASK|FOLLOWUP_TASK)\r?\n/.test(plain)) {
        const marker = /(?:^|\n)Payload:\s*\n/.exec(plain + "\n");
        if (marker) task = plain.slice(marker.index + marker[0].length).trim() || undefined;
      }
    } else if (payload.type === "message" && payload.role === "user") {
      const content = array(payload.content);
      const kinds = array(
        record(payload.internal_chat_message_metadata_passthrough).content_item_kinds,
      );
      const userContent = kinds.length
        ? content.filter((_, index) => kinds[index] === "user.text")
        : content;
      const plain = visibleText(userContent);
      if (plain && !/^(# AGENTS\.md|<environment_context>|<INSTRUCTIONS>)/.test(plain))
        task = plain;
    }
    if (task) {
      details.task = text(task, 2000);
      if (task.length > 2000) details.truncated = true;
    }
    if (payload.type === "message" && payload.role === "assistant") {
      const plain = visibleText(payload.content);
      if (plain) {
        details.message = text(plain, 2000);
        if (plain.length > 2000) details.truncated = true;
      }
    }
  }
}

type Cached = { path: string; size: number; mtime: number; details: RemoteSubAgent };

/** Supplement Desktop IPC activity records from each verified child's local rollout. */
export class SubAgentRollouts {
  private paths: string[] = [];
  private indexedAt = 0;
  private readonly cache = new Map<string, Cached>();
  constructor(private readonly home = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {}

  private async index(): Promise<void> {
    if (Date.now() - this.indexedAt < INDEX_INTERVAL_MS) return;
    const paths: string[] = [];
    const walk = async (directory: string, depth = 0): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const file = join(directory, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(file);
      }
    };
    await walk(join(this.home, "sessions"));
    this.paths = paths.sort().reverse();
    this.indexedAt = Date.now();
  }

  forget(parentId: string): void {
    for (const [key, value] of this.cache)
      if (value.details.parentThreadId === parentId) this.cache.delete(key);
  }

  enrich(parentId: string, agents: RemoteSubAgent[]): RemoteSubAgent[] {
    return agents.map((agent) => {
      const details = this.cache.get(JSON.stringify([parentId, agent.threadId]))?.details;
      if (!details) return agent;
      const keepStatus =
        details.status === "unknown" || ["shutdown", "notFound"].includes(agent.status);
      return {
        ...agent,
        ...details,
        ...(!details.message && details.status === "running" ? { message: undefined } : {}),
        ...(agent.task ? { task: agent.task } : {}),
        ...(keepStatus ? { status: agent.status, statusSource: agent.statusSource } : {}),
      };
    });
  }

  async refresh(parentId: string, agents: RemoteSubAgent[]): Promise<boolean> {
    if (!agents.length) return false;
    await this.index();
    let changed = false;
    for (const agent of agents) {
      const key = JSON.stringify([parentId, agent.threadId]);
      const prior = this.cache.get(key);
      const candidate =
        prior?.path ??
        this.paths.find((file) => basename(file).endsWith("-" + agent.threadId + ".jsonl"));
      if (!candidate) continue;
      try {
        const root = await realpath(join(this.home, "sessions"));
        const file = await realpath(candidate);
        const within = relative(root, file);
        if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
          if (this.cache.delete(key)) changed = true;
          continue;
        }
        const info = await stat(file);
        if (!info.isFile() || (prior && prior.size === info.size && prior.mtime === info.mtimeMs))
          continue;
        const handle = await open(file, "r");
        let head: Buffer, tail: Buffer | undefined;
        let tailOffset = 0;
        try {
          const buffer = Buffer.alloc(Math.min(info.size, HEAD_BYTES));
          const read = await handle.read(buffer, 0, buffer.length, 0);
          head = buffer.subarray(0, read.bytesRead);
          if (info.size > HEAD_BYTES) {
            tailOffset = Math.max(HEAD_BYTES, info.size - TAIL_BYTES);
            const buffer = Buffer.alloc(info.size - tailOffset);
            const read = await handle.read(buffer, 0, buffer.length, tailOffset);
            tail = buffer.subarray(0, read.bytesRead);
          }
        } finally {
          await handle.close();
        }
        const events = parseLines(head);
        const header = events[0];
        const meta = record(header?.payload);
        const spawn = record(record(record(meta.source).subagent).thread_spawn);
        const actualParent = meta.parent_thread_id ?? spawn.parent_thread_id;
        if (
          header?.type !== "session_meta" ||
          meta.id !== agent.threadId ||
          actualParent !== parentId ||
          (spawn.parent_thread_id !== undefined && spawn.parent_thread_id !== parentId)
        ) {
          if (this.cache.delete(key)) changed = true;
          continue;
        }
        const details: RemoteSubAgent = {
          threadId: agent.threadId,
          parentThreadId: parentId,
          status: "unknown",
          statusSource: "activity",
          ...(text(meta.agent_nickname ?? spawn.agent_nickname, 256)
            ? { name: text(meta.agent_nickname ?? spawn.agent_nickname, 256) }
            : {}),
          ...(text(meta.agent_role ?? spawn.agent_role, 256)
            ? { role: text(meta.agent_role ?? spawn.agent_role, 256) }
            : {}),
          ...(text(meta.agent_path ?? spawn.agent_path, 1000)
            ? { path: text(meta.agent_path ?? spawn.agent_path, 1000) }
            : {}),
        };
        const start =
          typeof meta.subagent_history_start_ordinal === "number"
            ? meta.subagent_history_start_ordinal
            : 0;
        readEvents(events.slice(1), details, start);
        if (tail) {
          // A skipped middle can contain a restart; never reuse its older status/result.
          if (tailOffset > HEAD_BYTES) {
            details.status = "unknown";
            delete details.message;
          }
          readEvents(parseLines(tail, tailOffset), details, start);
        }
        changed ||= JSON.stringify(prior?.details) !== JSON.stringify(details);
        this.cache.set(key, { path: file, size: info.size, mtime: info.mtimeMs, details });
      } catch {
        if (this.cache.delete(key)) changed = true;
      }
    }
    return changed;
  }
}
