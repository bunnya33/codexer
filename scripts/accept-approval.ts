import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readRecentCatalog } from "../packages/codex-adapter/src/catalog.js";
import { savedSettings } from "../packages/codex-adapter/src/headless.js";
import { commandSchema, snapshotSchema } from "../packages/protocol/src/index.js";
import type { CommandResult, DeviceSnapshot, RemoteCommand } from "../packages/protocol/src/index.js";
import { readSecret } from "../packages/shared/src/secrets.js";
import { loginAccount } from "../packages/shared/src/admin-account.js";
import type { AdminAccount } from "../packages/shared/src/admin-account.js";

const { values } = parseArgs({ options: { thread: { type: "string" } } });
if (!values.thread) throw new Error("usage: tsx scripts/accept-approval.ts --thread <test-chat-id>");
const threadId = values.thread;
const catalog = await readRecentCatalog(100);
const entry = catalog.find(thread => thread.id === threadId);
if (!entry) throw new Error("approval-test-session-not-in-catalog");
const settings = await savedSettings({ id: threadId, path: entry.path, modelProvider: "preflight" });
if (settings.sandbox !== "read-only" || settings.approvalPolicy !== "on-request") throw new Error("approval-test-requires-read-only-on-request-session");
const services = JSON.parse(await readFile(resolve(".local/services.json"), "utf8")) as { relayUrl: string; deviceId: string };
const token = await loginAccount(services.relayUrl, await readSecret<AdminAccount>(resolve(".local/local-account.secret")));
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function api(path: string, body?: unknown): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(new URL(path, services.relayUrl), {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    if (response.status === 429 && body === undefined) {
      await new Promise(resolveWait => setTimeout(resolveWait, 1500));
      continue;
    }
    if (!response.ok) throw new Error(`relay-request-failed-${response.status}`);
    return response.json();
  }
  throw new Error("relay-read-rate-limited");
}

async function current(): Promise<DeviceSnapshot> {
  const response = await api(`/v1/devices/${services.deviceId}/snapshot`) as { online: boolean; snapshot: unknown };
  if (!response.online) throw new Error("agent-offline");
  return snapshotSchema.parse(response.snapshot);
}

async function until<T>(operation: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await operation();
    if (result !== null) return result;
    await new Promise(resolveWait => setTimeout(resolveWait, 800));
  }
  throw new Error("approval-acceptance-timeout");
}

async function submit(command: RemoteCommand): Promise<CommandResult> {
  await api(`/v1/devices/${services.deviceId}/commands`, command);
  return until(async () => {
    const response = await api(`/v1/devices/${services.deviceId}/commands/${command.commandId}`) as { status: string; result: CommandResult | null };
    return response.status === "pending" ? null : response.result;
  }, 15000);
}

const before = await current();
const currentThread = before.threads[threadId];
if (before.runtime.kind !== "official-app-server" || !before.runtime.connected || !currentThread || !["idle", "active"].includes(currentThread.status)) throw new Error("headless-test-chat-unavailable");
let turnId = currentThread.activeTurnId;
if (currentThread.status === "idle") {
  const start = commandSchema.parse({ commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: before.epoch,
    expiresAt: Date.now() + 60000, payload: { type: "turn.start", threadId,
      text: "请使用命令执行工具尝试在当前项目的 .local/approval-probe.txt 写入 test。若系统要求审批，请等待；若被拒绝，直接回复已拒绝。不要尝试其他方式。" } });
  const started = await submit(start);
  if (started.status !== "succeeded" || typeof started.result?.turnId !== "string") throw new Error(`approval-start-${started.status}:${started.code}`);
  turnId = started.result.turnId;
}
if (!turnId) throw new Error("approval-turn-id-unavailable");
const pending = await until(async () => {
  const state = await current();
  const request = state.threads[threadId]?.requests.find(item => item.turnId === turnId && item.kind === "commandApproval");
  return request ? { state, request } : null;
}, 45000);
if (!pending.request.respondable) throw new Error("approval-not-respondable");
const available = pending.request.details.availableDecisions;
const decision = Array.isArray(available) && available.includes("decline") ? "decline" : Array.isArray(available) && available.includes("cancel") ? "cancel" : null;
if (!decision) throw new Error("approval-no-safe-rejection-option");
const rejection = commandSchema.parse({ commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: pending.state.epoch,
  expiresAt: Date.now() + 60000, payload: { type: "approval.respond", threadId, turnId, requestId: pending.request.id, decision } });
const rejected = await submit(rejection);
if (rejected.status !== "succeeded") throw new Error(`approval-rejection-${rejected.status}:${rejected.code}`);
const finished = await until(async () => {
  const state = await current();
  const thread = state.threads[threadId];
  const turn = thread?.turns.find(item => item.id === turnId);
  return thread?.status === "idle" && turn?.status !== "inProgress" && turn && !thread.requests.some(item => item.turnId === turnId) ? { thread, turn } : null;
}, 60000);
console.log(JSON.stringify({ type: "approval.acceptance", ok: true, runtime: before.runtime.kind, threadId, turnId,
  requestId: pending.request.id, requestKind: pending.request.kind, decision, finalStatus: finished.turn.status,
  requestCleared: true, responseObserved: finished.turn.items.some(item => item.type === "agentMessage") }));
