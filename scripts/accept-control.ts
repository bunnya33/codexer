import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandSchema, snapshotSchema } from "../packages/protocol/src/index.js";
import type { CommandResult, DeviceSnapshot } from "../packages/protocol/src/index.js";
import { readSecret } from "../packages/shared/src/secrets.js";
import { loginAccount } from "../packages/shared/src/admin-account.js";
import type { AdminAccount } from "../packages/shared/src/admin-account.js";

const { values } = parseArgs({ options: { thread: { type: "string" } } });
if (!values.thread) throw new Error("usage: npm run check:control -- --thread <test-chat-id>");
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
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  }
  throw new Error("control-acceptance-timeout");
}

const before = await current();
const thread = before.threads[threadId];
if (!before.runtime.connected || !thread?.ownerAvailable || thread.status !== "idle") throw new Error("test-chat-not-observed-idle");
const previousTurnId = thread.turns.at(-1)?.id;
const marker = `REMOTE_CONTROL_OK_${randomUUID().slice(0, 8)}`;
const command = commandSchema.parse({
  commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: before.epoch,
  expiresAt: Date.now() + 60000,
  payload: { type: "turn.start", threadId, text: `请只回复 ${marker}。不要使用工具，不要修改文件。` },
});
await api(`/v1/devices/${services.deviceId}/commands`, command);
const result = await until(async () => {
  const response = await api(`/v1/devices/${services.deviceId}/commands/${command.commandId}`) as { status: string; result: CommandResult | null };
  return response.status === "pending" ? null : response.result;
}, 15000);
if (result.status !== "succeeded") throw new Error(`runtime-control-${result.status}:${result.code}`);
const turnId = typeof result.result?.turnId === "string" ? result.result.turnId : null;
if (!turnId) throw new Error("runtime-acknowledged-without-turn-id");

const observed = await until(async () => {
  const state = await current();
  const updated = state.threads[threadId];
  if (!updated || updated.status !== "idle") return null;
  const turn = updated.turns.find(item => item.id === turnId);
  if (!turn || turn.id === previousTurnId || turn.status === "inProgress") return null;
  return { state, turn };
}, 90000);
const markerSeen = observed.turn.items.some(item => item.type === "agentMessage" && item.text?.includes(marker));
if (!markerSeen) throw new Error("reply-marker-not-seen-in-relay-preview");
console.log(JSON.stringify({
  type: "control.acceptance", ok: true, threadId, commandId: command.commandId,
  turnId, finalStatus: observed.turn.status, runtime: before.runtime.kind, acknowledgement: result.code,
  officialReplyObservedThroughRelay: markerSeen, noToolItems: observed.turn.items.every(item => item.type !== "commandExecution" && item.type !== "fileChange"),
  epoch: observed.state.epoch, seq: observed.state.lastSeq,
}));
