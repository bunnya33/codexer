import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DesktopAdapter, AdapterError } from "../../../packages/codex-adapter/src/desktop.js";
import { HeadlessAdapter, readOfficialCatalog, readOfficialHistory } from "../../../packages/codex-adapter/src/headless.js";
import { readRecentCatalog } from "../../../packages/codex-adapter/src/catalog.js";
import { commandSchema, historyRequestSchema, MAX_MESSAGE_BYTES, MAX_THREADS, PROTOCOL_VERSION, reduceEvent, threadSchema } from "../../../packages/protocol/src/index.js";
import type { DeviceCatalog, DeviceSnapshot, HistoryPage, RemoteCommand, RemoteEvent, RemoteThread } from "../../../packages/protocol/src/index.js";
import { SerialQueue } from "../../../packages/shared/src/queue.js";
import { CommandJournal } from "./journal.js";
import type { QueuedMessage } from "./journal.js";
import { UsageJournal } from "./usage.js";
import { validateRelayUrl } from "./auth.js";
import { ImageRegistry } from "../../../packages/codex-adapter/src/images.js";
import { imageRequestSchema } from "../../../packages/protocol/src/index.js";
import { decodeImage } from "../../../packages/shared/src/images.js";
import type { UserInput } from "../../../packages/codex-generated/src/v2/UserInput.js";
import type { AgentCredentials } from "./auth.js";

export class PcAgent extends EventEmitter {
  readonly adapter: DesktopAdapter;
  private readonly headless?: HeadlessAdapter;
  private activeAdapter: DesktopAdapter | HeadlessAdapter;
  private readonly journal: CommandJournal;
  private readonly usageJournal: UsageJournal;
  private readonly commandQueue = new SerialQueue();
  private readonly historyQueue = new SerialQueue();
  private readonly imageQueue = new SerialQueue();
  private readonly images = new ImageRegistry();
  private readonly switchQueue = new SerialQueue();
  private socket: WebSocket | null = null;
  private state: DeviceSnapshot;
  private pendingThreads = new Map<string, RemoteThread>();
  private desiredThreads = new Set<string>();
  private readonly pinnedThreads = new Map<string, number>();
  private readonly headlessThreads = new Set<string>();
  private readonly drainingQueues = new Set<string>();
  private readonly awaitingQueuedTurn = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private scanTimer?: NodeJS.Timeout;
  private catalogTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = false;
  private reconnectAttempt = 0;
  private relayError: string | null = null;
  private scanning = false;
  private statusWriting = false;
  private catalogReading = false;
  private catalog: DeviceCatalog | null = null;
  private readonly createdThreads = new Map<string, DeviceCatalog["threads"][number]>();
  private catalogSupported = false;
  private relayAllowed = true;
  private remotePaused = false;
  private remoteOperations = 0;

  constructor(private readonly credentials: AgentCredentials, private readonly directory: string, private readonly seedThreads: string[] = [], endpoint?: string, private readonly codexHome?: string, private readonly runtimePreference: "auto" | "desktop" | "headless" = "auto", private readonly catalogReader: { list: (deviceId: string) => Promise<DeviceCatalog>; history: (threadId: string, cursor: string | null, images?: ImageRegistry) => Promise<HistoryPage> } = { list: readOfficialCatalog, history: readOfficialHistory }) {
    super();
    validateRelayUrl(credentials.relayUrl);
    this.adapter = new DesktopAdapter(endpoint);
    this.headless = runtimePreference !== "desktop" && (!endpoint || runtimePreference === "headless") ? new HeadlessAdapter() : undefined;
    this.activeAdapter = this.adapter;
    this.adapter.images = this.images;
    if (this.headless) this.headless.images = this.images;
    this.journal = new CommandJournal(join(directory, "commands.sqlite"));
    this.usageJournal = new UsageJournal(join(directory, "usage.sqlite"));
    if (!["win32", "linux", "darwin"].includes(process.platform)) throw new Error("unsupported-platform");
    this.state = { protocolVersion: PROTOCOL_VERSION, deviceId: credentials.deviceId, epoch: randomUUID(), lastSeq: 0, generatedAt: Date.now(), hostname: hostname(), platform: process.platform as DeviceSnapshot["platform"], runtime: { kind: "official-desktop-ipc", connected: false, experimental: true, capabilities: { observe: true, startTurn: true, interrupt: true, approvals: true, userInput: true, modelUpdate: true, effortUpdate: true, collaborationModeUpdate: true, images: true } }, threads: {} };
    const onThread = (source: DesktopAdapter | HeadlessAdapter, thread: RemoteThread | null) => {
      if (!thread) return;
      if (source !== this.adapterForThread(thread.id)) return;
      if (!this.desiredThreads.has(thread.id) || this.stopped) return;
      if (source === this.adapter) this.usageJournal.observeDesktop(thread);
      else if (!thread.ownerAvailable) this.usageJournal.gap(thread.id);
      const parsed = threadSchema.safeParse(this.withQueue(this.usageJournal.enrichThread(thread)));
      if (!parsed.success) { this.log("incompatible-runtime-state"); return; }
      this.pendingThreads.set(thread.id, parsed.data);
      void this.writeStatus();
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 400);
      if (parsed.data.status === "active") this.awaitingQueuedTurn.delete(thread.id);
      if (parsed.data.status === "idle" && parsed.data.ownerAvailable) void this.drainQueue(thread.id);
      if (source === this.headless && !this.headlessThreads.has(thread.id) && this.adapter.connected && !this.headless.hasActiveTurn()) void this.selectRuntime();
    };
    this.adapter.on("thread", (thread: RemoteThread | null) => onThread(this.adapter, thread));
    this.headless?.on("thread", (thread: RemoteThread | null) => onThread(this.headless!, thread));
    this.headless?.on("turnStarted", (event: { threadId: string; turnId: string; model?: string }) => {
      if (this.adapterForThread(event.threadId) === this.headless) this.usageJournal.startTurn(event.threadId, event.turnId, event.model);
    });
    this.headless?.on("turnCompleted", (event: { threadId: string; turnId: string }) => {
      if (this.adapterForThread(event.threadId) === this.headless) this.usageJournal.finishTurn(event.threadId, event.turnId);
    });
    this.headless?.on("tokenUsage", (event: { threadId: string; turnId: string; tokenUsage: unknown }) => {
      if (this.adapterForThread(event.threadId) === this.headless) this.usageJournal.observeNotification(event.threadId, event.turnId, event.tokenUsage);
    });
    this.adapter.on("status", (connected: boolean) => {
      if (this.stopped) return;
      if (!connected && this.activeAdapter === this.adapter) this.usageJournal.gap();
      if (this.activeAdapter === this.adapter && !connected) this.commit({ type: "runtime.status", connected: false });
      void this.selectRuntime();
    });
    this.headless?.on("status", (connected: boolean) => {
      if (this.stopped || this.activeAdapter !== this.headless) return;
      if (!connected) this.usageJournal.gap();
      this.commit({ type: "runtime.status", connected });
      if (!connected) setTimeout(() => { if (!this.stopped) void this.selectRuntime(); }, 2000).unref();
    });
    this.adapter.on("diagnostic", (event: { code: string }) => this.log(event.code));
  }
  snapshot(): DeviceSnapshot { return this.state; }
  private adapterForThread(threadId: string): DesktopAdapter | HeadlessAdapter { return this.headlessThreads.has(threadId) && this.headless ? this.headless : this.activeAdapter; }
  private log(code: string): void { this.emit("diagnostic", { code }); console.log(JSON.stringify({ type: "agent.diagnostic", code })); }
  status() {
    return { relayConnected: !this.remotePaused && this.socket?.readyState === WebSocket.OPEN, paused: this.remotePaused, sessionValid: this.relayAllowed, relayError: this.relayError,
      desktopConnected: this.adapter.connected, runtime: this.state.runtime.kind, runtimeConnected: this.state.runtime.connected,
      activeTasks: Math.max(this.remoteOperations, this.headless?.hasActiveTurn() ? 1 : 0, Object.values({ ...this.state.threads, ...Object.fromEntries(this.pendingThreads) }).filter(thread => thread.status === "active").length),
      threads: Object.values(this.state.threads).length, updatedAt: Date.now() };
  }
  /** Pause only the remote channel. Local adapters and already-running turns stay alive. */
  disconnect(): void {
    this.remotePaused = true;
    clearTimeout(this.reconnectTimer); clearInterval(this.heartbeatTimer);
    const socket = this.socket; this.socket = null;
    socket?.close(1000, "user-disconnected");
    void this.writeStatus();
  }
  reconnect(): void {
    if (this.stopped || !this.relayAllowed) return;
    this.disconnect(); this.remotePaused = false; this.relayError = null; this.reconnectAttempt = 0;
    this.connectRelay();
  }
  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.runtimePreference !== "headless") await this.adapter.connect().catch(() => undefined);
    await this.selectRuntime();
    this.connectRelay();
    await this.scan();
    this.scanTimer = setInterval(() => { void this.selectRuntime(); void this.scan(); }, 15000);
    void this.refreshCatalog();
    this.catalogTimer = setInterval(() => { void this.refreshCatalog(); }, 60000);
    this.log("agent-started");
  }
  private selectRuntime(): Promise<void> {
    return this.switchQueue.run(async () => {
      if (this.stopped) return;
      if (this.adapter.connected && this.runtimePreference !== "headless") {
        if (this.headlessThreads.size && !this.headless?.connected) await this.headless?.connect().catch(() => this.log("headless-app-server-unavailable"));
        if (this.activeAdapter === this.headless && this.headless.hasActiveTurn()) return;
        if (this.activeAdapter !== this.adapter) {
          this.usageJournal.gap();
          if (!this.headlessThreads.size) await this.headless?.stop();
          this.activeAdapter = this.adapter;
          for (const thread of Object.values(this.state.threads)) if (!this.headlessThreads.has(thread.id)) this.commit({ type: "thread.updated", thread: { ...thread, ownerAvailable: false, status: "unavailable", activeTurnId: null, requests: [] } });
        }
        if (!this.state.runtime.connected || this.state.runtime.kind !== "official-desktop-ipc") this.commit({ type: "runtime.status", connected: true, kind: "official-desktop-ipc" });
        await this.scan();
        return;
      }
      if (!this.headless) return;
      await this.headless.connect().catch(() => { this.log("headless-app-server-unavailable"); });
      if (!this.headless.connected) return;
      if (this.activeAdapter !== this.headless) {
        this.usageJournal.gap();
        this.activeAdapter = this.headless;
        this.pendingThreads.clear();
      }
      if (!this.state.runtime.connected || this.state.runtime.kind !== "official-app-server") this.commit({ type: "runtime.status", connected: true, kind: "official-app-server" });
      await this.scan();
    });
  }
  private async scan(): Promise<void> {
    const adapter = this.activeAdapter;
    if (this.scanning || this.stopped || !adapter.connected) return;
    this.scanning = true;
    try {
      const catalog = await readRecentCatalog(MAX_THREADS, this.codexHome);
      if (adapter !== this.activeAdapter) return;
      const ids = [...new Set([...this.pinnedThreads.keys()].reverse().concat(this.seedThreads, catalog.map(thread => thread.id)))].slice(0, MAX_THREADS);
      this.desiredThreads = new Set(ids);
      for (const id of adapter.watched.keys()) if (!this.desiredThreads.has(id)) { this.usageJournal.gap(id); adapter.unfollow(id); }
      for (const id of this.headlessThreads) if (!this.desiredThreads.has(id)) { this.headless?.unfollow(id); this.headlessThreads.delete(id); }
      for (const id of this.pendingThreads.keys()) if (!this.desiredThreads.has(id)) this.pendingThreads.delete(id);
      for (const id of Object.keys(this.state.threads)) if (!this.desiredThreads.has(id)) this.commit({ type: "thread.removed", threadId: id });
      for (let offset = 0; offset < ids.length; offset += 4) await Promise.all(ids.slice(offset, offset + 4).map(id => this.adapterForThread(id).follow(id)));
    } catch { this.log("catalog-refresh-failed"); }
    finally { this.scanning = false; }
  }
  private async refreshCatalog(): Promise<void> {
    if (this.catalogReading || this.stopped) return;
    this.catalogReading = true;
    try {
      const catalog = await this.catalogReader.list(this.credentials.deviceId);
      if (this.stopped) return;
      for (const thread of catalog.threads) this.createdThreads.delete(thread.id);
      this.publishCatalog({ ...catalog, threads: [...this.createdThreads.values(), ...catalog.threads] });
    } catch { this.log("catalog-refresh-failed"); }
    finally { this.catalogReading = false; }
  }
  private publishCatalog(catalog: DeviceCatalog): void {
    const previous = this.catalog;
    this.catalog = catalog;
    this.adapter.models = catalog.models ?? [];
    if (this.headless) this.headless.models = catalog.models ?? [];
    if (this.catalogSupported && (!previous || JSON.stringify([previous.projects, previous.threads, previous.models]) !== JSON.stringify([catalog.projects, catalog.threads, catalog.models]))) this.send({ type: "device.catalog", catalog });
  }
  private pinThread(threadId: string): void {
    this.pinnedThreads.delete(threadId);
    this.pinnedThreads.set(threadId, Date.now());
    if (this.pinnedThreads.size > 8) this.pinnedThreads.delete(this.pinnedThreads.keys().next().value!);
  }
  private async watchThread(threadId: string): Promise<void> {
    if (!this.catalog?.threads.some(thread => thread.id === threadId)) throw new AdapterError("thread-not-in-catalog");
    this.pinThread(threadId);
    this.desiredThreads.add(threadId);
    const owner = this.adapterForThread(threadId);
    const followed = await owner.follow(threadId);
    if (followed && owner === this.adapter && !owner.getThread(threadId)) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!followed || owner === this.adapter && !owner.getThread(threadId)?.ownerAvailable) {
      if (!this.headless || this.runtimePreference === "desktop") throw new AdapterError("thread-owner-unavailable");
      await this.headless.connect();
      if (!await this.headless.follow(threadId)) throw new AdapterError("thread-owner-unavailable");
      this.headlessThreads.add(threadId);
    }
    if (this.activeAdapter === this.headless) this.headlessThreads.add(threadId);
    const observed = this.adapterForThread(threadId).getThread(threadId);
    if (observed) this.commit({ type: "thread.updated", thread: threadSchema.parse(this.withQueue(this.usageJournal.enrichThread(observed))) });
    void this.scan();
  }
  private async manageThread(payload: Extract<RemoteCommand['payload'], { type: 'thread.create' | 'thread.rename' | 'thread.archive' | 'thread.delete' }>, allowed = () => !this.remotePaused && this.relayAllowed): Promise<Record<string, unknown>> {
    if (!this.headless) throw new AdapterError('app-server-unavailable');
    const project = payload.type === 'thread.create' ? this.catalog?.projects.find(item => item.id === payload.projectId) : undefined;
    if (payload.type === 'thread.create' && !project?.roots[0]) throw new AdapterError('project-root-unavailable');
    if (payload.type !== 'thread.create' && !this.catalog?.threads.some(item => item.id === payload.threadId)) throw new AdapterError('thread-not-in-catalog');
    await this.headless.connect();
    if (!allowed()) throw new AdapterError("remote-disconnected");
    const value = await this.headless.manage(payload, project?.roots);
    if (payload.type === 'thread.create' && typeof value.threadId === 'string') {
      const thread = this.headless.getThread(value.threadId);
      if (!thread || !this.catalog) throw new AdapterError('incompatible-app-server-response', true);
      const entry = { id: thread.id, title: thread.title, cwd: thread.cwd, projectId: project!.id, updatedAt: thread.updatedAt, archived: false, settings: thread.settings };
      this.createdThreads.set(thread.id, entry);
      this.headlessThreads.add(thread.id);
      this.pinThread(thread.id);
      // Publish before acknowledging creation: thread/list omits empty threads.
      this.publishCatalog({ ...this.catalog, generatedAt: Date.now(), threads: [entry, ...this.catalog.threads.filter(item => item.id !== thread.id)] });
    }
    if (payload.type === 'thread.rename') {
      const created = this.createdThreads.get(payload.threadId);
      if (created) {
        this.createdThreads.set(payload.threadId, { ...created, title: payload.name, updatedAt: Date.now() });
        if (this.catalog) this.publishCatalog({ ...this.catalog, generatedAt: Date.now(), threads: this.catalog.threads.map(thread => thread.id === payload.threadId ? this.createdThreads.get(payload.threadId)! : thread) });
      }
    }
    if (payload.type === 'thread.archive' || payload.type === 'thread.delete') {
      this.createdThreads.delete(payload.threadId);
      this.pinnedThreads.delete(payload.threadId);
      this.desiredThreads.delete(payload.threadId);
      this.headlessThreads.delete(payload.threadId);
      this.adapter.unfollow(payload.threadId);
      this.commit({ type: 'thread.removed', threadId: payload.threadId });
    }
    await this.refreshCatalog();
    if (payload.type === 'thread.create') await this.scan();
    return value;
  }
  private withQueue(thread: RemoteThread): RemoteThread {
    return { ...thread, queuedMessages: this.journal.queued(thread.id).slice(0, 20).map(message => ({ id: message.id, text: message.text.slice(0, 1000), imageCount: message.images.length, createdAt: message.createdAt, status: message.status })) };
  }
  private publishQueue(threadId: string): void {
    const thread = this.pendingThreads.get(threadId) ?? this.state.threads[threadId] ?? this.adapterForThread(threadId).getThread(threadId);
    if (thread) this.commit({ type: "thread.updated", thread: this.withQueue(thread) });
  }
  private async imageInputs(threadId: string, ids: string[]): Promise<UserInput[]> {
    const inputs: UserInput[] = [];
    for (const id of ids) {
      const url = new URL(`/v1/agent/${encodeURIComponent(this.credentials.deviceId)}/threads/${encodeURIComponent(threadId)}/images/${id}`, this.credentials.relayUrl);
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.credentials.session}` }, signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!response.ok) throw new AdapterError("images-not-ready");
      const { image, bytes } = decodeImage(await response.json());
      const path = join(this.directory, "images", `${id}.${image.mimeType.split("/")[1]}`);
      await mkdir(join(this.directory, "images"), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { mode: 0o600 });
      inputs.push({ type: "localImage", path });
    }
    return inputs;
  }
  private async drainQueue(threadId: string): Promise<void> {
    if (this.drainingQueues.has(threadId) || this.awaitingQueuedTurn.has(threadId) || this.stopped || this.remotePaused || !this.relayAllowed) return;
    const queued = this.journal.queued(threadId).find(message => message.status === "queued");
    if (!queued) return;
    this.drainingQueues.add(threadId);
    try {
      await this.switchQueue.run(async () => {
        if (this.remotePaused || !this.relayAllowed || this.stopped) return;
        const adapter = this.adapterForThread(threadId);
        const thread = adapter.getThread(threadId);
        if (!thread?.ownerAvailable || thread.status !== "idle") return;
        this.journal.queueStatus(queued.id, "sending");
        this.publishQueue(threadId);
        this.awaitingQueuedTurn.add(threadId);
        try {
          const command: RemoteCommand = { commandId: queued.id, deviceId: this.credentials.deviceId, expectedEpoch: this.state.epoch, expiresAt: Date.now() + 60000,
            payload: { type: "turn.start", threadId, text: queued.text, images: queued.images } };
          const inputs = await this.imageInputs(threadId, queued.images);
          if (this.remotePaused || !this.relayAllowed || this.stopped) { this.journal.queueStatus(queued.id, "queued"); this.awaitingQueuedTurn.delete(threadId); return; }
          await adapter.execute(command, inputs);
          this.journal.removeQueued(queued.id);
        } catch (error) {
          this.awaitingQueuedTurn.delete(threadId);
          if (error instanceof AdapterError && !error.uncertain) this.journal.queueStatus(queued.id, "failed");
          this.log("queued-turn-unconfirmed");
        }
        this.publishQueue(threadId);
      });
    } finally { this.drainingQueues.delete(threadId); }
  }
  private async queueCommand(command: RemoteCommand, allowed = () => !this.remotePaused && this.relayAllowed): Promise<Record<string, unknown>> {
    const payload = command.payload;
    if (payload.type !== 'turn.queue' && payload.type !== 'turn.queue.steer' && payload.type !== 'turn.queue.remove') throw new AdapterError('unsupported-command');
    const thread = this.adapterForThread(payload.threadId).getThread(payload.threadId);
    if (!thread?.ownerAvailable) throw new AdapterError("thread-owner-unavailable");
    if (payload.type === "turn.queue") {
      if (thread.status !== "active") throw new AdapterError("thread-not-active");
      if (this.journal.queued(payload.threadId).length >= 20) throw new AdapterError("queue-full");
      const message: QueuedMessage = { id: command.commandId, threadId: payload.threadId, text: payload.text, images: payload.images ?? [], createdAt: Date.now(), status: "queued" };
      this.journal.enqueue(message);
      this.publishQueue(payload.threadId);
      return { queueId: message.id };
    }
    if (payload.type === "turn.queue.remove") {
      const message = this.journal.queued(payload.threadId).find(value => value.id === payload.queueId);
      if (!message || message.status === "sending") throw new AdapterError("queue-item-unavailable");
      this.journal.removeQueued(message.id);
      this.publishQueue(payload.threadId);
      return { queueId: message.id };
    }
    if (payload.type === "turn.queue.steer") {
      const message = this.journal.queued(payload.threadId).find(value => value.id === payload.queueId && value.status === "queued");
      if (!message) throw new AdapterError("queue-item-unavailable");
      if (thread.activeTurnId !== payload.turnId) throw new AdapterError("stale-turn");
      this.journal.queueStatus(message.id, "sending");
      this.publishQueue(payload.threadId);
      try {
        const steer: RemoteCommand = { ...command, commandId: message.id, payload: { type: "turn.steer", threadId: payload.threadId, turnId: payload.turnId, text: message.text, images: message.images } };
        const result = await this.switchQueue.run(async () => {
          const inputs = await this.imageInputs(payload.threadId, message.images);
          if (!allowed()) throw new AdapterError("remote-disconnected");
          return this.adapterForThread(payload.threadId).execute(steer, inputs);
        });
        this.journal.removeQueued(message.id);
        this.publishQueue(payload.threadId);
        return { ...result, queueId: message.id };
      } catch (error) {
        if (error instanceof AdapterError && !error.uncertain) this.journal.queueStatus(message.id, "failed");
        this.publishQueue(payload.threadId);
        throw error;
      }
    }
    throw new AdapterError("unsupported-command");
  }
  private flush(): void {
    this.flushTimer = undefined;
    const threads = [...this.pendingThreads.values()];
    this.pendingThreads.clear();
    for (const thread of threads) this.commit({ type: "thread.updated", thread });
  }
  private commit(change: RemoteEvent["change"]): void {
    const event: RemoteEvent = { protocolVersion: PROTOCOL_VERSION, deviceId: this.state.deviceId, epoch: this.state.epoch, seq: this.state.lastSeq + 1, timestamp: Date.now(), change };
    this.state = reduceEvent(this.state, event);
    this.send({ type: "device.event", event });
    void this.writeStatus();
  }
  private send(message: unknown): void {
    if (this.remotePaused || this.socket?.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify(message);
    if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES || this.socket.bufferedAmount > 16 * 1024 * 1024) { this.log("relay-backpressure"); this.socket.close(1013, "backpressure"); return; }
    this.socket.send(json);
  }
  private connectRelay(): void {
    if (this.stopped || this.remotePaused || !this.relayAllowed || this.socket) return;
    this.catalogSupported = false;
    const url = new URL("/v1/ws/device", this.credentials.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.credentials.session}`, "x-device-id": this.credentials.deviceId }, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
    this.socket = socket;
    let openedAt = 0;
    const current = () => !this.stopped && !this.remotePaused && this.socket === socket;
    socket.on("open", () => {
      if (!current()) { socket.close(); return; }
      openedAt = Date.now();
      this.send({ type: "device.snapshot", snapshot: this.state });
      void this.writeStatus();
      let lastPong = Date.now();
      socket.on("pong", () => { lastPong = Date.now(); });
      this.heartbeatTimer = setInterval(() => {
        if (Date.now() - lastPong > 45000) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 15000);
      this.heartbeatTimer.unref();
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if (!current()) { socket.terminate(); return; }
      if (response.statusCode === 401) { this.relayAllowed = false; this.log("account-session-expired-login-again"); }
      socket.terminate();
    });
    socket.on("error", () => { if (current() && this.relayAllowed) this.log("relay-unavailable"); });
    socket.on("message", bytes => {
      if (!current()) return;
      let message: { type?: string; command?: unknown; requestId?: unknown; threadId?: unknown; cursor?: unknown; features?: unknown };
      try { message = JSON.parse(bytes.toString()) as typeof message; } catch { socket.close(1008, "invalid-message"); return; }
      if (message.type === "device.welcome") {
        this.relayError = null;
        this.log("relay-connected");
        void this.writeStatus();
        this.catalogSupported = Array.isArray(message.features) && message.features.includes("catalog");
        if (this.catalogSupported && this.catalog) this.send({ type: "device.catalog", catalog: this.catalog });
        for (const thread of Object.values(this.state.threads)) if (thread.status === "idle") void this.drainQueue(thread.id);
        return;
      }
      if (message.type === "device.resync") { this.send({ type: "device.snapshot", snapshot: this.state }); return; }
      if (message.type === "history.request") {
        const request = historyRequestSchema.safeParse(message);
        if (!request.success) { socket.close(1008, "invalid-history-request"); return; }
        void this.historyQueue.run(async () => {
          if (!current()) return;
          const { requestId, threadId, cursor } = request.data;
          if (!this.catalog?.threads.some(thread => thread.id === threadId)) {
            this.send({ type: "device.history", requestId, threadId, page: null, code: "thread-not-in-catalog" });
            return;
          }
          try {
            const page = this.usageJournal.enrichHistory(await (this.headlessThreads.has(threadId) && this.headless
              ? this.headless.history(threadId, cursor)
              : this.catalogReader.history(threadId, cursor, this.images)));
            if (current()) this.send({ type: "device.history", requestId, threadId, page, code: null });
          } catch {
            if (current()) this.send({ type: "device.history", requestId, threadId, page: null, code: "history-unavailable" });
          }
        }).catch(() => this.log("history-read-failed"));
        return;
      }
      if (message.type === "image.request") {
        const request = imageRequestSchema.safeParse(message);
        if (!request.success) { socket.close(1008, "invalid-image-request"); return; }
        void this.imageQueue.run(async () => {
          if (!current()) return;
          const { requestId, threadId, imageId } = request.data;
          const image = this.catalog?.threads.some(thread => thread.id === threadId) ? await this.images.read(threadId, imageId).catch(() => null) : null;
          if (current()) this.send({ type: "device.image", requestId, threadId, imageId, image });
        }).catch(() => this.log("image-read-failed"));
        return;
      }
      if (message.type !== "command") return;
      const parsed = commandSchema.safeParse(message.command);
      if (!parsed.success || parsed.data.deviceId !== this.state.deviceId) { socket.close(1008, "invalid-command"); return; }
      const command = parsed.data;
      void this.commandQueue.run(async () => {
        if (!current()) return;
        this.remoteOperations++; void this.writeStatus();
        try {
        let result = this.journal.lookup(command);
        if (!result) {
          this.journal.begin(command);
          try {
            if (command.expectedEpoch !== this.state.epoch) throw new AdapterError("stale-device-epoch");
            if (Date.now() >= command.expiresAt) throw new AdapterError("command-expired");
            const value = command.payload.type === 'thread.create' || command.payload.type === 'thread.rename' || command.payload.type === 'thread.archive' || command.payload.type === 'thread.delete'
              ? await this.manageThread(command.payload, current)
              : command.payload.type === "thread.watch"
              ? await this.watchThread(command.payload.threadId).then(() => ({ watched: true }))
              : command.payload.type === "turn.queue" || command.payload.type === "turn.queue.steer" || command.payload.type === "turn.queue.remove"
                ? await this.queueCommand(command, current)
                : await this.switchQueue.run(async () => {
                  if (!current()) throw new AdapterError("remote-disconnected");
                  const payload = command.payload;
                  if (!('threadId' in payload)) throw new AdapterError('unsupported-command');
                  const inputs = await this.imageInputs(payload.threadId, payload.type === "turn.start" || payload.type === "turn.steer" ? payload.images ?? [] : []);
                  if (!current()) throw new AdapterError("remote-disconnected");
                  return this.adapterForThread(payload.threadId).execute(command, inputs);
                });
            result = { commandId: command.commandId, deviceId: command.deviceId, status: "succeeded", code: command.payload.type === "thread.watch" ? "thread-watched" : command.payload.type.startsWith("turn.queue") ? "queue-updated" : "acknowledgedByAppServer" in value ? "app-server-acknowledged" : "desktop-acknowledged", result: value };
          } catch (error) {
            result = { commandId: command.commandId, deviceId: command.deviceId, status: error instanceof AdapterError && !error.uncertain ? "failed" : "unknown", code: error instanceof AdapterError ? error.code : "agent-execution-unconfirmed" };
          }
          this.journal.finish(result);
        }
        if (current()) this.send({ type: "command.result", result });
        } finally { this.remoteOperations--; void this.writeStatus(); }
      }).catch(() => this.log("command-journal-failed"));
    });
    socket.on("close", (code, bytes) => {
      if (this.socket !== socket) return;
      clearInterval(this.heartbeatTimer);
      this.socket = null;
      if (code === 4001 || code === 4003) {
        this.relayAllowed = false;
        this.log(code === 4001 ? "agent-connection-replaced" : "account-session-ended-login-again");
      } else if (!this.stopped && !this.remotePaused && [1002, 1003, 1007, 1008, 1009].includes(code)) {
        // Policy/protocol rejection will not recover by replaying the same state.
        // Keep credentials and local tasks; allow an explicit reconnect after repair.
        const reason = bytes.toString();
        const allowed = ['invalid-message', 'invalid-device-state', 'device-mismatch', 'stale-snapshot', 'invalid-history-request', 'invalid-image-request', 'invalid-command'];
        this.relayError = allowed.includes(reason) ? `relay-rejected-${reason}` : 'relay-rejected-policy';
        this.remotePaused = true;
        this.log(this.relayError);
      } else if (!this.stopped) {
        if (code === 1011 && bytes.toString() === 'storage-error') { this.relayError = 'relay-storage-error'; this.log(this.relayError); }
        else this.log(`relay-disconnected-${code}`);
      }
      void this.writeStatus();
      if (!this.stopped && !this.remotePaused && this.relayAllowed) {
        // A successful handshake followed by immediate failure is not a recovered connection.
        if (openedAt && Date.now() - openedAt >= 30000) this.reconnectAttempt = 0;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(5, this.reconnectAttempt++)) + Math.random() * 500;
        this.reconnectTimer = setTimeout(() => this.connectRelay(), delay);
      }
    });
  }
  private async writeStatus(): Promise<void> {
    this.emit("status", this.status());
    if (this.statusWriting) return;
    this.statusWriting = true;
    try {
      const status = { deviceId: this.state.deviceId, epoch: this.state.epoch, lastSeq: this.state.lastSeq, relayConnected: this.socket?.readyState === WebSocket.OPEN, desktopConnected: this.adapter.connected, runtime: this.state.runtime.kind, runtimeConnected: this.state.runtime.connected, threads: Object.values(this.state.threads).map(thread => ({ id: thread.id, status: thread.status, activeTurnId: thread.activeTurnId, requests: thread.requests.length })), updatedAt: new Date().toISOString() };
      await writeFile(join(this.directory, "status.json"), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    } catch { this.log("status-write-failed"); }
    finally { this.statusWriting = false; }
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.flushTimer); clearTimeout(this.scanTimer); clearTimeout(this.catalogTimer); clearTimeout(this.reconnectTimer); clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, "agent-stopping");
    this.adapter.stop();
    await this.headless?.stop();
    await this.commandQueue.run(async () => undefined);
    await this.historyQueue.run(async () => undefined);
    await this.imageQueue.run(async () => undefined);
    this.usageJournal.gap();
    this.usageJournal.close();
    this.journal.close();
  }
}
