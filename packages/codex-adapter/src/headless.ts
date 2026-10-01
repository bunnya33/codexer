import { spawn } from "node:child_process";
import { resolveCodexBinary } from "./binary.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { catalogSchema, historyPageSchema } from "../../protocol/src/index.js";
import type { DeviceCatalog, HistoryPage, ModelOption, RemoteCommand, RemoteThread } from "../../protocol/src/index.js";
import { boundHistoryPage, modelSettings, normalizeHistoryTurn, normalizeThread, record, withItemTimings } from "./normalize.js";
import type { RecordValue } from "./normalize.js";
import { AdapterError } from "./desktop.js";
import { modelOverride, normalizeModels, supportsEffort } from "./models.js";
import { ImageRegistry } from "./images.js";
import type { UserInput } from "../../codex-generated/src/v2/UserInput.js";

type RpcWaiter = { method: string; resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type ServerRequest = { id: string | number; method: string; params: RecordValue };
export type SavedSettings = { approvalPolicy: unknown; approvalsReviewer: unknown; sandbox: "read-only" | "workspace-write" | "danger-full-access"; sandboxPolicy: RecordValue; cwd: string; roots: string[]; model: string; modelProvider: string; effort?: string; summary?: string; collaborationMode?: unknown; serviceTier?: string };

export async function savedSettings(thread: RecordValue, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<SavedSettings> {
  if (typeof thread.path !== "string" || typeof thread.id !== "string") throw new AdapterError("headless-settings-unavailable");
  if (!isAbsolute(thread.path) || !thread.path.endsWith(".jsonl")) throw new AdapterError("headless-session-path-invalid");
  let root: string, path: string;
  try {
    root = toNamespacedPath(await realpath(resolve(codexHome, "sessions")));
    path = toNamespacedPath(await realpath(thread.path));
  } catch { throw new AdapterError("headless-settings-unreadable"); }
  const within = relative(root, path);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new AdapterError("headless-session-path-invalid");
  let context: RecordValue | null = null;
  let sessionVerified = false;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const event = record(JSON.parse(line));
      // Forked rollout filenames can contain another ID; session_meta identifies the thread.
      if (!sessionVerified) {
        if (event.type !== "session_meta" || record(event.payload).id !== thread.id) throw new AdapterError("headless-session-path-invalid");
        sessionVerified = true;
      }
      if (event.type === "turn_context") context = record(event.payload);
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("headless-settings-unreadable");
  }
  if (!context) throw new AdapterError("headless-settings-unavailable");
  const policy = record(context.sandbox_policy);
  const sandbox = policy.type;
  if (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") throw new AdapterError("headless-sandbox-unsupported");
  if (typeof context.cwd !== "string" || typeof context.model !== "string" || typeof thread.modelProvider !== "string" || !Array.isArray(context.workspace_roots) || !context.workspace_roots.every(root => typeof root === "string" && isAbsolute(root))) throw new AdapterError("headless-settings-incomplete");
  if (context.approval_policy === undefined || context.approvals_reviewer === undefined) throw new AdapterError("headless-settings-incomplete");
  const model = typeof thread.model === "string" ? thread.model : context.model;
  const effort = typeof thread.reasoningEffort === "string" ? thread.reasoningEffort : context.effort;
  const mode = record(context.collaboration_mode);
  const collaborationMode = context.collaboration_mode ? { ...mode, settings: { ...record(mode.settings), model, ...(typeof effort === "string" ? { reasoning_effort: effort } : {}) } } : undefined;
  return { approvalPolicy: context.approval_policy, approvalsReviewer: context.approvals_reviewer, sandbox, sandboxPolicy: policy, cwd: context.cwd, roots: context.workspace_roots as string[], model, modelProvider: thread.modelProvider,
    ...(typeof effort === "string" ? { effort } : {}), ...(typeof context.summary === "string" ? { summary: context.summary } : {}),
    ...(collaborationMode ? { collaborationMode } : {}), ...(typeof context.service_tier === "string" ? { serviceTier: context.service_tier } : {}) };
}

export function matchesSettings(response: RecordValue, settings: SavedSettings): boolean {
  const sandbox = record(response.sandbox);
  const type = settings.sandbox === "read-only" ? "readOnly" : settings.sandbox === "workspace-write" ? "workspaceWrite" : "dangerFullAccess";
  const samePath = (left: unknown, right: string) => typeof left === "string" && (process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right));
  if (sandbox.type !== type || !isDeepStrictEqual(response.approvalPolicy, settings.approvalPolicy) || response.approvalsReviewer !== settings.approvalsReviewer || response.model !== settings.model || response.modelProvider !== settings.modelProvider || !samePath(response.cwd, settings.cwd)) return false;
  const actualWorkspaceRoots = Array.isArray(response.runtimeWorkspaceRoots) ? response.runtimeWorkspaceRoots : [];
  if (actualWorkspaceRoots.length !== settings.roots.length || settings.roots.some(root => !actualWorkspaceRoots.some(actual => samePath(actual, root)))) return false;
  if (settings.sandbox === "workspace-write") {
    const roots = settings.sandboxPolicy.writable_roots;
    const actualRoots = Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots : [];
    if (Array.isArray(roots) && roots.some(root => !actualRoots.some(actual => samePath(actual, String(root))))) return false;
  }
  return true;
}

async function codexBinary(): Promise<string> {
  return resolveCodexBinary().catch(() => { throw new AdapterError("codex-binary-not-found"); });
}

class AppServerRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, RpcWaiter>();
  private buffer = "";
  private closing = false;
  connected = false;

  async connect(): Promise<void> {
    if (this.connected) return;
    const binary = await codexBinary();
    const child = spawn(binary, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", () => undefined);
    child.on("error", () => this.disconnected(child));
    child.on("close", () => this.disconnected(child));
    try {
      await this.request("initialize", { clientInfo: { name: "codex-remote-agent", title: "Codex Remote Agent", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      this.send({ jsonrpc: "2.0", method: "initialized" });
      this.connected = true;
      this.emit("status", true);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private disconnected(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = null;
    const wasConnected = this.connected;
    this.connected = false;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new AdapterError("app-server-disconnected", true));
    }
    this.pending.clear();
    if (wasConnected && !this.closing) this.emit("status", false);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.child?.kill(); return; }
    for (let newline; (newline = this.buffer.indexOf("\n")) >= 0;) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: RecordValue;
      try { message = record(JSON.parse(line)); } catch { this.child?.kill(); return; }
      if (message.id !== undefined && message.method === undefined) {
        const key = String(message.id);
        const waiter = this.pending.get(key);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        this.pending.delete(key);
        if (message.error) waiter.reject(new AdapterError(`${waiter.method}-rejected:${String(record(message.error).message ?? "unknown")}`));
        else waiter.resolve(record(message.result));
      } else if (typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number")) {
        this.emit("serverRequest", { id: message.id, method: message.method, params: record(message.params) } satisfies ServerRequest);
      } else if (typeof message.method === "string") {
        this.emit("notification", message.method, record(message.params));
      }
    }
  }

  private send(message: unknown): void {
    if (!this.child?.stdin.writable) throw new AdapterError("app-server-disconnected", true);
    if (this.child.stdin.writableLength > 16 * 1024 * 1024) throw new AdapterError("app-server-backpressure", true);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<RecordValue> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AdapterError(`${method}-timeout`, true)); }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id: string | number, result: unknown): void { this.send({ jsonrpc: "2.0", id, result }); }
  reject(id: string | number, message: string): void { this.send({ jsonrpc: "2.0", id, error: { code: -32601, message } }); }

  async stop(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    child.kill();
    await Promise.race([new Promise<void>(resolve => child.once("close", () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 2000))]);
    this.disconnected(child);
  }
}

async function listPages(rpc: AppServerRpc, method: string, params: RecordValue): Promise<RecordValue[]> {
  const values: RecordValue[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
    const page = await rpc.request(method, { ...params, cursor, limit: 100 }, 30000);
    if (!Array.isArray(page.data) || page.data.length > 100 || page.nextCursor !== null && typeof page.nextCursor !== "string") throw new AdapterError("catalog-response-invalid");
    values.push(...page.data.map(record));
    if (values.length > 10000) throw new AdapterError("catalog-too-large");
    cursor = page.nextCursor;
    if (!cursor) return values;
  }
  throw new AdapterError("catalog-page-limit");
}

export async function readOfficialCatalog(deviceId: string): Promise<DeviceCatalog> {
  const rpc = new AppServerRpc();
  try {
    await rpc.connect();
    const rawProjects = await listPages(rpc, "project/list", {});
    const params = { modelProviders: [], sortKey: "updated_at", sortDirection: "desc" };
    const rawThreads: RecordValue[] = [...(await listPages(rpc, "thread/list", { ...params, archived: false })).map(thread => ({ ...thread, archived: false })), ...(await listPages(rpc, "thread/list", { ...params, archived: true })).map(thread => ({ ...thread, archived: true }))];
    const models = await listPages(rpc, "model/list", { includeHidden: false }).then(normalizeModels).catch(() => undefined);
    return { ...normalizeOfficialCatalog(deviceId, rawProjects, rawThreads), ...(models ? { models } : {}) };
  } finally { await rpc.stop(); }
}

export function normalizeOfficialCatalog(deviceId: string, rawProjects: RecordValue[], rawThreads: RecordValue[]): DeviceCatalog {
    const projects = rawProjects.map(project => ({
      id: String(project.id), name: String(project.name ?? "未命名项目").slice(0, 1000),
      roots: (Array.isArray(project.roots) ? project.roots : []).map(value => String(record(value).path ?? "").slice(0, 4096)).filter(Boolean).slice(0, 20),
      position: typeof project.position === "number" ? project.position : 0,
      updatedAt: typeof project.updatedAt === "number" ? project.updatedAt * 1000 : 0,
    }));
    const normalizedPath = (path: string) => {
      const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
      return process.platform === "win32" || /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    const threads = rawThreads.map(thread => {
      const cwd = typeof thread.cwd === "string" ? thread.cwd.slice(0, 4096) : null;
      const path = cwd ? normalizedPath(cwd) : "";
      const projectId = typeof thread.projectId === "string" && projects.some(project => project.id === thread.projectId) ? thread.projectId : projects.flatMap(project => project.roots.map(root => ({ id: project.id, root: normalizedPath(root) }))).filter(candidate => path === candidate.root || path.startsWith(`${candidate.root}/`)).sort((a, b) => b.root.length - a.root.length)[0]?.id ?? null;
      return {
        id: String(thread.id), title: String(thread.name || thread.preview || "未命名会话").slice(0, 1000), cwd, projectId,
        updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : 0,
        archived: thread.archived === true,
        settings: modelSettings(thread),
      };
    });
    const latestThreads = new Map<string, typeof threads[number]>();
    for (const thread of threads) {
      const previous = latestThreads.get(thread.id);
      if (!previous || thread.updatedAt > previous.updatedAt || thread.updatedAt === previous.updatedAt && previous.archived && !thread.archived) latestThreads.set(thread.id, thread);
    }
    return catalogSchema.parse({ protocolVersion: 1, deviceId, generatedAt: Date.now(), projects, threads: [...latestThreads.values()] });
}

export async function readOfficialHistory(threadId: string, cursor: string | null, images?: ImageRegistry): Promise<HistoryPage> {
  const rpc = new AppServerRpc();
  try {
    await rpc.connect();
    return await readHistoryPage(rpc, threadId, cursor, images);
  } finally { await rpc.stop(); }
}

async function listThreadTurns(rpc: AppServerRpc, threadId: string, params: RecordValue, newlyCreated = false): Promise<RecordValue> {
  try { return await rpc.request("thread/turns/list", { threadId, ...params }, 30000); }
  catch (error) {
    // Only this app-server owns an empty new thread; it has no persisted turns yet.
    if (newlyCreated && error instanceof AdapterError && error.code.includes("is not materialized yet")) return { data: [], nextCursor: null };
    throw error;
  }
}

async function readHistoryPage(rpc: AppServerRpc, threadId: string, cursor: string | null, images?: ImageRegistry, newlyCreated = false): Promise<HistoryPage> {
  const result = await listThreadTurns(rpc, threadId, { cursor, limit: 5, sortDirection: "desc", itemsView: "full" }, newlyCreated);
  if (!Array.isArray(result.data) || result.data.length > 5 || result.nextCursor !== null && typeof result.nextCursor !== "string") throw new AdapterError("history-response-invalid");
  const timedTurns = await Promise.all(result.data.map(value => readTurnItemTimings(rpc, threadId, record(value), false)));
  const page: HistoryPage = { threadId, turns: timedTurns.map(turn => normalizeHistoryTurn(turn, images, threadId)), nextCursor: result.nextCursor, generatedAt: Date.now() };
  return historyPageSchema.parse(boundHistoryPage(page));
}

async function readTurnItemTimings(rpc: AppServerRpc, threadId: string, turn: RecordValue, recent: boolean): Promise<RecordValue> {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const missing = new Set((recent ? items.slice(-20) : items.slice(-80)).map(value => String(record(value).id)));
  const preceding = recent ? items.slice(0, -20).reverse().find(value => ["userMessage", "steeringUserMessage", "agentMessage"].includes(String(record(value).type))) : undefined;
  if (preceding) missing.add(String(record(preceding).id));
  let cursor: string | null = null;
  let timed = turn;
  // Join by item ID: lifecycle entries can order concurrent commands differently.
  for (let pageNumber = 0; missing.size && pageNumber < 2; pageNumber++) {
    try {
      const page = await rpc.request("thread/items/list", { threadId, turnId: turn.id, cursor, limit: 100, sortDirection: recent ? "desc" : "asc" }, 5000);
      if (!Array.isArray(page.data) || page.data.length > 100 || page.nextCursor !== null && typeof page.nextCursor !== "string") break;
      const entries = page.data.filter(value => record(value).turnId === turn.id);
      timed = withItemTimings(timed, entries);
      for (const value of entries) missing.delete(String(record(record(value).item).id));
      cursor = page.nextCursor;
      if (!cursor) break;
    } catch { break; }
  }
  return timed;
}

export class HeadlessAdapter extends EventEmitter {
  models: ModelOption[] = [];
  images = new ImageRegistry();
  private settings = new Map<string, RecordValue>();
  private newThreads = new Map<string, RecordValue>();
  readonly watched = new Map<string, RemoteThread>();
  private rpc: AppServerRpc | null = null;
  private requests = new Map<string, ServerRequest>();
  private busyTurns = new Set<string>();
  private completedTurns = new Set<string>();
  private pendingStarts = 0;
  private plans = new Map<string, unknown>();
  private diffs = new Map<string, string>();
  private usage = new Map<string, RecordValue>();
  private refreshing = new Map<string, Promise<boolean>>();
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  private pollTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private stopped = false;
  connected = false;

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this.open().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async open(): Promise<void> {
    const rpc = new AppServerRpc();
    this.rpc = rpc;
    rpc.on("status", (connected: boolean) => {
      if (this.rpc !== rpc || this.stopped) return;
      this.connected = connected;
      if (!connected) {
        for (const thread of this.watched.values()) this.emit("thread", { ...thread, status: "unavailable", ownerAvailable: false, activeTurnId: null, requests: [] });
        this.watched.clear();
        this.requests.clear();
        this.settings.clear();
        this.newThreads.clear();
        this.usage.clear();
        this.busyTurns.clear();
        this.completedTurns.clear();
        this.pendingStarts = 0;
      }
      this.emit("status", connected);
    });
    rpc.on("serverRequest", (request: ServerRequest) => {
      if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"].includes(request.method)) {
        rpc.reject(request.id, "interactive-request-not-supported-by-headless-agent");
        return;
      }
      this.requests.set(String(request.id), request);
      this.scheduleRefresh(String(request.params.threadId));
    });
    rpc.on("notification", (method: string, params: RecordValue) => {
      const threadId = typeof params.threadId === "string" ? params.threadId : null;
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      if (!threadId) return;
      if (method === "turn/started" && typeof record(params.turn).id === "string") this.emit("turnStarted", { threadId, turnId: record(params.turn).id, model: this.watched.get(threadId)?.settings?.model });
      if (method === "turn/completed") {
        const completedId = record(params.turn).id;
        if (typeof completedId === "string") {
          if (!this.busyTurns.delete(completedId)) this.completedTurns.add(completedId);
          for (const [id, request] of this.requests) if (request.params.turnId === completedId) this.requests.delete(id);
          this.emit("turnCompleted", { threadId, turnId: completedId });
        }
      }
      if (method === "turn/plan/updated" && turnId) this.plans.set(turnId, params.plan);
      if (method === "turn/diff/updated" && turnId && typeof params.diff === "string") this.diffs.set(turnId, params.diff);
      if (method === "thread/settings/updated") this.settings.set(threadId, record(params.threadSettings));
      if (method === "thread/tokenUsage/updated") {
        this.usage.set(threadId, record(params.tokenUsage));
        if (turnId) this.emit("tokenUsage", { threadId, turnId, tokenUsage: params.tokenUsage });
      }
      this.scheduleRefresh(threadId);
    });
    await rpc.connect();
    this.pollTimer = setInterval(() => {
      for (const [id, thread] of this.watched) if (thread.status === "active") void this.follow(id);
    }, 2000);
    this.pollTimer.unref();
  }

  private scheduleRefresh(threadId: string): void {
    if (!this.watched.has(threadId) || this.refreshTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(threadId);
      void this.follow(threadId);
    }, 250);
    this.refreshTimers.set(threadId, timer);
  }

  follow(threadId: string): Promise<boolean> {
    if (!this.connected || !this.rpc) return Promise.resolve(false);
    const existing = this.refreshing.get(threadId);
    if (existing) return existing;
    const refresh = this.refresh(threadId).finally(() => { this.refreshing.delete(threadId); });
    this.refreshing.set(threadId, refresh);
    return refresh;
  }

  private async refresh(threadId: string): Promise<boolean> {
    const rpc = this.rpc;
    if (!rpc) return false;
    try {
      const read = await rpc.request("thread/read", { threadId, includeTurns: false }, 15000);
      const source = record(read.thread);
      if (source.id !== threadId) return false;
      const page = await listThreadTurns(rpc, threadId, { limit: 2, sortDirection: "desc", itemsView: "full" }, this.newThreads.has(threadId));
      const timedTurns = Array.isArray(page.data) ? await Promise.all(page.data.map(value => readTurnItemTimings(rpc, threadId, record(value), true))) : [];
      const turns = [...timedTurns].reverse().map(value => {
        const turn = record(value);
        const id = String(turn.id ?? "");
        return { ...turn, turnId: id, ...(this.plans.has(id) ? { plan: this.plans.get(id) } : {}), ...(this.diffs.has(id) ? { diff: this.diffs.get(id) } : {}) };
      });
      const pending = [...this.requests.values()].filter(request => request.params.threadId === threadId).map(request => ({ id: String(request.id), method: request.method, params: request.params }));
      const status = record(source.status);
      const prior = this.watched.get(threadId);
      const normalized = normalizeThread({ ...source, id: threadId, title: source.name || source.preview || "未命名会话", latestThreadSettings: this.settings.get(threadId), cwd: source.cwd, updatedAt: typeof source.updatedAt === "number" ? source.updatedAt * 1000 : Date.now(), threadRuntimeStatus: status.type === "notLoaded" ? { type: "idle" } : status, turns, requests: pending, latestTokenUsageInfo: this.usage.get(threadId) }, (prior?.revision ?? -1) + 1, this.images);
      if (!prior || JSON.stringify({ ...prior, revision: 0 }) !== JSON.stringify({ ...normalized, revision: 0 })) {
        this.watched.set(threadId, normalized);
        this.emit("thread", normalized);
      }
      return true;
    } catch {
      return false;
    }
  }

  unfollow(threadId: string): void {
    this.watched.delete(threadId);
    const timer = this.refreshTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(threadId);
  }

  getThread(threadId: string): RemoteThread | null { return this.watched.get(threadId) ?? null; }
  hasActiveTurn(): boolean { return this.pendingStarts > 0 || this.busyTurns.size > 0 || [...this.watched.values()].some(thread => thread.status === "active"); }

  async history(threadId: string, cursor: string | null): Promise<HistoryPage> {
    if (!this.connected || !this.rpc) throw new AdapterError("app-server-disconnected");
    return readHistoryPage(this.rpc, threadId, cursor, this.images, this.newThreads.has(threadId));
  }

  async manage(payload: Extract<RemoteCommand['payload'], { type: 'thread.create' | 'thread.rename' | 'thread.archive' | 'thread.delete' }>, roots?: string[]): Promise<RecordValue> {
    if (!this.connected || !this.rpc) throw new AdapterError("app-server-disconnected");
    if (payload.type === 'thread.create') {
      if (!roots?.length || roots.some(root => !isAbsolute(root))) throw new AdapterError("project-root-unavailable");
      const result = await this.rpc.request('thread/start', { projectId: payload.projectId, cwd: roots[0], runtimeWorkspaceRoots: roots }, 30000);
      const threadId = record(result.thread).id;
      if (typeof threadId !== 'string') throw new AdapterError('incompatible-app-server-response', true);
      this.newThreads.set(threadId, result);
      const source = record(result.thread);
      this.watched.set(threadId, normalizeThread({ ...source, model: result.model, reasoningEffort: result.reasoningEffort,
        title: source.name || source.preview || "未命名会话", updatedAt: typeof source.updatedAt === "number" ? source.updatedAt * 1000 : Date.now(),
        threadRuntimeStatus: { type: "idle" }, turns: [] }, 0, this.images));
      return { threadId, acknowledgedByAppServer: true };
    }
    await this.rpc.request(payload.type === 'thread.rename' ? 'thread/name/set' : payload.type === 'thread.archive' ? 'thread/archive' : 'thread/delete',
      payload.type === 'thread.rename' ? { threadId: payload.threadId, name: payload.name } : { threadId: payload.threadId }, 30000);
    if (payload.type !== 'thread.rename') { this.unfollow(payload.threadId); this.newThreads.delete(payload.threadId); }
    return { threadId: payload.threadId, acknowledgedByAppServer: true };
  }

  async execute(command: RemoteCommand, imageInputs: UserInput[] = []): Promise<RecordValue> {
    const rpc = this.rpc;
    if (!rpc || !this.connected) throw new AdapterError("app-server-disconnected");
    const payload = command.payload;
    if (payload.type === 'thread.create' || payload.type === 'thread.rename' || payload.type === 'thread.archive' || payload.type === 'thread.delete') throw new AdapterError('unsupported-command');
    if (Date.now() >= command.expiresAt) throw new AdapterError("command-expired");
    await this.follow(payload.threadId);
    const thread = this.watched.get(payload.threadId);
    if (!thread?.ownerAvailable) throw new AdapterError("headless-thread-unavailable");
    if (payload.type === "thread.model.update" || payload.type === "thread.effort.update") {
      if (thread.status !== "idle") throw new AdapterError("thread-not-idle");
      if (thread.settings?.model !== payload.expectedModel) throw new AdapterError("stale-model");
      const settings = await this.resumeWithSettings(payload.threadId);
      if (settings.model !== payload.expectedModel) throw new AdapterError("stale-model");
      if (payload.type === "thread.effort.update" && (thread.settings.reasoningEffort !== payload.expectedEffort || (settings.effort ?? null) !== payload.expectedEffort)) throw new AdapterError("stale-effort");
      if (payload.type === "thread.effort.update" && !supportsEffort(payload.expectedModel, payload.effort, this.models)) throw new AdapterError("unsupported-effort");
      const model = payload.type === "thread.model.update" ? payload.model : settings.model;
      const override = payload.type === "thread.model.update" ? modelOverride(model, settings.effort, this.models) : { effort: payload.effort };
      const mode = record(settings.collaborationMode);
      const collaborationMode = settings.collaborationMode ? { ...mode, settings: { ...record(mode.settings), model, ...(override.effort ? { reasoning_effort: override.effort } : {}) } } : undefined;
      await rpc.request("thread/settings/update", { threadId: payload.threadId, ...override, ...(collaborationMode ? { collaborationMode } : {}) });
      this.settings.set(payload.threadId, { ...record(this.settings.get(payload.threadId)), model, ...(override.effort ? { effort: override.effort } : {}), ...(collaborationMode ? { collaborationMode } : {}) });
      await this.follow(payload.threadId);
      return { ...(payload.type === "thread.model.update" ? { model } : { effort: payload.effort }), acknowledgedByAppServer: true };
    }
    if (payload.type === "turn.start") {
      if (thread.status !== "idle") throw new AdapterError("thread-not-idle");
      if ((payload.images?.length ?? 0) !== imageInputs.length) throw new AdapterError("images-not-ready");
      const settings = await this.resumeWithSettings(payload.threadId);
      this.pendingStarts++;
      let started: RecordValue;
      try { started = await rpc.request("turn/start", { threadId: payload.threadId, input: [...(payload.text.trim() ? [{ type: "text", text: payload.text, text_elements: [] }] : []), ...imageInputs], clientUserMessageId: command.commandId,
        ...(settings.effort ? { effort: settings.effort } : {}), ...(settings.summary ? { summary: settings.summary } : {}), ...(settings.collaborationMode ? { collaborationMode: settings.collaborationMode } : {}) }, 30000); }
      finally { this.pendingStarts = Math.max(0, this.pendingStarts - 1); }
      const turnId = record(started.turn).id;
      if (typeof turnId !== "string") throw new AdapterError("incompatible-app-server-response", true);
      this.newThreads.delete(payload.threadId);
      if (!this.completedTurns.delete(turnId)) this.busyTurns.add(turnId);
      this.scheduleRefresh(payload.threadId);
      return { turnId, acknowledgedByAppServer: true };
    }
    if (payload.type === "turn.steer") {
      if (thread.activeTurnId !== payload.turnId) throw new AdapterError("stale-turn");
      if ((payload.images?.length ?? 0) !== imageInputs.length) throw new AdapterError("images-not-ready");
      const steered = await rpc.request("turn/steer", { threadId: payload.threadId, expectedTurnId: payload.turnId, clientUserMessageId: command.commandId,
        input: [...(payload.text.trim() ? [{ type: "text", text: payload.text, text_elements: [] }] : []), ...imageInputs] }, 30000);
      const turnId = steered.turnId;
      if (turnId !== payload.turnId) throw new AdapterError("incompatible-app-server-response", true);
      this.scheduleRefresh(payload.threadId);
      return { turnId, acknowledgedByAppServer: true };
    }
    if (payload.type !== "turn.interrupt" && payload.type !== "approval.respond" && payload.type !== "input.respond") throw new AdapterError("unsupported-command");
    if (thread.activeTurnId !== payload.turnId) throw new AdapterError("stale-turn");
    if (payload.type === "turn.interrupt") {
      await rpc.request("turn/interrupt", { threadId: payload.threadId, turnId: payload.turnId });
      this.scheduleRefresh(payload.threadId);
      return { interruptedTurnId: payload.turnId, acknowledgedByAppServer: true };
    }
    if (payload.type !== "approval.respond" && payload.type !== "input.respond") throw new AdapterError("unsupported-command");
    const request = this.requests.get(payload.requestId);
    if (!request || request.params.threadId !== payload.threadId || request.params.turnId !== payload.turnId) throw new AdapterError("stale-request");
    if (payload.type === "approval.respond") {
      if (request.method !== "item/commandExecution/requestApproval" && request.method !== "item/fileChange/requestApproval") throw new AdapterError("unsupported-request-kind");
      if (Array.isArray(request.params.availableDecisions) && !request.params.availableDecisions.includes(payload.decision)) throw new AdapterError("decision-not-available");
      rpc.respond(request.id, { decision: payload.decision });
    } else {
      if (request.method !== "item/tool/requestUserInput") throw new AdapterError("unsupported-request-kind");
      const questions = Array.isArray(request.params.questions) ? request.params.questions.map(value => String(record(value).id)) : [];
      if (Object.keys(payload.answers).length !== questions.length || questions.some(id => !(id in payload.answers))) throw new AdapterError("invalid-answer-set");
      rpc.respond(request.id, { answers: payload.answers });
    }
    this.requests.delete(payload.requestId);
    this.scheduleRefresh(payload.threadId);
    return { acknowledgedByAppServer: true };
  }

  private async resumeWithSettings(threadId: string): Promise<Pick<SavedSettings, "model" | "effort" | "summary" | "collaborationMode">> {
    const created = this.newThreads.get(threadId);
    if (created) {
      // The creation response already configured this loaded thread. There is no
      // saved turn context to resume until its first user message is accepted.
      const settings = this.watched.get(threadId)?.settings;
      const effort = settings?.reasoningEffort ?? created.reasoningEffort;
      return { model: settings?.model ?? String(created.model), ...(typeof effort === "string" ? { effort } : {}) };
    }
    const rpc = this.rpc!;
    const metadata = await rpc.request("thread/read", { threadId, includeTurns: false });
    const latest = this.settings.get(threadId);
    const settings = await savedSettings({ ...record(metadata.thread), ...(typeof latest?.model === "string" ? { model: latest.model } : {}), ...(typeof latest?.effort === "string" ? { reasoningEffort: latest.effort } : {}) });
    if (latest?.collaborationMode) settings.collaborationMode = latest.collaborationMode;
    const resumed = await rpc.request("thread/resume", { threadId, excludeTurns: true, approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, sandbox: settings.sandbox, cwd: settings.cwd, runtimeWorkspaceRoots: settings.roots, model: settings.model, modelProvider: settings.modelProvider, ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}) }, 30000);
    if (!matchesSettings(resumed, settings)) throw new AdapterError("headless-settings-mismatch");
    return settings;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    this.watched.clear();
    this.requests.clear();
    this.settings.clear();
    this.newThreads.clear();
    this.busyTurns.clear();
    this.completedTurns.clear();
    this.pendingStarts = 0;
    this.connected = false;
    await this.rpc?.stop();
    this.rpc = null;
  }
}
