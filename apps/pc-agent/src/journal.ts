import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandResult, RemoteCommand } from "../../../packages/protocol/src/index.js";

function key(deviceId: string, commandId: string): string { return JSON.stringify([deviceId, commandId]); }
export type QueuedMessage = { id: string; threadId: string; text: string; images: string[]; createdAt: number; status: "queued" | "sending" | "failed" };

export class CommandJournal {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS commands (key TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT)");
    this.db.exec("CREATE TABLE IF NOT EXISTS queued_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL, images TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL)");
    this.db.exec("UPDATE commands SET state='unknown' WHERE state='pending'");
    this.db.exec("UPDATE queued_messages SET status='failed' WHERE status='sending'");
  }
  lookup(command: RemoteCommand): CommandResult | null {
    const row = this.db.prepare("SELECT hash,state,result FROM commands WHERE key=?").get(key(command.deviceId, command.commandId));
    if (!row) return null;
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    if (row.hash !== digest) return { commandId: command.commandId, deviceId: command.deviceId, status: "failed", code: "command-id-reused" };
    if (typeof row.result === "string") return JSON.parse(row.result) as CommandResult;
    return { commandId: command.commandId, deviceId: command.deviceId, status: "unknown", code: "agent-outcome-unconfirmed" };
  }
  begin(command: RemoteCommand): void {
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    this.db.prepare("INSERT INTO commands(key,hash,state) VALUES(?,?,'pending')").run(key(command.deviceId, command.commandId), digest);
  }
  finish(result: CommandResult): void {
    this.db.prepare("UPDATE commands SET state=?,result=? WHERE key=?").run(result.status, JSON.stringify(result), key(result.deviceId, result.commandId));
  }
  queued(threadId: string): QueuedMessage[] {
    return this.db.prepare("SELECT id,thread_id,text,images,created_at,status FROM queued_messages WHERE thread_id=? ORDER BY created_at,id").all(threadId).map(row => ({
      id: String(row.id), threadId: String(row.thread_id), text: String(row.text), images: JSON.parse(String(row.images)) as string[], createdAt: Number(row.created_at), status: row.status as QueuedMessage["status"],
    }));
  }
  enqueue(message: QueuedMessage): void {
    this.db.prepare("INSERT INTO queued_messages(id,thread_id,text,images,created_at,status) VALUES(?,?,?,?,?,?)").run(message.id, message.threadId, message.text, JSON.stringify(message.images), message.createdAt, message.status);
  }
  queueStatus(id: string, status: QueuedMessage["status"]): void { this.db.prepare("UPDATE queued_messages SET status=? WHERE id=?").run(status, id); }
  removeQueued(id: string): void { this.db.prepare("DELETE FROM queued_messages WHERE id=?").run(id); }
  close(): void { this.db.close(); }
}
