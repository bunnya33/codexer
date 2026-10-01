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
if (!values.thread) throw new Error("usage: tsx scripts/accept-input.ts --thread <test-chat-id>");
const threadId = values.thread;
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
  throw new Error("input-acceptance-timeout");
}

async function submit(command: RemoteCommand): Promise<CommandResult> {
  await api(`/v1/devices/${services.deviceId}/commands`, command);
  return until(async () => {
    const response = await api(`/v1/devices/${services.deviceId}/commands/${command.commandId}`) as { status: string; result: CommandResult | null };
    return response.status === "pending" ? null : response.result;
  }, 15000);
}

const before = await current();
if (before.runtime.kind !== "official-app-server" || !before.runtime.connected || before.threads[threadId]?.status !== "idle") throw new Error("headless-test-chat-not-idle");
const start = commandSchema.parse({ commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: before.epoch,
  expiresAt: Date.now() + 60000, payload: { type: "turn.start", threadId,
    text: "请先调用 request_user_input，问我在 A 和 B 两个方案中选择哪一个；收到回答后只回复所选字母。不要使用其他工具。" } });
const started = await submit(start);
if (started.status !== "succeeded" || typeof started.result?.turnId !== "string") throw new Error(`input-start-${started.status}:${started.code}`);
const turnId = started.result.turnId;
const pending = await until(async () => {
  const state = await current();
  const request = state.threads[threadId]?.requests.find(item => item.turnId === turnId && item.kind === "userInput");
  return request ? { state, request } : null;
}, 45000);
if (!pending.request.respondable || !Array.isArray(pending.request.details.questions)) throw new Error("input-not-respondable");
const questions = pending.request.details.questions as { id: string }[];
if (!questions.length || questions.some(question => typeof question.id !== "string")) throw new Error("input-questions-invalid");
const answers = Object.fromEntries(questions.map(question => [question.id, { answers: ["A"] }]));
const answer = commandSchema.parse({ commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: pending.state.epoch,
  expiresAt: Date.now() + 60000, payload: { type: "input.respond", threadId, turnId, requestId: pending.request.id, answers } });
const answered = await submit(answer);
if (answered.status !== "succeeded") throw new Error(`input-answer-${answered.status}:${answered.code}`);
const finished = await until(async () => {
  const state = await current();
  const thread = state.threads[threadId];
  const turn = thread?.turns.find(item => item.id === turnId);
  return thread?.status === "idle" && turn?.status !== "inProgress" && turn && !thread.requests.some(item => item.turnId === turnId) ? turn : null;
}, 60000);
if (!finished.items.some(item => item.type === "agentMessage" && item.text?.includes("A"))) throw new Error("input-answer-not-observed");
console.log(JSON.stringify({ type: "input.acceptance", ok: true, runtime: before.runtime.kind, threadId, turnId,
  requestId: pending.request.id, questionCount: questions.length, finalStatus: finished.status, answerObserved: true }));
