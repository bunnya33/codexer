import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { catalogSchema, commandSchema, historyPageSchema, snapshotSchema, tokenBreakdownSchema } from "../packages/protocol/src/index.js";
import type { CommandResult, RemoteCommand, RemoteThread } from "../packages/protocol/src/index.js";
import { record } from "../packages/codex-adapter/src/normalize.js";
import { readSecret } from "../packages/shared/src/secrets.js";
import { loginAccount } from "../packages/shared/src/admin-account.js";
import type { AdminAccount } from "../packages/shared/src/admin-account.js";

const { values } = parseArgs({ options: { thread: { type: "string" }, model: { type: "string" }, "multi-call": { type: "boolean", default: false } } });
if (!values.thread || !values.model) throw new Error("usage: npm run check:model-usage -- --thread <idle-test-chat-id> --model <test-model>");
const threadId = values.thread;
const services = JSON.parse(await readFile(resolve(".local/services.json"), "utf8")) as { relayUrl: string; deviceId: string };
const token = await loginAccount(services.relayUrl, await readSecret<AdminAccount>(resolve(".local/local-account.secret")));
async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, services.relayUrl), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`relay-request-failed-${response.status}`);
  return response.json();
}
async function current() {
  const result = await api(`/v1/devices/${services.deviceId}/snapshot`) as { online: boolean; snapshot: unknown };
  if (!result.online) throw new Error("agent-offline");
  return snapshotSchema.parse(result.snapshot);
}
async function until<T>(operation: () => Promise<T | null>, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await operation(); if (result !== null) return result;
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  }
  throw new Error("model-usage-acceptance-timeout");
}
async function execute(payload: RemoteCommand["payload"]): Promise<CommandResult> {
  const state = await current();
  const command = commandSchema.parse({ commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: state.epoch, expiresAt: Date.now() + 60000, payload });
  await api(`/v1/devices/${services.deviceId}/commands`, command);
  const result = await until(async () => {
    const value = await api(`/v1/devices/${services.deviceId}/commands/${command.commandId}`) as { status: string; result: CommandResult | null };
    return value.status === "pending" ? null : value.result;
  });
  if (result.status !== "succeeded") throw new Error(`command-${result.status}:${result.code}`);
  return result;
}
async function modelIs(model: string): Promise<RemoteThread> {
  return until(async () => {
    const thread = (await current()).threads[threadId];
    return thread?.status === "idle" && thread.settings?.model === model ? thread : null;
  });
}
const before = await current();
const original = before.threads[threadId];
if (!before.runtime.connected || !original?.ownerAvailable || original.status !== "idle" || !original.settings?.model) throw new Error("test-chat-not-observed-idle");
const oldModel = original.settings.model;
if (oldModel === values.model) throw new Error("choose-a-different-test-model");
const catalogResponse = await api(`/v1/devices/${services.deviceId}/catalog`) as { catalog: unknown };
const testModel = catalogSchema.parse(catalogResponse.catalog).models?.find(model => model.model === values.model);
if (!testModel || original.settings.reasoningEffort && !testModel.supportedReasoningEfforts.includes(original.settings.reasoningEffort)) throw new Error("choose-a-listed-test-model-supporting-the-original-effort");
let attempted = false;
try {
  attempted = true;
  await execute({ type: "thread.model.update", threadId, expectedModel: oldModel, model: values.model });
  const changed = await modelIs(values.model);
  if (changed.settings?.modelProvider !== original.settings.modelProvider) throw new Error("provider-changed");
  const baseline = tokenBreakdownSchema.safeParse(record(changed.tokenUsage).total);
  const marker = `MODEL_USAGE_OK_${randomUUID().slice(0,8)}`;
  const commands = before.platform === "win32" ? ["Write-Output 'TOKEN_STEP_1'", "Write-Output 'TOKEN_STEP_2'"] : ["printf 'TOKEN_STEP_1\\n'", "printf 'TOKEN_STEP_2\\n'"];
  const text = values["multi-call"] ? `请分两次单独调用命令执行工具，先执行 ${commands[0]}，得到结果后再执行 ${commands[1]}。仅运行这两条输出文本的命令，不读取或修改文件。最后只回复 ${marker}。` : `请只回复 ${marker}。不要使用工具，不要修改文件。`;
  const result = await execute({ type: "turn.start", threadId, text });
  const turnId = result.result?.turnId;
  if (typeof turnId !== "string") throw new Error("missing-turn-id");
  const final = await until(async () => {
    const thread = (await current()).threads[threadId];
    const turn = thread?.turns.find(value => value.id === turnId);
    return thread?.status === "idle" && turn?.status === "completed" ? { thread, turn } : null;
  }, 90000);
  if (!final.turn.items.some(item => item.type === "agentMessage" && item.text?.includes(marker))) throw new Error("reply-marker-missing");
  const usage = final.turn.tokenUsage;
  if (!usage || usage.state !== "complete") throw new Error("complete-token-usage-missing");
  const last = tokenBreakdownSchema.safeParse(record(final.thread.tokenUsage).last);
  const multipleCallsObserved = last.success && usage.totalTokens > last.data.totalTokens;
  if (values["multi-call"] && !multipleCallsObserved) throw new Error("multiple-model-calls-not-observed");
  if (final.turn.items.some(item => item.type === "fileChange")) throw new Error("unexpected-file-changes");
  if (baseline.success) {
    const total = tokenBreakdownSchema.parse(record(final.thread.tokenUsage).total);
    for (const field of ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"] as const) if (total[field] - baseline.data[field] !== usage[field]) throw new Error(`token-delta-mismatch:${field}`);
  }
  const page = historyPageSchema.parse(await api(`/v1/devices/${services.deviceId}/threads/${threadId}/turns`));
  if (JSON.stringify(page.turns.find(turn => turn.id === turnId)?.tokenUsage) !== JSON.stringify(usage)) throw new Error("history-usage-mismatch");
  console.log(JSON.stringify({ type: "model-usage.acceptance", ok: true, runtime: before.runtime.kind, threadId, oldModel, testModel: values.model, turnId, usage, ...(last.success ? { lastCallUsage: last.data } : {}), multipleCallsObserved, historyUsageMatches: true, providerPreserved: true }));
} finally {
  if (attempted) {
    const thread = (await current()).threads[threadId];
    if (thread?.status === "idle" && thread.settings?.model && thread.settings.model !== oldModel) {
      await execute({ type: "thread.model.update", threadId, expectedModel: thread.settings.model, model: oldModel });
      await modelIs(oldModel);
      console.log(JSON.stringify({ type: "model-usage.restored", model: oldModel }));
    }
  }
}
