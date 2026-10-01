import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import { validateRelayUrl } from "../apps/pc-agent/src/auth.js";
import { eventSchema, MAX_MESSAGE_BYTES, reduceEvent, snapshotSchema } from "../packages/protocol/src/index.js";
import type { DeviceSnapshot } from "../packages/protocol/src/index.js";
import { readSecret } from "../packages/shared/src/secrets.js";
import { loginAccount } from "../packages/shared/src/admin-account.js";
import type { AdminAccount } from "../packages/shared/src/admin-account.js";

const { values } = parseArgs({ options: {
  relay: { type: "string" }, device: { type: "string" }, thread: { type: "string", default: process.env.CODEX_THREAD_ID },
  duration: { type: "string", default: "12" }, report: { type: "string", default: ".local/diagnostics/live-evidence.json" },
} });
const duration = Number(values.duration);
if (!Number.isFinite(duration) || duration < 1 || duration > 60) throw new Error("duration-must-be-1-to-60-seconds");
const services = await readFile(resolve(".local/services.json"), "utf8").then(value => JSON.parse(value) as { relayUrl?: string; deviceId?: string }).catch(() => ({} as { relayUrl?: string; deviceId?: string }));
const relayUrl = values.relay ?? services.relayUrl ?? process.env.RELAY_URL ?? "http://127.0.0.1:8787";
validateRelayUrl(relayUrl);
const token = await loginAccount(relayUrl, await readSecret<AdminAccount>(resolve(".local/local-account.secret")));
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, relayUrl), { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`relay-request-failed-${response.status}`);
  return response.json();
}
const devices = await api("/v1/devices") as { devices: { id: string; online: boolean }[] };
const deviceId = values.device ?? services.deviceId ?? (devices.devices.length === 1 ? devices.devices[0]?.id : undefined);
if (!deviceId || !devices.devices.some(device => device.id === deviceId && device.online)) throw new Error("expected-one-online-device: use --device <id>");
const read = await api(`/v1/devices/${deviceId}/snapshot`) as { snapshot: unknown };
let state: DeviceSnapshot = snapshotSchema.parse(read.snapshot);
let failure: Error | undefined;
let socket: WebSocket | undefined;
let ready = 0, snapshots = 0, events = 0;
const syncModes: string[] = [], itemTypes = new Set<string>();
let planObserved = false, diffObserved = false;
const observedStatuses = new Set<string>();
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), relayUrl, deviceId, threadId: values.thread, runtime: "official-desktop-ipc" };
const pause = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(test: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 10000;
  while (!await test()) {
    if (failure) throw failure;
    if (Date.now() >= end) throw new Error("live-check-timeout");
    await pause(100);
  }
}
function observe(): void {
  const threads = values.thread ? [state.threads[values.thread]].filter(value => value !== undefined) : Object.values(state.threads);
  for (const thread of threads) {
    observedStatuses.add(thread.status);
    for (const turn of thread.turns) {
      planObserved ||= turn.plan.length > 0; diffObserved ||= turn.diff.length > 0;
      for (const item of turn.items) itemTypes.add(item.type);
    }
  }
}
async function connect(resume: boolean): Promise<void> {
  const { ticket } = await api("/v1/ws/tickets", {}) as { ticket: string };
  const url = new URL("/v1/ws/client", relayUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url, { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const connection = socket;
  connection.on("error", () => { failure = new Error("live-client-disconnected"); });
  connection.on("open", () => connection.send(JSON.stringify({ type: "client.authenticate", ticket })));
  connection.on("message", bytes => {
    try {
      const message = JSON.parse(bytes.toString()) as Record<string, unknown>;
      if (message.type === "client.authenticated") connection.send(JSON.stringify({ type: "client.subscribe", deviceId, ...(resume ? { epoch: state.epoch, lastSeq: state.lastSeq } : {}) }));
      else if (message.type === "sync.begin") syncModes.push(String(message.mode));
      else if (message.type === "device.snapshot") { state = snapshotSchema.parse(message.snapshot); snapshots++; observe(); }
      else if (message.type === "device.event") { state = reduceEvent(state, eventSchema.parse(message.event)); events++; observe(); }
      else if (message.type === "sync.ready") {
        if (state.epoch !== message.epoch || state.lastSeq !== message.lastSeq) throw new Error("live-reconciliation-failed");
        ready++;
      } else if (message.type === "error") throw new Error(`live-client-${String(message.code)}`);
    } catch (error) { failure = error instanceof Error ? error : new Error("invalid-live-message"); connection.terminate(); }
  });
}
async function disconnect(): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const connection = socket;
  await new Promise<void>(resolveClose => {
    const timer = setTimeout(() => { connection.terminate(); resolveClose(); }, 2000);
    connection.once("close", () => { clearTimeout(timer); resolveClose(); }); connection.close();
  });
}
try {
  await connect(false); await until(() => ready === 1);
  if (!state.runtime.connected || values.thread && !state.threads[values.thread]?.ownerAvailable) throw new Error("official-desktop-thread-unavailable");
  const initialSeq = state.lastSeq;
  await pause(duration * 1000);
  if (failure) throw failure;
  report.liveEvents = events; report.initialSeq = initialSeq; report.lastSeqBeforeReconnect = state.lastSeq;
  const threadId = values.thread ?? Object.values(state.threads).find(thread => thread.ownerAvailable)?.id;
  if (!threadId) throw new Error("no-owned-desktop-thread");
  const command = { commandId: randomUUID(), deviceId, expectedEpoch: state.epoch, expiresAt: Date.now() + 60000,
    payload: { type: "turn.interrupt", threadId, turnId: `remote-live-stale-${randomUUID()}` } };
  await api(`/v1/devices/${deviceId}/commands`, command);
  let outcome: { status?: string; result?: { status?: string; code?: string } } = {};
  await until(async () => {
    outcome = await api(`/v1/devices/${deviceId}/commands/${command.commandId}`) as typeof outcome;
    return outcome.status !== "pending";
  });
  if (outcome.result?.status !== "failed" || outcome.result.code !== "stale-turn") throw new Error("stale-stop-protection-failed");
  const duplicate = await api(`/v1/devices/${deviceId}/commands`, command) as { type?: string; result?: { code?: string } };
  if (duplicate.type !== "command.result" || duplicate.result?.code !== "stale-turn") throw new Error("command-deduplication-failed");
  report.commandRoundTrip = "stale-stop-rejected"; report.duplicateResultReused = true;
  await disconnect(); await pause(2000); await connect(true); await until(() => ready === 2);
  report.ok = !failure && state.runtime.connected && events > 0;
  report.reconnectVerified = true; report.syncModes = syncModes; report.snapshots = snapshots; report.events = events; report.finalSeq = state.lastSeq;
  report.threadCount = Object.keys(state.threads).length; report.observedStatuses = [...observedStatuses]; report.itemTypes = [...itemTypes];
  report.planObserved = planObserved; report.diffObserved = diffObserved;
  if (!report.ok) throw new Error("no-live-events-observed: run while a desktop task is active");
} catch (error) {
  report.ok = false; report.code = error instanceof Error ? error.message : "live-check-failed"; process.exitCode = 1;
} finally {
  await disconnect(); report.completedAt = new Date().toISOString();
  await mkdir(dirname(resolve(values.report)), { recursive: true });
  await writeFile(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ type: "live-check", ...report }));
}
