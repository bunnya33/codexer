import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandSchema, snapshotSchema } from "../packages/protocol/src/index.js";
import type { CommandResult, DeviceSnapshot, RemoteCommand } from "../packages/protocol/src/index.js";
import { readSecret } from "../packages/shared/src/secrets.js";
import { loginAccount } from "../packages/shared/src/admin-account.js";
import type { AdminAccount } from "../packages/shared/src/admin-account.js";

const { values } = parseArgs({ options: { thread: { type: "string" } } });
if (!values.thread) throw new Error("usage: npm run check:stop -- --thread <test-chat-id>");
const threadId = values.thread;
const services = JSON.parse(await readFile(resolve(".local/services.json"), "utf8")) as { relayUrl: string; deviceId: string };
const token = await loginAccount(services.relayUrl, await readSecret<AdminAccount>(resolve(".local/local-account.secret")));
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, services.relayUrl), {
    method: body === undefined ? "GET" : "POST", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`relay-request-failed-${response.status}`);
  return response.json();
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
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error("stop-acceptance-timeout");
}

async function submit(command: RemoteCommand): Promise<CommandResult> {
  await api(`/v1/devices/${services.deviceId}/commands`, command);
  return until(async () => {
    const response = await api(`/v1/devices/${services.deviceId}/commands/${command.commandId}`) as { status: string; result: CommandResult | null };
    return response.status === "pending" ? null : response.result;
  }, 15000);
}

const before = await current();
const thread = before.threads[threadId];
if (!before.runtime.connected || !thread?.ownerAvailable || thread.status !== "idle") throw new Error("test-chat-not-observed-idle");
const started = commandSchema.parse({ commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: before.epoch,
  expiresAt: Date.now() + 60000, payload: { type: "turn.start", threadId,
    text: "远程 Stop 测试：请执行一条只等待 30 秒、不读写文件的本机命令，然后简短回复测试完成。" } });
const startResult = await submit(started);
if (startResult.status !== "succeeded" || typeof startResult.result?.turnId !== "string") throw new Error(`stop-test-start-${startResult.status}:${startResult.code}`);
const turnId = startResult.result.turnId;
const active = await until(async () => {
  const state = await current();
  return state.threads[threadId]?.activeTurnId === turnId ? state : null;
}, 20000);
const stopped = commandSchema.parse({ commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: active.epoch,
  expiresAt: Date.now() + 60000, payload: { type: "turn.interrupt", threadId, turnId } });
const stopResult = await submit(stopped);
if (stopResult.status !== "succeeded" || stopResult.result?.interruptedTurnId !== turnId) throw new Error(`stop-test-control-${stopResult.status}:${stopResult.code}`);
const finished = await until(async () => {
  const state = await current();
  const updated = state.threads[threadId];
  return updated?.status === "idle" && updated.activeTurnId === null && updated.turns.some(turn => turn.id === turnId && turn.status !== "inProgress") ? updated : null;
}, 30000);
const finalStatus = finished.turns.find(turn => turn.id === turnId)?.status;
if (finalStatus !== "interrupted") throw new Error(`unexpected-final-turn-status:${finalStatus ?? "missing"}`);
console.log(JSON.stringify({ type: "stop.acceptance", ok: true, threadId, turnId,
  interruptedTurnId: stopResult.result.interruptedTurnId, finalStatus,
  targetTurnIsLatest: finished.turns.at(-1)?.id === turnId }));
