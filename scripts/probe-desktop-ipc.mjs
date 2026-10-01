import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    thread: { type: "string", default: process.env.CODEX_THREAD_ID },
    duration: { type: "string", default: "12" },
    pipe: { type: "string" },
    report: { type: "string", default: ".local/desktop-ipc-probe.json" },
    "check-control": { type: "boolean", default: false },
  },
});
if (!values.thread) throw new Error("Pass --thread <existing desktop thread id>");
const endpoint = values.pipe ?? (process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "ipc", "ipc.sock"));
const report = { startedAt: new Date().toISOString(), threadId: values.thread, transport: "official-desktop-ipc", ownerFound: false, snapshotReceived: false, snapshots: 0, patches: 0, versions: {}, diagnostics: [] };
const socket = createConnection(endpoint);
const pending = new Map();
let buffer = Buffer.alloc(0);
let clientId = "initializing-client";
let ownerId;

function send(message) {
  const bytes = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(4 + bytes.length);
  frame.writeUInt32LE(bytes.length, 0);
  bytes.copy(frame, 4);
  socket.write(frame);
}
function request(method, params, version = 0) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Request timed out: ${method}`)); }, 6000);
    pending.set(requestId, { resolve, reject, timer });
    send({ type: "request", requestId, sourceClientId: clientId, targetClientId: method.startsWith("thread-follower-") ? ownerId : undefined, method, version, params, timeoutMs: 5000 });
  });
}
function following(follow) {
  send({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: clientId, targetClientIds: ownerId ? [ownerId] : undefined, version: 1, params: { conversationId: values.thread, hostId: "local", following: follow } });
}
function handle(message) {
  if (message.type === "response") {
    const waiter = pending.get(message.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(message.requestId);
      message.resultType === "success" ? waiter.resolve(message) : waiter.reject(new Error(`IPC ${message.error}`));
    }
  } else if (message.type === "client-discovery-request") {
    send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
  } else if (message.type === "broadcast" && message.method === "thread-stream-state-changed" && message.params?.conversationId === values.thread && message.params.hostId === "local") {
    report.versions[message.method] = message.version;
    const change = message.params.change;
    if (change.type === "snapshot") {
      report.snapshotReceived = true;
      report.snapshots++;
      const state = change.conversationState;
      const history = state.turnHistory;
      const turns = history?.kind === "canonical" ? history.history.islands.flatMap(island => island.entries.map(entry => history.history.entitiesByKey[entry.value])).filter(Boolean) : state.turns ?? [];
      const lastTurn = turns.at(-1);
      report.snapshotSummary = {
        revision: change.revision,
        stateFields: Object.keys(state),
        stateId: state.id,
        turnCount: turns.length,
        lastTurnFields: lastTurn ? Object.keys(lastTurn) : [],
        lastTurnId: lastTurn?.turnId ?? lastTurn?.id,
        lastTurnStatus: lastTurn?.status,
        requestCount: state.requests?.length,
        itemTypes: [...new Set((lastTurn?.items ?? []).map(item => item.type))],
        itemFields: Object.fromEntries((lastTurn?.items ?? []).map(item => [item.type, Object.keys(item)])),
        structures: Object.fromEntries(["canonicalVoiceHistory", "turnHistory", "turnsPagination", "threadRuntimeStatus", "latestThreadSettings"].map(key => {
          const value = state[key];
          return [key, value && typeof value === "object" ? { fields: Object.keys(value), arrays: Object.fromEntries(Object.entries(value).filter(([, item]) => Array.isArray(item)).map(([name, items]) => [name, { count: items.length, firstFields: items[0] && typeof items[0] === "object" ? Object.keys(items[0]) : [], lastFields: items.at(-1) && typeof items.at(-1) === "object" ? Object.keys(items.at(-1)) : [] }])) } : { type: typeof value, value: key === "threadRuntimeStatus" ? value : undefined }];
        })),
        bytes: Buffer.byteLength(JSON.stringify(state)),
      };
      console.log(JSON.stringify({ type: "snapshot", ...report.snapshotSummary }));
    } else if (change.type === "patches") {
      report.patches++;
      if (report.patches <= 5) console.log(JSON.stringify({ type: "patches", revision: change.revision, baseRevision: change.baseRevision, count: change.patches?.length, paths: change.patches?.slice(0, 8).map(patch => patch.path) }));
    }
  }
}
socket.on("data", chunk => {
  try {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > 64 * 1024 * 1024) throw new Error("Invalid IPC frame length");
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      handle(message);
    }
  } catch (error) {
    report.diagnostics.push(error.message);
    socket.destroy();
  }
});
socket.on("error", error => { report.diagnostics.push(error.code ?? "socket-error"); });
socket.on("close", () => {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("IPC connection closed")); }
  pending.clear();
});

try {
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const initialized = await request("initialize", { clientType: "codex-remote-probe" });
  clientId = initialized.result.clientId;
  console.log(JSON.stringify({ type: "initialized", clientId }));
  const owner = await request("thread-owner-discovery", { hostId: "local", conversationId: values.thread }, 1);
  ownerId = owner.handledByClientId;
  report.ownerFound = true;
  report.ownerClientId = ownerId;
  report.supportsUntrustedAppInput = owner.result?.supportsUntrustedAppInput === true;
  console.log(JSON.stringify({ type: "owner", clientId: ownerId, supportsUntrustedAppInput: report.supportsUntrustedAppInput }));
  following(true);
  if (values["check-control"]) {
    const history = await request("thread-follower-load-complete-history", { conversationId: values.thread }, 1);
    const historyResult = history.result?.result ?? history.result;
    report.historyControl = { ok: typeof historyResult?.revision === "number", revision: historyResult?.revision };
    const interrupt = await request("thread-follower-interrupt-turn", { conversationId: values.thread, mode: "user-stop", expectedTurnId: `remote-stale-probe-${randomUUID()}` }, 4);
    report.staleInterrupt = interrupt.result?.result ?? interrupt.result;
    if (report.staleInterrupt?.ok !== true || report.staleInterrupt.interruptedTurnId !== null) throw new Error("Stale interrupt did not return a confirmed no-op");
  }
  await new Promise(resolve => setTimeout(resolve, Number(values.duration) * 1000));
  report.ok = report.ownerFound && report.snapshotReceived && report.patches > 0;
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.ok = false;
  report.diagnostics.push(error.message);
  process.exitCode = 1;
} finally {
  if (socket.writable && ownerId) following(false);
  socket.end();
  socket.destroy();
  report.completedAt = new Date().toISOString();
  await mkdir(dirname(values.report), { recursive: true });
  await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ type: "probe-result", ...report }));
}
