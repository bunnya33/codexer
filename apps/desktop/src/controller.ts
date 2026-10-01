import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { validateRelayUrl, type AgentCredentials } from '../../pc-agent/src/auth.js';
import type { AgentStatus, Settings, ViewState } from './types.js';

export interface Vault { available(): boolean; read(): Promise<AgentCredentials | null>; write(value: AgentCredentials): Promise<void>; clear(): Promise<void> }
export interface Worker { start(credentials: AgentCredentials, settings: Settings): Promise<void>; disconnect(): Promise<void>; reconnect(): Promise<void>; stop(): Promise<void> }
const settingsSchema = z.object({ relayUrl: z.string().max(2048), username: z.string().max(100), deviceName: z.string().trim().min(1).max(200), installationId: z.string().uuid(), codexHome: z.string().max(4096), codexBinary: z.string().max(4096), runtime: z.enum(['auto','desktop','headless']), autoConnect: z.boolean(), openAtLogin: z.boolean(), minimizeToTray: z.boolean(), allowHttp: z.boolean() });
export function defaultSettings(): Settings { return { relayUrl: '', username: '', deviceName: hostname(), installationId: randomUUID(), codexHome: join(homedir(), '.codex'), codexBinary: '', runtime: 'auto', autoConnect: false, openAtLogin: false, minimizeToTray: true, allowHttp: false }; }
// Diagnostic codes only; never accept arbitrary adapter/network exception messages.
export function safeCode(value: string): string { return /^[a-z][a-z0-9-]{0,100}$/.test(value) ? value : 'diagnostic-redacted'; }
export class ConnectorController extends EventEmitter {
  private credentials: AgentCredentials | null = null;
  private workerStarted = false;
  private paused = true;
  private generation = 0;
  private loginAbort?: AbortController;
  private credentialClearing: Promise<void> = Promise.resolve();
  private view: ViewState;
  constructor(private vault: Vault, private worker: Worker, settings: Settings, private persist: (settings: Settings) => Promise<void>, version = '0.1.0') {
    super(); this.view = { settings: settingsSchema.parse(settings), loggedIn: false, secureStorage: vault.available(), busy: false, phase: 'signed-out', status: null, logs: [], error: '', expiresAt: null, version };
  }
  state(): ViewState { return structuredClone(this.view); }
  private publish(patch: Partial<ViewState> = {}) { this.view = { ...this.view, ...patch }; this.emit('state', this.state()); }
  log(code: string) { this.publish({ logs: [...this.view.logs.slice(-199), { at: Date.now(), code: safeCode(code) }] }); }
  update(status: AgentStatus) {
    const phase = !this.credentials ? 'signed-out' : this.paused ? 'disconnected' : status.relayConnected ? 'connected' : 'reconnecting';
    this.publish({ status, phase });
    if (!status.sessionValid && this.credentials) { this.paused = true; this.credentials = null; this.credentialClearing = this.vault.clear().catch(() => this.log('credential-clear-failed')); this.publish({ loggedIn: false, phase: 'signed-out', expiresAt: null, error: '登录已失效，请重新登录；本机任务会继续运行。' }); }
  }
  workerExited() { this.workerStarted = false; this.paused = true; this.publish({ phase: this.credentials ? 'disconnected' : 'signed-out', status: null, error: '本机服务已退出，请查看诊断并重新连接。' }); this.log('worker-exited'); }
  async initialize() {
    try {
      const credentials = await this.vault.read();
      if (credentials && credentials.expiresAt > Date.now() && credentials.installationId === this.view.settings.installationId && credentials.relayUrl === this.view.settings.relayUrl) {
        this.credentials = credentials; this.publish({ loggedIn: true, phase: 'disconnected', expiresAt: credentials.expiresAt });
        if (this.view.settings.autoConnect) await this.connect();
      } else if (credentials) await this.vault.clear();
    } catch { this.publish({ error: '无法恢复系统加密的登录状态，请重新登录。' }); }
  }
  private idleRequired() { if (this.workerStarted && (!this.view.status || this.view.status.activeTasks)) throw new Error('本机仍有任务运行或状态尚未确认，请等待任务结束后再登录或修改运行配置。'); }
  private async operation(action: () => Promise<void>) {
    if (this.view.busy) throw new Error('正在处理上一个操作，请稍候。');
    this.publish({ busy: true, error: '' });
    try { await action(); } catch (error) { this.publish({ error: error instanceof Error ? error.message : '操作失败' }); throw error; } finally { this.publish({ busy: false }); }
  }
  async save(raw: Settings) { await this.operation(async () => {
    const next = settingsSchema.parse(raw), before = this.view.settings;
    next.installationId = before.installationId;
    if (next.relayUrl) next.relayUrl = validateRelayUrl(next.relayUrl.trim(), next.allowHttp).origin;
    const runtimeChanged = ['relayUrl','deviceName','codexHome','codexBinary','runtime','allowHttp'].some(key => next[key as keyof Settings] !== before[key as keyof Settings]);
    if (runtimeChanged) { this.idleRequired(); await this.disconnect(); if (this.workerStarted) { await this.worker.stop(); this.workerStarted = false; this.publish({ status: null }); } }
    if (next.relayUrl !== before.relayUrl || next.deviceName !== before.deviceName) await this.clearLogin();
    await this.persist(next); this.publish({ settings: next }); this.log('settings-saved');
  }); }
  async login(username: string, password: string) { await this.operation(async () => {
    this.idleRequired();
    if (!this.vault.available()) throw new Error('系统安全存储不可用，无法保存登录会话。');
    const settings = this.view.settings, url = validateRelayUrl(settings.relayUrl.trim(), settings.allowHttp).origin;
    if (!username.trim() || !password || password.length > 128) throw new Error('请输入账号和密码。');
    await this.disconnect(); const generation = this.generation;
    if (this.workerStarted) { await this.worker.stop(); this.workerStarted = false; this.publish({ status: null }); }
    await this.clearLogin();
    this.loginAbort = new AbortController(); const timer = setTimeout(() => this.loginAbort?.abort(), 15000);
    let credentials: AgentCredentials | null = null;
    try {
      const response = await fetch(new URL('/v1/agents/login', url), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: username.trim(), password, installationId: settings.installationId, name: settings.deviceName, platform: process.platform }), signal: this.loginAbort.signal });
      if (!response.ok) throw new Error(response.status === 401 ? '账号或密码错误。' : response.status === 429 ? '登录过于频繁，请稍后再试。' : '服务器拒绝登录，请检查账号状态。');
      const result = z.object({ session: z.string().min(1), deviceId: z.string().uuid(), expiresAt: z.number() }).parse(await response.json());
      credentials = { ...result, relayUrl: url, username: username.trim(), installationId: settings.installationId };
      if (generation !== this.generation) { await this.revoke(credentials); return; }
      await this.vault.write(credentials);
      if (generation !== this.generation) { await this.vault.clear(); await this.revoke(credentials); return; }
      const next = { ...settings, relayUrl: url, username: username.trim() };
      await this.persist(next);
      if (generation !== this.generation) { await this.vault.clear(); await this.revoke(credentials); return; }
      this.credentials = credentials;
      this.publish({ settings: next, loggedIn: true, expiresAt: credentials.expiresAt, phase: 'disconnected' }); this.log('account-login-succeeded');
      await this.startConnection();
    } catch (error) {
      if (credentials && !this.credentials) await this.revoke(credentials).catch(() => undefined);
      throw new Error(error instanceof Error && error.message.endsWith('。') ? error.message : '登录失败，请检查服务器地址和网络后重试。');
    } finally { clearTimeout(timer); this.loginAbort = undefined; }
  }); }
  private async revoke(credentials: AgentCredentials) { await fetch(new URL('/v1/auth/logout', credentials.relayUrl), { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${credentials.session}` }, signal: AbortSignal.timeout(5000) }); }
  private async clearLogin() { const credentials = this.credentials; this.credentials = null; await this.credentialClearing; await this.vault.clear(); this.publish({ loggedIn: false, phase: 'signed-out', expiresAt: null }); if (credentials) await this.revoke(credentials).catch(() => this.log('logout-server-unreachable')); }
  async logout() { await this.operation(async () => { await this.disconnect(); await this.clearLogin(); this.log('account-logged-out'); }); }
  private async startConnection() {
    if (!this.credentials || this.credentials.expiresAt <= Date.now()) throw new Error('请先登录账号。');
    const generation = this.generation; this.paused = false; this.publish({ phase: 'connecting' });
    if (this.workerStarted) await this.worker.reconnect();
    else { this.workerStarted = true; try { await this.worker.start(this.credentials, this.view.settings); } catch { await this.worker.stop().catch(() => undefined); this.workerStarted = false; this.paused = true; this.publish({ phase: 'disconnected' }); throw new Error('本机服务启动失败，请查看诊断。'); } }
    if (generation !== this.generation) await this.worker.disconnect();
  }
  async connect() { await this.operation(() => this.startConnection()); }
  async reconnect() { await this.operation(async () => { await this.disconnect(); await this.startConnection(); }); }
  async disconnect() { this.generation++; this.loginAbort?.abort(); this.paused = true; this.publish({ phase: this.credentials ? 'disconnected' : 'signed-out' }); if (this.workerStarted) await this.worker.disconnect(); this.log('remote-paused'); }
  async shutdown() { await this.disconnect(); if (this.workerStarted) await this.worker.stop(); }
}
