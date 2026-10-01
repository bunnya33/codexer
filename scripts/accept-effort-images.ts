import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandSchema, historyPageSchema, snapshotSchema } from "../packages/protocol/src/index.js";
import type { CommandResult, RemoteCommand } from "../packages/protocol/src/index.js";
import { readSecret } from "../packages/shared/src/secrets.js";
import { loginAccount } from "../packages/shared/src/admin-account.js";
import type { AdminAccount } from "../packages/shared/src/admin-account.js";
import { imageMime } from "../packages/shared/src/images.js";

const { values } = parseArgs({ options: { thread: { type: "string" }, image: { type: "string", default: ".local/image-fixture.png" } } });
if (!values.thread) throw new Error("usage: npm run check:effort-images -- --thread <idle-test-chat-id>");
const threadId = values.thread;
const services = JSON.parse(await readFile(resolve(".local/services.json"), "utf8")) as { relayUrl: string; deviceId: string };
const token = await loginAccount(services.relayUrl, await readSecret<AdminAccount>(resolve(".local/local-account.secret")));
const prefix = `/v1/devices/${services.deviceId}`;
async function api(path: string, body?: unknown) {
  const response = await fetch(new URL(path, services.relayUrl), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`relay-request-failed-${response.status}:${await response.text()}`);
  return response.json();
}
async function current() { return snapshotSchema.parse((await api(`${prefix}/snapshot`)).snapshot); }
async function until<T>(operation: () => Promise<T | null>, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await operation(); if (value !== null) return value; await new Promise(done => setTimeout(done, 400)); }
  throw new Error("effort-image-acceptance-timeout");
}
async function execute(payload: RemoteCommand["payload"]) {
  const state = await current();
  const command = commandSchema.parse({ commandId: randomUUID(), deviceId: services.deviceId, expectedEpoch: state.epoch, expiresAt: Date.now() + 60000, payload });
  await api(`${prefix}/commands`, command);
  const result = await until(async () => {
    const response = await api(`${prefix}/commands/${command.commandId}`);
    return response.status === "pending" ? null : response.result as CommandResult;
  });
  if (result.status !== "succeeded") throw new Error(`command-${result.status}:${result.code}`);
  return result;
}
const original = (await current()).threads[threadId];
if (!original?.ownerAvailable || original.status !== "idle" || !original.settings?.model || !original.settings.reasoningEffort) throw new Error("test-chat-not-observed-idle");
const settings = original.settings;
const model = settings.model!;
type Effort = Extract<RemoteCommand["payload"], { type: "thread.effort.update" }>["effort"];
const models = (await api(`${prefix}/catalog`)).catalog.models as { model: string; supportedReasoningEfforts: string[] }[];
const effort = models.find(model => model.model === settings.model)?.supportedReasoningEfforts.find(effort => effort !== settings.reasoningEffort);
if (!effort) throw new Error("no-alternative-effort");
const report: Record<string, unknown> = { runtime: (await current()).runtime.kind, model: settings.model, initialEffort: settings.reasoningEffort };
try {
  await execute({ type: "thread.effort.update", threadId, expectedModel: model, expectedEffort: settings.reasoningEffort, effort: effort as Effort });
  const changed = await until(async () => { const thread = (await current()).threads[threadId]; return thread?.settings?.reasoningEffort === effort ? thread : null; });
  if (changed.settings?.model !== settings.model || changed.settings.modelProvider !== settings.modelProvider) throw new Error("model-or-provider-changed");
  report.effortChanged = effort; report.providerPreserved = true;
  const bytes = await readFile(resolve(values.image));
  const uploaded = await api(`${prefix}/threads/${threadId}/images`, { name: basename(values.image), mimeType: imageMime(bytes), base64: bytes.toString("base64") });
  const fixturePath = resolve(".local/image-acceptance.txt");
  await writeFile(fixturePath, "old-image-test\n");
  const result = await execute({ type: "turn.start", threadId, text: `请看上传图片，只在最终回复中写出图片中的文字及两种形状和颜色。随后使用文件修改工具，把 ${fixturePath.replaceAll("\\", "/")} 的 old-image-test 改为 IMAGE_TEST_OK。不要读取其他文件或运行命令。`, images: [uploaded.id] });
  const turnId = result.result?.turnId;
  if (typeof turnId !== "string") throw new Error("missing-turn-id");
  const turn = await until(async () => { const thread = (await current()).threads[threadId]; const turn = thread?.turns.find(turn => turn.id === turnId); return thread?.status === "idle" && turn?.status === "completed" ? turn : null; }, 150000);
  const final = turn.items.filter(item => item.type === "agentMessage").map(item => item.text ?? "").join("\n");
  if (!final.includes("IMG-8426") || !/绿|green/i.test(final) || !/红|red/i.test(final)) throw new Error("image-content-not-recognized");
  const page = historyPageSchema.parse(await api(`${prefix}/threads/${threadId}/turns`));
  const history = page.turns.find(turn => turn.id === turnId);
  const image = history?.items.find(item => item.images?.length)?.images?.[0];
  if (!image) throw new Error("history-image-missing");
  const response = await fetch(new URL(`${prefix}/threads/${threadId}/images/${image.id}`, services.relayUrl), { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(bytes)) throw new Error("history-image-download-mismatch");
  if (!(await readFile(fixturePath, "utf8")).includes("IMAGE_TEST_OK") || !history?.fileChanges?.some(change => change.path.includes("image-acceptance.txt") && change.additions > 0 && change.deletions > 0)) throw new Error("file-diff-missing");
  Object.assign(report, { turnId, imageRecognized: true, historyImageMatchesUpload: true, fileDiffRecorded: true, tokenUsageRecorded: Boolean(history.tokenUsage) });
} finally {
  const thread = (await current()).threads[threadId];
  if (thread?.status === "idle" && thread.settings?.model === settings.model && thread.settings.reasoningEffort !== settings.reasoningEffort) {
    await execute({ type: "thread.effort.update", threadId, expectedModel: model, expectedEffort: thread.settings.reasoningEffort, effort: settings.reasoningEffort as Effort });
    await until(async () => (await current()).threads[threadId]?.settings?.reasoningEffort === settings.reasoningEffort ? true : null);
    report.originalEffortRestored = true;
  }
  console.log(JSON.stringify(report));
}
console.log(JSON.stringify({ type: "effort-image.acceptance", ok: true }));
