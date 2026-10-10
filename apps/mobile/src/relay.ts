import { clearCredentials as clearSavedCredentials, randomId, readCredentials, saveCredentials } from './runtime';
import { catalogSchema, eventSchema, historyPageSchema, imageRefSchema, MAX_IMAGE_BYTES, reduceEvent, snapshotSchema } from '../../../packages/protocol/src/index';
import type { CommandResult, DeviceCatalog, DeviceSnapshot, HistoryTurn, ImageRef, RemoteCommand } from '../../../packages/protocol/src/index';
import type { WeixinLogin, WeixinStatus } from '../../../packages/protocol/src/weixin';
import { threadNotificationSchema } from '../../../packages/protocol/src/weixin';
import type { ThreadNotification } from '../../../packages/protocol/src/weixin';
import { mergeTurnHistory } from '../../../packages/client-shared/src/activity';
import { fileInfoSchema } from '../../../packages/protocol/src/files';
import type { FileInfo } from '../../../packages/protocol/src/files';
import type { WidgetState } from '../../../packages/client-shared/src/previews';

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
  weixin: WeixinStatus | null;
  threadNotifications: Record<string, ThreadNotification>;
};

const emptyView = (): RelayView => ({ phase: 'locked', url: '', role: null, devices: [], catalogs: {}, snapshots: {}, histories: {}, syncing: {}, notice: '', weixin: null, threadNotifications: {} });
const SOCKET_AUTH_TIMEOUT_MS = 12000;
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
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
  private connectionRevision = 0;
  private socketAttempt = 0;
  private socketTimeout?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private foreground = true;
  private initialization?: { generation: number; revision: number };
  private historyLoading = new Set<string>();
  private catalogLoading = new Set<string>();
  private watched = new Map<string, number>();
  private subscribed = new Set<string>();
  private resyncing = new Set<string>();
  private presenceVersions = new Map<string, number>();
  private notificationVersions = new Map<string, number>();
  private weixinVersion = 0;
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
      normalizeRelayUrl(value.url);
      await this.resume(value.url, value.session, false);
      return this.view.phase !== 'locked';
    } catch (error) {
      if (!(error instanceof ApiError)) await clearSavedCredentials().catch(() => undefined);
      return false;
    }
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
    await this.initializeSession(generation, remember);
  }

  private async initializeSession(generation: number, remember: boolean): Promise<void> {
    const revision = this.connectionRevision;
    if (generation !== this.generation || this.initialization?.generation === generation && this.initialization.revision === revision) return;
    const initialization = { generation, revision };
    this.initialization = initialization;
    const current = () => generation === this.generation && revision === this.connectionRevision;
    try {
      const me = await this.api<{ role: 'admin' | 'user' }>('/v1/me');
      if (!current()) return;
      this.set({ role: me.role });
      if (remember) {
        try { await saveCredentials(JSON.stringify({ url: this.view.url, session: this.token })); }
        catch { this.notice('登录已完成，但当前环境无法保存登录状态'); }
      }
      if (!current()) return;
      if (this.foreground) await this.touchLogin();
      if (!current()) return;
      await this.refreshDevices();
      if (!current()) return;
      await this.openSocket(generation, revision);
      if (!current()) return;
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = setInterval(() => {
        if (!this.foreground) return;
        void this.touchLogin().then(() => this.refreshDevices()).catch(() => undefined);
      }, 30000);
    } catch (error) {
      if (!current()) return;
      if (this.view.phase === 'locked') throw error;
      this.set({phase: 'reconnecting', notice: '网络暂不可用，正在恢复连接'});
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => { if (current()) void this.initializeSession(generation, remember).catch(() => undefined); }, 3000);
    } finally { if (this.initialization === initialization) this.initialization = undefined; }
  }

  private async touchLogin(): Promise<void> {
    try { await this.api('/v1/auth/active', undefined, 'POST', true); }
    catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  }

  setForeground(active: boolean): void {
    const previous = this.foreground;
    this.foreground = active;
    if (!this.token || this.view.phase === 'locked' || previous === active) return;
    if (!active) { void this.touchLogin().catch(() => undefined); return; }
    // A suspended browser can retain a socket that looks open but no longer receives data.
    // Invalidate pending ticket/initialization responses as well as the old socket callbacks.
    this.connectionRevision++;
    this.socketAttempt++;
    if (this.socketTimeout) clearTimeout(this.socketTimeout);
    const oldSocket = this.socket;
    this.socket = null;
    oldSocket?.close();
    this.subscribed.clear(); this.resyncing.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.set({phase: 'reconnecting'});
    void this.initializeSession(this.generation, false).catch(() => undefined);
  }

  async logout(): Promise<void> {
    try { await this.api('/v1/auth/logout', undefined, 'POST'); }
    finally { this.disconnect(true); }
  }
  async weixinStatus() {
    const generation = this.generation, version = this.weixinVersion;
    const status = await this.api<WeixinStatus>('/v1/weixin');
    if (generation === this.generation && version === this.weixinVersion) this.acceptWeixin(status);
    return status;
  }
  weixinLogin() { return this.api<WeixinLogin>('/v1/weixin/login',{},'POST'); }
  weixinPoll(loginId:string,verifyCode?:string) { return this.api<WeixinLogin>(`/v1/weixin/login/${encodeURIComponent(loginId)}/poll`,verifyCode?{verifyCode}:{},'POST'); }
  async weixinSettings(notifications:boolean,replies:boolean) {
    const generation = this.generation, version = this.weixinVersion;
    const status = await this.api<WeixinStatus>('/v1/weixin',{notifications,replies},'PUT');
    if (generation === this.generation && version === this.weixinVersion) this.acceptWeixin(status);
    return status;
  }
  weixinUnbind() { return this.api('/v1/weixin',undefined,'DELETE'); }
  weixinTest() { return this.api('/v1/weixin/test',{},'POST'); }

  private acceptWeixin(status: WeixinStatus) {
    this.weixinVersion++;
    this.set({ weixin: status, threadNotifications: Object.fromEntries(Object.entries(this.view.threadNotifications).map(([key, value]) => [key, { ...value, allEnabled: status.bound && status.notifications, bound: status.bound, available: status.available }])) });
  }

  private async threadNotification(deviceId: string, threadId: string, enabled?: boolean) {
    const generation = this.generation, key = historyKey(deviceId, threadId), version = this.notificationVersions.get(key), weixinVersion = this.weixinVersion;
    const notification = threadNotificationSchema.parse(await this.api<unknown>(`/v1/devices/${encodeURIComponent(deviceId)}/threads/${encodeURIComponent(threadId)}/weixin-notification`, enabled === undefined ? undefined : { enabled }, enabled === undefined ? 'GET' : 'PUT'));
    if (generation !== this.generation || version !== this.notificationVersions.get(key)) return;
    if (weixinVersion !== this.weixinVersion && this.view.weixin) {
      notification.allEnabled = this.view.weixin.bound && this.view.weixin.notifications;
      notification.bound = this.view.weixin.bound;
      notification.available = this.view.weixin.available;
    }
    this.set({ threadNotifications: { ...this.view.threadNotifications, [key]: notification } });
  }
  loadThreadNotification(deviceId: string, threadId: string) { return this.threadNotification(deviceId, threadId); }
  setThreadNotification(deviceId: string, threadId: string, enabled: boolean) { return this.threadNotification(deviceId, threadId, enabled); }

  disconnect(clearCredentials = false): void {
    this.generation++;
    this.connectionRevision++;
    this.socketAttempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.socketTimeout) clearTimeout(this.socketTimeout);
    this.socket?.close();
    this.socket = null;
    this.historyLoading.clear(); this.catalogLoading.clear(); this.watched.clear(); this.subscribed.clear(); this.resyncing.clear(); this.presenceVersions.clear();
    this.notificationVersions.clear();
    this.weixinVersion++;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('连接已断开，请核对操作结果')); }
    this.pending.clear();
    if (clearCredentials) { this.token = ''; void clearSavedCredentials().catch(() => undefined); }
    this.set(emptyView());
  }

  private async api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', keepalive = false, signal?: AbortSignal): Promise<T> {
    const generation = this.generation;
    if (!this.view.url || !this.token) throw new Error('连接已断开');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const response = await fetch(`${this.view.url}${path}`, {
        method, headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, ...(keepalive ? {keepalive: true} : {}),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (response.status === 401 && generation === this.generation) { this.disconnect(true); this.notice('登录已过期，请重新登录'); }
        throw new ApiError(response.status, result.error ?? `HTTP ${response.status}`);
      }
      return response.json() as Promise<T>;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
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

  private async openSocket(generation: number, revision = this.connectionRevision): Promise<void> {
    if (generation !== this.generation || revision !== this.connectionRevision || this.socket) return;
    const attempt = ++this.socketAttempt;
    const currentAttempt = () => generation === this.generation && revision === this.connectionRevision && attempt === this.socketAttempt;
    const retry = (delay: number) => {
      if (!currentAttempt()) return;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (currentAttempt() && !this.socket) void this.openSocket(generation, revision);
      }, delay);
    };
    try {
      const { ticket } = await this.api<{ ticket: string }>('/v1/ws/tickets', undefined, 'POST');
      if (!currentAttempt()) return;
      const ws = new WebSocket(`${this.view.url.replace(/^http/, 'ws')}/v1/ws/client`);
      this.socket = ws;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      const currentSocket = () => currentAttempt() && this.socket === ws;
      const recover = (notice: string) => {
        if (!currentSocket()) return;
        // Detach first: close/error callbacks can be delayed or never arrive through a proxy.
        this.socket = null;
        if (this.socketTimeout) clearTimeout(this.socketTimeout);
        this.subscribed.clear(); this.resyncing.clear();
        this.set({ phase: 'reconnecting', notice });
        retry(3000);
        ws.close();
      };
      this.socketTimeout = setTimeout(() => {
        recover('实时连接超时，正在重试；请检查 VPN 或代理设置');
      }, SOCKET_AUTH_TIMEOUT_MS);
      ws.onopen = () => {
        if (!currentSocket()) return;
        try { ws.send(JSON.stringify({ type: 'client.authenticate', ticket })); }
        catch { recover('实时连接失败，正在重试'); }
      };
      ws.onmessage = event => {
        if (!currentSocket()) return;
        try {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === 'client.authenticated') {
            if (this.socketTimeout) clearTimeout(this.socketTimeout);
          }
          this.handle(message);
        } catch { this.notice('收到无法解析的服务器消息'); }
      };
      ws.onerror = () => recover('实时连接失败，正在重试；请检查 VPN 或代理设置');
      ws.onclose = event => {
        if (!currentSocket()) return;
        if (event?.code === 4003 && event.reason !== 'device-reassigned') { this.disconnect(true); this.notice('登录已过期，请重新登录'); return; }
        recover(event?.code === 1008 ? '实时连接认证未完成，正在重试' : '实时连接中断，正在重试');
      };
    } catch {
      if (!currentAttempt()) return;
      this.set({ phase: 'reconnecting', notice: '实时连接暂不可用，正在重试' });
      retry(5000);
    }
  }

  private handle(message: Record<string, unknown>): void {
    const deviceId = typeof message.deviceId === 'string' ? message.deviceId : '';
    if (message.type === 'client.authenticated') {
      this.set({ phase: 'connected', notice: '' });
      if (this.view.role === 'user') void this.weixinStatus().catch(() => undefined);
      for (const device of this.view.devices) { if (!this.subscribed.has(device.id)) this.subscribeDevice(device.id); void this.loadCatalog(device.id); }
      for (const [id, pending] of this.pending) void this.api<{ result: CommandResult | null }>(`/v1/devices/${encodeURIComponent(pending.deviceId)}/commands/${encodeURIComponent(id)}`).then(response => { if (response.result) this.finishCommand(response.result); }).catch(() => undefined);
    } else if (message.type === 'weixin.settings') {
      const status = message.status as WeixinStatus | undefined;
      if (status && typeof status.notifications === 'boolean' && typeof status.bound === 'boolean') this.acceptWeixin(status);
    } else if (message.type === 'weixin.thread-notification' && deviceId && typeof message.threadId === 'string') {
      const parsed = threadNotificationSchema.safeParse(message.notification);
      if (!parsed.success) return;
      const key = historyKey(deviceId, message.threadId);
      this.notificationVersions.set(key, (this.notificationVersions.get(key) ?? 0) + 1);
      this.set({ threadNotifications: { ...this.view.threadNotifications, [key]: parsed.data } });
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
      const turns = mergeTurnHistory(old, incoming, earlier ? 'earlier' : 'latest');
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

  async fileInfo(deviceId: string, threadId: string, path: string, signal: AbortSignal): Promise<FileInfo> {
    const result = await this.api<unknown>(`/v1/devices/${encodeURIComponent(deviceId)}/threads/${encodeURIComponent(threadId)}/files/info?path=${encodeURIComponent(path)}`, undefined, 'GET', false, signal);
    return fileInfoSchema.parse(result);
  }

  fileSource(deviceId: string, threadId: string, path: string, version: string) {
    if (!this.view.url || !this.token) throw new Error('连接已断开');
    return { uri: `${this.view.url}/v1/devices/${encodeURIComponent(deviceId)}/threads/${encodeURIComponent(threadId)}/files/content?path=${encodeURIComponent(path)}&version=${encodeURIComponent(version)}`, headers: { authorization: `Bearer ${this.token}` } };
  }

  previewStateKey(deviceId: string, threadId: string, source: string): string {
    // Separate saved previews by login session without writing a credential into storage keys.
    let hash = 2166136261;
    for (const char of this.token) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return JSON.stringify([this.view.url, (hash >>> 0).toString(16), deviceId, threadId, source]);
  }

  async openPreview(deviceId: string, threadId: string, url: string, channel: string, state: WidgetState | null, signal: AbortSignal): Promise<string> {
    const result = await this.api<{ path: string; expiresAt: number }>(`/v1/devices/${encodeURIComponent(deviceId)}/threads/${encodeURIComponent(threadId)}/previews`, {url, channel, state}, 'POST', false, signal);
    if (!/^\/v1\/previews\/[a-f0-9]{64}\//.test(result.path)) throw new Error('预览地址无效');
    const source = this.view.url + result.path;
    try {
      const response = await fetch(source, { signal });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error ?? '本地网页暂不可用');
      }
      await response.body?.cancel();
      return source;
    } catch (error) { void this.closePreview(source).catch(() => {}); throw error; }
  }

  async closePreview(source: string): Promise<void> {
    const url=new URL(source);
    if (url.origin!==new URL(this.view.url).origin) return;
    const match=url.pathname.match(/^\/v1\/previews\/([a-f0-9]{64})\//);
    if (match) await this.api(`/v1/previews/${match[1]}`,undefined,'DELETE');
  }

  async revokeDevice(id: string) { await this.api(`/v1/devices/${encodeURIComponent(id)}`, undefined, 'DELETE'); await this.refreshDevices(); }
}

export const relay = new RelayClient();
