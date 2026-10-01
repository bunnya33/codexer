import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyPatches, enablePatches } from "immer";
import type { Patch } from "immer";
import type { TurnStartParams } from "../../codex-generated/src/v2/TurnStartParams.js";
import type { ToolRequestUserInputResponse } from "../../codex-generated/src/v2/ToolRequestUserInputResponse.js";
import type { ModelOption, RemoteCommand, RemoteThread } from "../../protocol/src/index.js";
import { FrameDecoder, encodeFrame } from "./framing.js";
import { normalizeThread, record } from "./normalize.js";
import type { RecordValue } from "./normalize.js";
import { modelOverride, supportsEffort } from "./models.js";
import { ImageRegistry } from "./images.js";
import type { UserInput } from "../../codex-generated/src/v2/UserInput.js";

enablePatches();
const versions: Record<string, number> = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
  "thread-follower-load-complete-history": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-update-thread-settings": 2,
};
type Watched = { ownerId: string; revision: number; raw?: RecordValue; compatible: boolean };
type Waiter = { resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class AdapterError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(code); }
}
export class DesktopAdapter extends EventEmitter {
  readonly endpoint: string;
  readonly watched = new Map<string, Watched>();
  private socket: Socket | null = null;
  private clientId = "initializing-client";
  private pending = new Map<string, Waiter>();
  private reconnectTimer?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private stopped = false;
  connected = false;
  models: ModelOption[] = [];
  images = new ImageRegistry();

  constructor(endpoint?: string) {
    super();
    this.endpoint = endpoint ?? (process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "ipc", "ipc.sock"));
  }
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(): Promise<void> {
    clearTimeout(this.reconnectTimer);
    this.stopped = false;
    const socket = createConnection(this.endpoint);
    this.socket = socket;
    const decoder = new FrameDecoder();
    socket.on("data", chunk => {
      try { for (const value of decoder.push(chunk)) this.handle(record(value)); }
      catch { this.emit("diagnostic", { code: "invalid-ipc-message" }); socket.destroy(); }
    });
    socket.on("error", () => this.emit("diagnostic", { code: "desktop-ipc-unavailable" }));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clientId = "initializing-client";
      this.connected = false;
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new AdapterError("desktop-disconnected", true)); }
      this.pending.clear();
      for (const [id, watched] of this.watched) {
        if (watched.raw) this.emit("thread", this.unavailable(id));
      }
      this.watched.clear();
      this.emit("status", false);
      if (!this.stopped) this.reconnectTimer = setTimeout(() => { void this.connect().catch(() => undefined); }, 2000);
    });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", () => reject(new AdapterError("desktop-ipc-unavailable"))); });
    try {
      const initialized = await this.request("initialize", { clientType: "codex-remote-agent" });
      if (typeof initialized.result.clientId !== "string") throw new AdapterError("incompatible-desktop-initialize");
      if (this.stopped || this.socket !== socket) throw new AdapterError("desktop-disconnected");
      this.clientId = initialized.result.clientId;
      this.connected = true;
      this.emit("status", true);
    } catch (error) { socket.destroy(); throw error; }
  }
  stop(): void {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    for (const [id, watched] of this.watched) this.following(id, watched.ownerId, false);
    this.socket?.destroy();
  }
  async follow(threadId: string): Promise<boolean> {
    if (!this.connected || this.watched.has(threadId)) return this.watched.has(threadId);
    let owner: RecordValue;
    try { owner = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, undefined, 1800); }
    catch { return false; }
    if (!this.connected || this.stopped || typeof owner.handledByClientId !== "string") return false;
    const ownerId = owner.handledByClientId;
    this.watched.set(threadId, { ownerId, revision: -1, compatible: false });
    this.following(threadId, ownerId, true);
    return true;
  }
  unfollow(threadId: string): void {
    const watched = this.watched.get(threadId);
    if (watched) this.following(threadId, watched.ownerId, false);
    this.watched.delete(threadId);
  }
  getThread(threadId: string): RemoteThread | null {
    const entry = this.watched.get(threadId);
    if (!entry?.raw) return null;
    const thread = normalizeThread(entry.raw, entry.revision, this.images);
    return entry.compatible ? thread : { ...thread, ownerAvailable: false, status: "unavailable", activeTurnId: null, requests: [] };
  }
  private unavailable(threadId: string): RemoteThread | null {
    const current = this.getThread(threadId);
    return current ? { ...current, ownerAvailable: false, status: "unavailable", activeTurnId: null, requests: [] } : null;
  }
  private following(threadId: string, ownerId: string, following: boolean): void {
    if (!this.socket?.writable) return;
    this.send({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: this.clientId, targetClientIds: [ownerId], version: 1, params: { conversationId: threadId, hostId: "local", following } });
  }
  private send(message: unknown): void {
    if (!this.socket?.writable) throw new AdapterError("desktop-disconnected");
    if (this.socket.writableLength > 16 * 1024 * 1024) throw new AdapterError("desktop-backpressure");
    this.socket.write(encodeFrame(message));
  }
  private request(method: string, params: unknown, targetClientId?: string, timeoutMs = 5000): Promise<RecordValue & { result: RecordValue }> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new AdapterError("desktop-request-timeout", method.startsWith("thread-follower-") && method !== "thread-follower-load-complete-history")); }, timeoutMs + 100);
      this.pending.set(requestId, { resolve: response => resolve({ ...response, result: record(response.result) }), reject, timer });
      try { this.send({ type: "request", requestId, sourceClientId: this.clientId, targetClientId, method, version: versions[method] ?? 0, params, timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  private handle(message: RecordValue): void {
    if (message.type === "response") {
      const waiter = this.pending.get(String(message.requestId));
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(String(message.requestId));
      message.resultType === "success" ? waiter.resolve(message) : waiter.reject(new AdapterError(message.error === "no-client-found" ? "desktop-owner-unavailable" : "desktop-rejected"));
      return;
    }
    if (message.type === "client-discovery-request") { this.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }); return; }
    if (message.type !== "broadcast") return;
    const params = record(message.params);
    if (message.method === "client-status-changed" && params.status === "disconnected") {
      for (const [id, watched] of this.watched) {
        if (watched.ownerId !== params.clientId) continue;
        this.emit("thread", this.unavailable(id));
        this.watched.delete(id);
      }
      return;
    }
    if (message.method !== "thread-stream-state-changed" || params.hostId !== "local") return;
    const id = String(params.conversationId);
    const watched = this.watched.get(id);
    if (!watched || watched.ownerId !== message.sourceClientId) return;
    if (message.version !== 11) {
      watched.compatible = false;
      this.emit("thread", this.unavailable(id));
      this.emit("diagnostic", { code: "unsupported-desktop-ipc-version" });
      return;
    }
    const change = record(params.change);
    if (change.type === "snapshot") {
      const raw = record(change.conversationState);
      if (raw.id !== id || !Number.isSafeInteger(change.revision) || Number(change.revision) < 0) return;
      watched.raw = raw;
      watched.revision = Number(change.revision);
      watched.compatible = true;
    } else if (change.type === "patches") {
      if (!watched.compatible || !watched.raw || change.baseRevision !== watched.revision || !Number.isSafeInteger(change.revision) || Number(change.revision) <= watched.revision || !Array.isArray(change.patches)) {
        this.resnapshot(id, watched);
        return;
      }
      try {
        watched.raw = applyPatches(watched.raw, change.patches as Patch[]);
        if (watched.raw.id !== id) throw new Error("thread-id-changed");
        watched.revision = Number(change.revision);
      } catch { this.emit("diagnostic", { code: "invalid-desktop-patch" }); this.resnapshot(id, watched); return; }
    } else return;
    const normalized = this.getThread(id);
    if (normalized) this.emit("thread", normalized);
  }
  private resnapshot(id: string, watched: Watched): void {
    watched.compatible = false;
    this.emit("thread", this.unavailable(id));
    this.following(id, watched.ownerId, false);
    this.following(id, watched.ownerId, true);
  }
  async execute(command: RemoteCommand, imageInputs: UserInput[] = []): Promise<RecordValue> {
    const payload = command.payload;
    if (payload.type === "thread.create" || payload.type === "thread.rename" || payload.type === "thread.archive" || payload.type === "thread.delete") throw new AdapterError("unsupported-command");
    const watched = this.watched.get(payload.threadId);
    const normalized = this.getThread(payload.threadId);
    if (!watched?.compatible || !watched.raw || !normalized || !this.connected) throw new AdapterError("desktop-owner-unavailable");
    if (Date.now() >= command.expiresAt) throw new AdapterError("command-expired");
    let method: string;
    let params: unknown;
    if (payload.type === "turn.start") {
      if (normalized.status !== "idle") throw new AdapterError("thread-not-idle");
      if ((payload.images?.length ?? 0) !== imageInputs.length) throw new AdapterError("images-not-ready");
      const turnParams: TurnStartParams = { threadId: payload.threadId, input: [...(payload.text.trim() ? [{ type: "text" as const, text: payload.text, text_elements: [] }] : []), ...imageInputs], clientUserMessageId: command.commandId };
      method = "thread-follower-start-turn";
      params = {
        conversationId: payload.threadId,
        turnStart: {
          request: turnParams,
          context: { attachments: [], commentAttachments: [], mcpAppModelContextAttachments: [], responseItems: [], inheritThreadSettings: true },
        },
      };
    } else if (payload.type === "turn.steer") {
      if (normalized.activeTurnId !== payload.turnId) throw new AdapterError("stale-turn");
      if ((payload.images?.length ?? 0) !== imageInputs.length) throw new AdapterError("images-not-ready");
      const input: UserInput[] = [...(payload.text.trim() ? [{ type: "text", text: payload.text, text_elements: [] } as UserInput] : []), ...imageInputs];
      method = "thread-follower-steer-turn";
      params = { conversationId: payload.threadId, input, clientUserMessageId: command.commandId,
        restoreMessage: { id: command.commandId, text: payload.text, context: { prompt: payload.text, messageThreadId: payload.threadId, turnTrigger: "user", addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: normalized.cwd ? [normalized.cwd] : [] }, cwd: normalized.cwd, createdAt: Date.now() },
        attachments: [], serviceTier: null, additionalContext: null, toolOutput: null };
    } else if (payload.type === "thread.model.update" || payload.type === "thread.effort.update") {
      if (normalized.status !== "idle") throw new AdapterError("thread-not-idle");
      if (normalized.settings?.model !== payload.expectedModel) throw new AdapterError("stale-model");
      if (payload.type === "thread.effort.update" && normalized.settings.reasoningEffort !== payload.expectedEffort) throw new AdapterError("stale-effort");
      if (payload.type === "thread.effort.update" && !supportsEffort(payload.expectedModel, payload.effort, this.models)) throw new AdapterError("unsupported-effort");
      method = "thread-follower-update-thread-settings";
      params = { conversationId: payload.threadId, threadSettings: payload.type === "thread.model.update" ? modelOverride(payload.model, normalized.settings.reasoningEffort, this.models) : { effort: payload.effort },
        condition: { ifModelEquals: payload.expectedModel, ifEffortEquals: normalized.settings.reasoningEffort } };
    } else if (payload.type === "turn.interrupt") {
      if (normalized.activeTurnId !== payload.turnId) throw new AdapterError("stale-turn");
      method = "thread-follower-interrupt-turn";
      params = { conversationId: payload.threadId, mode: "user-stop", expectedTurnId: payload.turnId };
    } else if (payload.type === "approval.respond" || payload.type === "input.respond") {
      if (normalized.activeTurnId !== payload.turnId) throw new AdapterError("stale-turn");
      const requests = Array.isArray(watched.raw.requests) ? watched.raw.requests.map(record) : [];
      const request = requests.find(item => String(item.id) === payload.requestId && record(item.params).turnId === payload.turnId);
      if (!request) throw new AdapterError("stale-request");
      if (!normalized.requests.find(item => item.id === payload.requestId)?.respondable) throw new AdapterError("unsupported-request-kind");
      if (payload.type === "approval.respond") {
        method = request.method === "item/commandExecution/requestApproval" ? "thread-follower-command-approval-decision" : request.method === "item/fileChange/requestApproval" ? "thread-follower-file-approval-decision" : "";
        if (!method) throw new AdapterError("unsupported-request-kind");
        const availableDecisions = record(request.params).availableDecisions;
        if (Array.isArray(availableDecisions) && !availableDecisions.includes(payload.decision)) throw new AdapterError("decision-not-available");
        params = { conversationId: payload.threadId, requestId: request.id, decision: payload.decision };
      } else {
        if (request.method !== "item/tool/requestUserInput") throw new AdapterError("unsupported-request-kind");
        const questions = record(request.params).questions;
        const ids = Array.isArray(questions) ? questions.map(question => String(record(question).id)) : [];
        if (Object.keys(payload.answers).length !== ids.length || ids.some(id => !(id in payload.answers))) throw new AdapterError("invalid-answer-set");
        const response: ToolRequestUserInputResponse = { answers: payload.answers };
        method = "thread-follower-submit-user-input";
        params = { conversationId: payload.threadId, requestId: request.id, response };
      }
    } else throw new AdapterError("unsupported-command");
    const response = await this.request(method, params, watched.ownerId);
    if (response.handledByClientId !== watched.ownerId) throw new AdapterError("desktop-owner-mismatch", true);
    if (payload.type === "thread.model.update" || payload.type === "thread.effort.update") {
      if (response.result.applied === false) throw new AdapterError("stale-model");
      if (response.result.applied !== true) throw new AdapterError("incompatible-desktop-response", true);
      return { ...(payload.type === "thread.model.update" ? { model: payload.model } : { effort: payload.effort }), acknowledgedByDesktop: true };
    }
    if (payload.type === "turn.steer") {
      const steered = record(response.result.result);
      if (typeof steered.turnId !== "string" || steered.turnId !== payload.turnId) throw new AdapterError("incompatible-desktop-response", true);
      return { turnId: steered.turnId, acknowledgedByDesktop: true };
    }
    if (payload.type !== "turn.start" && response.result.ok !== true) throw new AdapterError("incompatible-desktop-response", true);
    if (payload.type === "turn.interrupt" && response.result.interruptedTurnId !== payload.turnId) throw new AdapterError("stale-turn");
    const result = record(response.result.result);
    if (payload.type === "turn.start" && typeof record(result.turn).id !== "string") throw new AdapterError("incompatible-desktop-response", true);
    return { ...(payload.type === "turn.interrupt" ? { interruptedTurnId: response.result.interruptedTurnId, ...(typeof response.result.goalPauseError === "string" ? { goalPauseFailed: true } : {}) } : {}), ...(record(result.turn).id ? { turnId: record(result.turn).id } : {}), acknowledgedByDesktop: true };
  }
  async checkControl(threadId: string): Promise<RecordValue> {
    const watched = this.watched.get(threadId);
    if (!watched) throw new AdapterError("desktop-owner-unavailable");
    const history = await this.request("thread-follower-load-complete-history", { conversationId: threadId }, watched.ownerId);
    if (typeof history.result.revision !== "number") throw new AdapterError("history-control-check-failed");
    const interrupt = await this.request("thread-follower-interrupt-turn", { conversationId: threadId, mode: "user-stop", expectedTurnId: `remote-probe-${randomUUID()}` }, watched.ownerId);
    if (interrupt.result.interruptedTurnId !== null || interrupt.result.ok !== true) throw new AdapterError("stale-interrupt-check-failed");
    return { historyRevision: history.result.revision, staleInterruptIgnored: true };
  }
}
