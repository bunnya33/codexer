import { clearCredentials as clearSavedCredentials, randomId, readCredentials, saveCredentials } from './runtime';
import { catalogSchema, eventSchema, historyPageSchema, imageRefSchema, MAX_IMAGE_BYTES, reduceEvent, snapshotSchema } from '../../../packages/protocol/src/index';
import type { CommandResult, DeviceCatalog, DeviceSnapshot, HistoryTurn, ImageRef, RemoteCommand } from '../../../packages/protocol/src/index';
import { mergeLiveTurn } from '../../../packages/client-shared/src/activity';

export type Device = { id: string; name: string; platform: string; online: boolean; owner_user_id?: string | null; last_seen_at?: number | string | null };
export type HistoryState = { turns: HistoryTurn[]; nextCursor: string | null; loading: boolean; error?: string };
export type RelayView = {
  phase: 'locked' | 'connecting' | 'connected' | 'reconnecting';
  url: string;
  role: 'admin' | 'user' | null;
  devices: Device[];
  catalogs: Record<string, DeviceCatalog>;
  snapshots: Record<string, DeviceSnapshot>;
  histories: Record<string, HistoryState>;
  syncing: Record<string, boolean>;
  notice: string;
};

const emptyView = (): RelayView => ({ phase: 'locked', url: '', role: null, devices: [], catalogs: {}, snapshots: {}, histories: {}, syncing: {}, notice: '' });
export const historyKey = (deviceId: string, threadId: string) => `${deviceId}:${threadId}`;

export function normalizeRelayUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请输入 Relay 的完整根地址，例如 http://192.0.2.10:8899');
  return url.origin;
}

export class RelayClient {
  private view = emptyView();
  private listeners = new Set<() => void>();
  private token = '';
  private socket: WebSocket | null = null;
  private generation = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private historyLoading = new Set<string>();
  private catalogLoading = new Set<string>();
  private watched = new Map<string, number>();
  private subscribed = new Set<string>();
  private resyncing = new Set<string>();
  private presenceVersions = new Map<string, number>();
  private pending = new Map<string, { resolve: (result: CommandResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; deviceId: string }>();

  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<RelayView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); }
  private notice(message: string) { this.set({ notice: message }); }
  showNotice(message: string) { if (this.view.phase !== 'locked') this.notice(message); }

  async restore(): Promise<boolean> {
    try {
      const saved = await readCredentials();
      if (!saved) return false;
      const value = JSON.parse(saved) as { url?: string; session?: string };
      if (!value.url || !value.session) { await clearSavedCredentials(); return false; }
      await this.resume(value.url, value.session, false);
      return true;
    } catch { await clearSavedCredentials().catch(() => undefined); return false; }
  }

  async connect(rawUrl: string, username: string, password: string, remember = true): Promise<void> {
    this.disconnect(false);
    const generation = this.generation;
    try {
      const url = normalizeRelayUrl(rawUrl);
      const response = await fetch(url + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: username.trim(), password }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(response.status === 429 ? '登录尝试过多，请稍后重试' : response.status === 401 ? '账号或密码错误' : '登录失败：HTTP ' + response.status);
      const result = await response.json() as { session: string };
      if (generation !== this.generation) return;
      await this.resume(url, result.session, remember);
    } catch (error) { if (generation === this.generation || this.view.phase === 'locked') this.notice(error instanceof Error ? error.message : '登录失败'); throw error; }
  }

  private async resume(rawUrl: string, session: string, remember: boolean): Promise<void> {
    const url = normalizeRelayUrl(rawUrl);
    this.disconnect(false);
    this.token = session;
    this.set({ ...emptyView(), phase: 'connecting', url });
    const generation = this.generation;
    try {
      const me = await this.api<{ role: 'admin' | 'user' }>('/v1/me');
      if (generation !== this.generation) return;
      this.set({ role: me.role });
      if (remember) {
        try { await saveCredentials(JSON.stringify({ url, session: this.token })); }
        catch { this.notice('登录已完成，但当前环境无法保存登录状态'); }
      }
      if (generation !== this.generation) return;
      await this.refreshDevices();
      if (generation !== this.generation) return;
      await this.openSocket(generation);
      if (generation !== this.generation) return;
      this.refreshTimer = setInterval(() => { void this.refreshDevices().catch(error => { if (generation === this.generation) this.notice(String(error)); }); }, 30000);
    } catch (error) {
      if (generation === this.generation) { this.disconnect(true); this.notice(error instanceof Error ? error.message : '连接失败'); }
      throw error;
    }
  }

  async logout(): Promise<void> {
    try { await this.api('/v1/auth/logout', undefined, 'POST'); }
    finally { this.disconnect(true); }
  }

  disconnect(clearCredentials = false): void {
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.socket?.close();
    this.socket = null;
    this.historyLoading.clear(); this.catalogLoading.clear(); this.watched.clear(); this.subscribed.clear(); this.resyncing.clear(); this.presenceVersions.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('连接已断开，请核对操作结果')); }
    this.pending.clear();
    if (clearCredentials) { this.token = ''; void clearSavedCredentials().catch(() => undefined); }
    this.set(emptyView());
  }

  private async api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const generation = this.generation;
    if (!this.view.url || !this.token) throw new Error('连接已断开');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const response = await fetch(`${this.view.url}${path}`, {
        method, headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (response.status === 401 && generation === this.generation) { this.disconnect(true); this.notice('登录已过期，请重新登录'); }
        throw new Error(result.error ?? `HTTP ${response.status}`);
      }
      return response.json() as Promise<T>;
    } finally { clearTimeout(timer); }
  }

  async refreshDevices(): Promise<void> {
    const generation = this.generation;
    const presenceVersions = new Map(this.presenceVersions);
    const response = await this.api<{ devices: Device[] }>('/v1/devices');
    if (generation !== this.generation) return;
    const devices = response.devices.filter(device => typeof device.id === 'string' && typeof device.name === 'string').map(device => {
      const current = this.view.devices.find(value => value.id === device.id);
      return current && presenceVersions.get(device.id) !== this.presenceVersions.get(device.id) ? { ...device, online: current.online } : device;
    });
    this.set({ devices });
    for (const device of devices) {
      if (!this.view.catalogs[device.id]) void this.loadCatalog(device.id);
      if (!this.view.snapshots[device.id]) void this.loadSnapshot(device.id);
      if (this.socket?.readyState === WebSocket.OPEN && this.view.phase === 'connected' && !this.subscribed.has(device.id)) this.subscribeDevice(device.id);
    }
  }

  async loadCatalog(deviceId: string): Promise<void> {
    if (this.view.phase === 'locked' || this.catalogLoading.has(deviceId)) return;
    this.catalogLoading.add(deviceId);
    const generation = this.generation;
    try {
      const response = await this.api<{ catalog: unknown }>(`/v1/devices/${encodeURIComponent(deviceId)}/catalog`);
      if (generation !== this.generation) return;
      const catalog = catalogSchema.parse(response.catalog);
      this.set({ catalogs: { ...this.view.catalogs, [deviceId]: catalog } });
    } catch (error) { if (generation === this.generation) this.notice(`项目目录暂不可用：${error instanceof Error ? error.message : String(error)}`); }
    finally { if (generation === this.generation) this.catalogLoading.delete(deviceId); }
  }

  async loadSnapshot(deviceId: string): Promise<void> {
    const generation = this.generation;
    const presenceVersion = this.presenceVersions.get(deviceId);
    try {
      const response = await this.api<{ snapshot: unknown; online: boolean }>(`/v1/devices/${encodeURIComponent(deviceId)}/snapshot`);
      if (generation !== this.generation) return;
      const snapshot = snapshotSchema.parse(response.snapshot);
      if (snapshot.deviceId !== deviceId) return;
      this.acceptSnapshot(snapshot);
      if (this.view.phase !== 'connected' && presenceVersion === this.presenceVersions.get(deviceId)) this.set({ devices: this.view.devices.map(device => device.id === deviceId ? { ...device, online: response.online } : device) });
    } catch { /* The agent may not have published its first snapshot yet. */ }
  }

  private subscribeDevice(deviceId: string, resume = true): void {
    if (this.view.phase !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) return;
    const snapshot = resume ? this.view.snapshots[deviceId] : undefined;
    this.socket?.send(JSON.stringify({ type: 'client.subscribe', deviceId, ...(snapshot ? { epoch: snapshot.epoch, lastSeq: snapshot.lastSeq } : {}) }));
    this.subscribed.add(deviceId);
    this.set({ syncing: { ...this.view.syncing, [deviceId]: true } });
  }

  private acceptSnapshot(snapshot: DeviceSnapshot): void {
    const current = this.view.snapshots[snapshot.deviceId];
    if (current && (current.epoch === snapshot.epoch ? current.lastSeq > snapshot.lastSeq : current.generatedAt > snapshot.generatedAt)) return;
    this.set({ snapshots: { ...this.view.snapshots, [snapshot.deviceId]: snapshot } });
  }

  private reconcile(deviceId: string): void {
    if (this.resyncing.has(deviceId) || this.socket?.readyState !== WebSocket.OPEN) return;
    this.resyncing.add(deviceId);
    this.subscribeDevice(deviceId, false);
  }

  private async openSocket(generation: number): Promise<void> {
    const { ticket } = await this.api<{ ticket: string }>('/v1/ws/tickets', undefined, 'POST');
    if (generation !== this.generation) return;
    const ws = new WebSocket(`${this.view.url.replace(/^http/, 'ws')}/v1/ws/client`);
    this.socket = ws;
    const currentSocket = () => generation === this.generation && this.socket === ws;
    ws.onopen = () => { if (currentSocket()) ws.send(JSON.stringify({ type: 'client.authenticate', ticket })); };
    ws.onmessage = event => {
      if (!currentSocket()) return;
      try { this.handle(JSON.parse(String(event.data)) as Record<string, unknown>); }
      catch { this.notice('收到无法解析的服务器消息'); }
    };
    ws.onerror = () => { if (currentSocket()) ws.close(); };
    ws.onclose = event => {
      if (!currentSocket()) return;
      if (event?.code === 4003 && event.reason !== 'device-reassigned') { this.disconnect(true); this.notice('登录已过期，请重新登录'); return; }
      this.socket = null;
      this.subscribed.clear(); this.resyncing.clear();
      this.set({ phase: 'reconnecting' });
      const retry = () => { if (generation !== this.generation) return; void this.openSocket(generation).catch(error => { if (generation !== this.generation) return; this.notice(String(error)); this.reconnectTimer = setTimeout(retry, 5000); }); };
      this.reconnectTimer = setTimeout(retry, 3000);
    };
  }

  private handle(message: Record<string, unknown>): void {
    const deviceId = typeof message.deviceId === 'string' ? message.deviceId : '';
    if (message.type === 'client.authenticated') {
      this.set({ phase: 'connected', notice: '' });
      for (const device of this.view.devices) { if (!this.subscribed.has(device.id)) this.subscribeDevice(device.id); void this.loadCatalog(device.id); }
      for (const [id, pending] of this.pending) void this.api<{ result: CommandResult | null }>(`/v1/devices/${encodeURIComponent(pending.deviceId)}/commands/${encodeURIComponent(id)}`).then(response => { if (response.result) this.finishCommand(response.result); }).catch(() => undefined);
    } else if (message.type === 'catalog.updated' && deviceId) void this.loadCatalog(deviceId);
    else if (message.type === 'sync.begin' && deviceId) this.set({ syncing: { ...this.view.syncing, [deviceId]: true } });
    else if (message.type === 'sync.ready' && deviceId) {
      const current = this.view.snapshots[deviceId];
      if (!current || current.epoch !== message.epoch || typeof message.lastSeq !== 'number' || current.lastSeq < message.lastSeq) { this.reconcile(deviceId); return; }
      this.resyncing.delete(deviceId);
      this.set({ syncing: { ...this.view.syncing, [deviceId]: false } });
    } else if (message.type === 'device.presence' && deviceId) {
      this.presenceVersions.set(deviceId, (this.presenceVersions.get(deviceId) ?? 0) + 1);
      if (this.view.devices.some(device => device.id === deviceId && device.online !== (message.online === true))) this.set({ devices: this.view.devices.map(device => device.id === deviceId ? { ...device, online: message.online === true } : device) });
    }
    else if (message.type === 'device.snapshot') {
      const parsed = snapshotSchema.safeParse(message.snapshot);
      if (parsed.success) this.acceptSnapshot(parsed.data);
    } else if (message.type === 'device.event') {
      const parsed = eventSchema.safeParse(message.event);
      if (!parsed.success) return;
      const event = parsed.data, previous = this.view.snapshots[event.deviceId];
      if (previous?.epoch === event.epoch && event.seq <= previous.lastSeq) return;
      if (this.resyncing.has(event.deviceId)) return;
      if (!previous) { this.reconcile(event.deviceId); return; }
      try {
        const snapshot = reduceEvent(previous, event);
        this.set({ snapshots: { ...this.view.snapshots, [event.deviceId]: snapshot } });
        if (event.change.type === 'thread.updated' && previous.threads[event.change.thread.id]?.status === 'active' && event.change.thread.status === 'idle') void this.loadHistory(event.deviceId, event.change.thread.id);
      } catch { this.reconcile(event.deviceId); }
    } else if (message.type === 'command.result') {
      const result = message.result as CommandResult;
      if (result && typeof result.commandId === 'string') this.finishCommand(result);
    } else if (message.type === 'error') this.notice(`同步失败：${String(message.code ?? 'server-error')}`);
  }

  private finishCommand(result: CommandResult): void {
    const pending = this.pending.get(result.commandId);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(result.commandId);
    pending.resolve(result);
  }

  async loadHistory(deviceId: string, threadId: string, earlier = false): Promise<void> {
    if (this.view.phase === 'locked') return;
    const key = historyKey(deviceId, threadId);
    if (this.historyLoading.has(key) || earlier && !this.view.histories[key]?.nextCursor) return;
    this.historyLoading.add(key);
    const generation = this.generation;
    const prior = this.view.histories[key];
    this.set({ histories: { ...this.view.histories, [key]: { turns: prior?.turns ?? [], nextCursor: prior?.nextCursor ?? null, loading: true } } });
    try {
      const cursor = earlier && prior?.nextCursor ? `?cursor=${encodeURIComponent(prior.nextCursor)}` : '';
      const page = historyPageSchema.parse(await this.api<unknown>(`/v1/devices/${encodeURIComponent(deviceId)}/threads/${encodeURIComponent(threadId)}/turns${cursor}`));
      if (generation !== this.generation) return;
      if (page.threadId !== threadId) throw new Error('history-thread-mismatch');
      const incoming = [...page.turns].reverse();
      const current = this.view.histories[key];
      const old = current?.turns ?? [];
      const updates = new Map(incoming.map(turn => [turn.id, turn]));
      const merged = old.map(turn => updates.has(turn.id) ? mergeLiveTurn(turn, updates.get(turn.id)!) : turn);
      const additions = incoming.filter(turn => !old.some(existing => existing.id === turn.id));
      const turns = earlier ? [...additions, ...merged] : [...merged, ...additions];
      this.set({ histories: { ...this.view.histories, [key]: { turns, nextCursor: !earlier && old.length > incoming.length ? current?.nextCursor ?? null : page.nextCursor, loading: false } } });
    } catch (error) {
      if (generation !== this.generation) return;
      const current = this.view.histories[key];
      this.set({ histories: { ...this.view.histories, [key]: { turns: current?.turns ?? [], nextCursor: current?.nextCursor ?? null, loading: false, error: error instanceof Error ? error.message : '历史读取失败' } } });
    } finally { if (generation === this.generation) this.historyLoading.delete(key); }
  }

  watchThread(deviceId: string, threadId: string): void {
    const snapshot = this.view.snapshots[deviceId];
    if (this.view.phase !== 'connected' || this.view.syncing[deviceId] || !snapshot || !this.view.devices.find(device => device.id === deviceId)?.online || snapshot.threads[threadId]?.ownerAvailable) return;
    const key = historyKey(deviceId, threadId);
    if (Date.now() - (this.watched.get(key) ?? 0) < 15000) return;
    this.watched.set(key, Date.now());
    void this.sendCommand(deviceId, { type: 'thread.watch', threadId }).catch(() => undefined);
  }

  async sendCommand(deviceId: string, payload: RemoteCommand['payload']): Promise<CommandResult> {
    const snapshot = this.view.snapshots[deviceId];
    if (this.view.phase !== 'connected' || this.socket?.readyState !== WebSocket.OPEN || !snapshot || !this.view.devices.find(device => device.id === deviceId)?.online || this.view.syncing[deviceId]) throw new Error('设备暂不可操作');
    const command: RemoteCommand = { commandId: randomId(), deviceId, expectedEpoch: snapshot.epoch, expiresAt: Date.now() + 60000, payload };
    const completed = new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(command.commandId); reject(new Error('操作结果未确认，请刷新会话核对')); }, 65000);
      this.pending.set(command.commandId, { resolve, reject, timer, deviceId });
    });
    try {
      const response = await this.api<{ type: string; result?: CommandResult }>(`/v1/devices/${encodeURIComponent(deviceId)}/commands`, command);
      if (response.type === 'command.result' && response.result) this.finishCommand(response.result);
    } catch (error) {
      const pending = this.pending.get(command.commandId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(command.commandId); pending.reject(error instanceof Error ? error : new Error(String(error))); }
    }
    return completed;
  }

  async uploadImage(deviceId: string, threadId: string, value: { name: string; mimeType: string; base64: string }): Promise<ImageRef> {
    if (Math.ceil(value.base64.length * 3 / 4) > MAX_IMAGE_BYTES) throw new Error('图片不能超过 4 MB');
    const result = await this.api<unknown>(`/v1/devices/${encodeURIComponent(deviceId)}/threads/${encodeURIComponent(threadId)}/images`, value);
    return imageRefSchema.parse(result);
  }

  imageSource(deviceId: string, threadId: string, imageId: string) {
    return { uri: `${this.view.url}/v1/devices/${encodeURIComponent(deviceId)}/threads/${encodeURIComponent(threadId)}/images/${imageId}`, headers: { authorization: `Bearer ${this.token}` } };
  }

  async revokeDevice(id: string) { await this.api(`/v1/devices/${encodeURIComponent(id)}`, undefined, 'DELETE'); await this.refreshDevices(); }
}

export const relay = new RelayClient();
