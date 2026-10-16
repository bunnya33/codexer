import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
import { normalizeThread } from '../packages/codex-adapter/src/normalize';
import type { DeviceCatalog, ModelSettings, RemoteCommand } from '../packages/protocol/src/index';

const origin = 'http://selection.test';
const selectionKey = (userId = 'user-a', url = origin) => 'codexer.web.selection.v1:' + encodeURIComponent(JSON.stringify([url, userId]));
const devices = ['pc-a', 'pc-b'].map(id => ({ id, name: id, platform: 'darwin', online: true }));
const catalog = (deviceId: string): DeviceCatalog => ({
  protocolVersion: 1, deviceId, generatedAt: 1, projects: [],
  threads: ['recent', 'older'].map((name, index) => ({ id: `${name}-${deviceId}`, title: `${name}-${deviceId}`, cwd: '/fixture', projectId: null, updatedAt: 10 - index, archived: false })),
});
let javascript = '', css = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/selection-app.tsx'], outdir: '.local/selection-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' } });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
  css = result.outputFiles!.find(file => file.path.endsWith('.css'))?.text ?? '';
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
type FixtureOptions = {
  storage?: Record<string, string>; userId?: string; devices?: typeof devices; catalogs?: Record<string, DeviceCatalog>;
  delayDevices?: boolean; delayCatalog?: string; blockedStorage?: boolean;
  controls?: { active: boolean; text: string; images: string[]; failEffort?: boolean };
};
type TestRelay = {
  getSnapshot(): { userId: string | null; devicesReady: boolean; phase: string; syncing: Record<string, boolean> };
  connect(url: string, username: string, password: string): Promise<void>;
  logout(): Promise<void>; loadCatalog(deviceId: string): Promise<void>; refreshDevices(): Promise<void>;
};
async function fixture(options: FixtureOptions = {}) {
  const current = { userId: options.userId ?? 'user-a', devices: options.devices ?? devices, catalogs: options.catalogs ?? Object.fromEntries(devices.map(device => [device.id, catalog(device.id)])) };
  const controls = options.controls;
  const settings: ModelSettings = { model: 'gpt-6.1-sol', modelProvider: 'fixture', reasoningEffort: 'xhigh', collaborationMode: 'default' };
  if (controls) for (const item of Object.values(current.catalogs)) item.models = ['gpt-6.1-sol', 'gpt-6-astra'].map((model, index) => ({ model, displayName: index ? '6 Astra' : '6.1 Sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'high' }));
  const sockets: { onmessage?: (event: { data: string }) => void }[] = [];
  const deviceGate = gate(), catalogGate = gate();
  const historyRequests: string[] = [], commands: RemoteCommand[] = [], errors: unknown[] = [];
  const dom = new JSDOM(`<style>${css}</style><div id="root"></div>`, {
    url: origin, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.addEventListener('error', event => errors.push(event.error));
      window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
      Object.assign(window, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, AbortSignal, fetch: async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        if (path === '/v1/auth/login') { current.userId = JSON.parse(String(init?.body)).username; return response({ session: 'fixture-token' }); }
        if (path === '/v1/auth/logout' || path === '/v1/auth/active') return response({});
        if (path === '/v1/me') return response({ role: 'user', userId: current.userId });
        if (path === '/v1/devices') { if (options.delayDevices) await deviceGate.promise; return response({ devices: current.devices }); }
        if (path === '/v1/ws/tickets') return response({ ticket: 'fixture-ticket' });
        if (path === '/v1/weixin' || path.endsWith('/weixin-notification')) return response({ enabled: false, allEnabled: false, available: false, bound: false });
        const [, deviceId, suffix] = path.match(/^\/v1\/devices\/([^/]+)\/(.*)$/) ?? [];
        if (deviceId && suffix === 'catalog') { if (deviceId === options.delayCatalog) await catalogGate.promise; return response({ catalog: current.catalogs[deviceId] }); }
        if (deviceId && suffix === 'snapshot') return response({ online: current.devices.find(device => device.id === deviceId)?.online ?? false, snapshot: snapshot(deviceId) });
        if (deviceId && suffix?.endsWith('/turns')) {
          historyRequests.push(path);
          const threadId = suffix.split('/')[1]!;
          return response({ threadId, turns: [], nextCursor: null, generatedAt: 1 });
        }
        if (deviceId && suffix === 'commands') {
          const command = JSON.parse(String(init?.body)) as RemoteCommand;
          commands.push(command);
          if (!controls) return response({ commandId: 'fixture-command' });
          let result: Record<string, unknown> = {}, code = 'ok';
          const payload = command.payload;
          if (payload.type === 'thread.effort.update') {
            if (controls.failEffort) code = 'stale-settings';
            else settings.reasoningEffort = payload.effort;
          }
          if (payload.type === 'thread.model.update') settings.model = payload.model;
          if (payload.type === 'turn.queue.read') result = { queueId: payload.queueId, text: controls.text, images: controls.images };
          if (payload.type === 'turn.queue.update') {
            if (payload.expectedText !== controls.text) code = 'queue-item-changed';
            else controls.text = payload.text;
          }
          for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify({ type: 'device.snapshot', snapshot: snapshot(deviceId) }) });
          return response({ type: 'command.result', result: { commandId: command.commandId, deviceId, status: code === 'ok' ? 'succeeded' : 'failed', code, result } });
        }
        throw new Error(`unexpected-request:${path}`);
      } });
      function snapshot(deviceId: string) {
        return { protocolVersion: 1, deviceId, epoch: 'fixture', lastSeq: 0, generatedAt: 1, hostname: deviceId, platform: 'darwin',
          runtime: { kind: 'official-desktop-ipc', connected: true, experimental: true, capabilities: { observe: true, startTurn: true, interrupt: true, approvals: true, userInput: true } },
          threads: Object.fromEntries((current.catalogs[deviceId]?.threads ?? []).map(thread => [thread.id, { ...normalizeThread({ ...thread, threadRuntimeStatus: { type: controls?.active ? 'active' : 'idle', activeFlags: [] }, turns: [], requests: [] }, 0), ownerAvailable: true,
            ...(controls ? { settings, activeTurnId: controls.active ? 'active-turn' : null, queuedMessages: [{ id: 'queue-1', text: controls.text.slice(0, 1000), imageCount: controls.images.length, createdAt: 1, status: 'queued' }] } : {}),
          }])) };
      }
      class Socket {
        static OPEN = 1;
        readyState = 0;
        onopen?: () => void; onmessage?: (event: { data: string }) => void;
        constructor() { sockets.push(this); window.setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
        send(raw: string) {
          const value = JSON.parse(raw);
          window.setTimeout(() => {
            if (this.readyState !== 1) return;
            const message = (data: unknown) => this.onmessage?.({ data: JSON.stringify(data) });
            if (value.type === 'client.authenticate') message({ type: 'client.authenticated' });
            if (value.type === 'client.subscribe') {
              message({ type: 'device.snapshot', snapshot: snapshot(value.deviceId) });
              message({ type: 'sync.ready', deviceId: value.deviceId, epoch: 'fixture', lastSeq: 0 });
            }
          }, 0);
        }
        close() { this.readyState = 3; }
      }
      Object.assign(window, { WebSocket: Socket });
      window.localStorage.setItem('codexer.web.relay.v1control', JSON.stringify({ url: origin, session: 'fixture-token' }));
      for (const [key, value] of Object.entries(options.storage ?? {})) window.localStorage.setItem(key, value);
      if (options.blockedStorage) {
        const get = window.Storage.prototype.getItem, set = window.Storage.prototype.setItem;
        window.Storage.prototype.getItem = function(key) { if (key.startsWith('codexer.web.selection.')) throw new Error('storage-blocked'); return get.call(this, key); };
        window.Storage.prototype.setItem = function(key, value) { if (key.startsWith('codexer.web.selection.')) throw new Error('storage-blocked'); set.call(this, key, value); };
      }
    },
  });
  Object.defineProperties(dom.window.document.documentElement, { clientWidth: { value: 1024 }, clientHeight: { value: 800 } });
  dom.window.eval(javascript);
  const app = () => (dom.window as unknown as { selectionApp: { relay: TestRelay; close(): void } }).selectionApp;
  await vi.waitFor(() => expect(app()).toBeDefined());
  const header = () => dom.window.document.querySelector('[data-testid="conversation-header"]')?.textContent;
  const click = (label: string) => (dom.window.document.querySelector(`[aria-label="${label}"]`) as HTMLElement).click();
  const close = () => { deviceGate.release(); catalogGate.release(); app().close(); dom.window.close(); };
  return { dom, current, historyRequests, commands, errors, app, header, click, close, deviceGate, catalogGate };
}

it('remembers a manually selected device and older conversation across a full app reload', async () => {
  const first = await fixture();
  let storage: Record<string, string> = {};
  try {
    await vi.waitFor(() => expect(first.header()).toContain('recent-pc-a'));
    await vi.waitFor(() => expect(first.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    first.click('切换 PC Agent，当前：pc-a，在线');
    await vi.waitFor(() => expect(first.dom.window.document.querySelector('[aria-label="选择设备 pc-b，在线"]')).not.toBeNull());
    first.click('选择设备 pc-b，在线');
    await vi.waitFor(() => expect(first.header()).toContain('recent-pc-b'));
    const row = [...first.dom.window.document.querySelectorAll('[role="button"]')].find(element => element.textContent === 'older-pc-b') as HTMLElement;
    row.click();
    await vi.waitFor(() => expect(first.header()).toContain('older-pc-b'));
    await vi.waitFor(() => expect(JSON.parse(first.dom.window.localStorage.getItem(selectionKey())!)).toEqual({ deviceId: 'pc-b', threadId: 'older-pc-b' }));
    storage = Object.fromEntries(Object.keys(first.dom.window.localStorage).map(key => [key, first.dom.window.localStorage.getItem(key)!]));
    expect(first.historyRequests).not.toContain('/v1/devices/pc-b/threads/recent-pc-a/turns');
    expect(first.errors).toEqual([]);
  } finally { first.close(); }
  const second = await fixture({ storage });
  try {
    await vi.waitFor(() => expect(second.header()).toContain('older-pc-b'));
    expect(second.historyRequests.every(path => path === '/v1/devices/pc-b/threads/older-pc-b/turns')).toBe(true);
    expect(second.errors).toEqual([]);
  } finally { second.close(); }
});

it('waits for device and catalog responses without replacing saved navigation or loading the default conversation', async () => {
  const saved = JSON.stringify({ deviceId: 'pc-b', threadId: 'older-pc-b' });
  const test = await fixture({ storage: { [selectionKey()]: saved }, delayDevices: true, delayCatalog: 'pc-b' });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().userId).toBe('user-a'));
    expect(test.app().relay.getSnapshot().devicesReady).toBe(false);
    expect(test.historyRequests).toEqual([]);
    expect(test.dom.window.localStorage.getItem(selectionKey())).toBe(saved);
    test.deviceGate.release();
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().phase).toBe('connected'));
    expect(test.historyRequests).toEqual([]);
    expect(test.dom.window.localStorage.getItem(selectionKey())).toBe(saved);
    test.catalogGate.release();
    await vi.waitFor(() => expect(test.header()).toContain('older-pc-b'));
    expect(test.historyRequests).toEqual(['/v1/devices/pc-b/threads/older-pc-b/turns']);
    expect(test.commands).toEqual([]);
  } finally { test.close(); }
});

it('keeps an existing offline device selected', async () => {
  const test = await fixture({ storage: { [selectionKey()]: JSON.stringify({ deviceId: 'pc-b', threadId: 'older-pc-b' }) }, devices: devices.map(device => ({ ...device, online: false })) });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('older-pc-b'));
    expect(test.dom.window.document.querySelector('[aria-label="切换 PC Agent，当前：pc-b，离线"]')).not.toBeNull();
    expect(test.commands).toEqual([]);
  } finally { test.close(); }
});

it('remembers an explicit device switch even while its catalog is still loading', async () => {
  const test = await fixture({ delayCatalog: 'pc-b' });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    test.click('切换 PC Agent，当前：pc-a，在线');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="选择设备 pc-b，在线"]')).not.toBeNull());
    test.click('选择设备 pc-b，在线');
    await vi.waitFor(() => expect(JSON.parse(test.dom.window.localStorage.getItem(selectionKey())!)).toEqual({ deviceId: 'pc-b', threadId: '' }));
    expect(test.historyRequests.every(path => path.includes('/pc-a/threads/recent-pc-a/'))).toBe(true);
    test.catalogGate.release();
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-b'));
  } finally { test.close(); }
});

it('falls back when a selected conversation is archived by another client', async () => {
  const test = await fixture({ storage: { [selectionKey()]: JSON.stringify({ deviceId: 'pc-b', threadId: 'older-pc-b' }) } });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('older-pc-b'));
    test.current.catalogs['pc-b']!.threads[1]!.archived = true;
    await test.app().relay.loadCatalog('pc-b');
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-b'));
    await vi.waitFor(() => expect(JSON.parse(test.dom.window.localStorage.getItem(selectionKey())!)).toEqual({ deviceId: 'pc-b', threadId: 'recent-pc-b' }));
  } finally { test.close(); }
});

it('clears a removed selection only after an authoritative empty device list', async () => {
  const test = await fixture({ storage: { [selectionKey()]: JSON.stringify({ deviceId: 'pc-b', threadId: 'older-pc-b' }) }, devices: [], delayDevices: true });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().userId).toBe('user-a'));
    expect(test.dom.window.localStorage.getItem(selectionKey())).not.toBeNull();
    test.deviceGate.release();
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().devicesReady).toBe(true));
    await vi.waitFor(() => expect(test.dom.window.localStorage.getItem(selectionKey())).toBeNull());
    expect(test.historyRequests).toEqual([]);
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it.each(['removed-device', 'deleted-thread', 'archived-thread'])('falls back when the saved selection is %s', async reason => {
  const pcB = catalog('pc-b');
  if (reason === 'deleted-thread') pcB.threads = pcB.threads.filter(thread => thread.id !== 'older-pc-b');
  if (reason === 'archived-thread') pcB.threads[1]!.archived = true;
  const test = await fixture({ storage: { [selectionKey()]: JSON.stringify({ deviceId: 'pc-b', threadId: 'older-pc-b' }) }, devices: reason === 'removed-device' ? devices.slice(0, 1) : devices, catalogs: { 'pc-a': catalog('pc-a'), 'pc-b': pcB } });
  try {
    const selectedDevice = reason === 'removed-device' ? 'pc-a' : 'pc-b';
    await vi.waitFor(() => expect(test.header()).toContain(`recent-${selectedDevice}`));
    await vi.waitFor(() => expect(JSON.parse(test.dom.window.localStorage.getItem(selectionKey())!)).toEqual({ deviceId: selectedDevice, threadId: `recent-${selectedDevice}` }));
    expect(test.historyRequests.every(path => path === `/v1/devices/${selectedDevice}/threads/recent-${selectedDevice}/turns`)).toBe(true);
  } finally { test.close(); }
});

it('isolates navigation by account and relay, and restores it after logging back into the same account', async () => {
  const saved = JSON.stringify({ deviceId: 'pc-b', threadId: 'older-pc-b' });
  const test = await fixture({ userId: 'user-b', storage: { [selectionKey()]: saved, [selectionKey('user-b', 'http://other-relay.test')]: saved } });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    await test.app().relay.logout();
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="账号"]')).not.toBeNull());
    expect(test.dom.window.localStorage.getItem(selectionKey())).toBe(saved);
    test.historyRequests.length = 0;
    await test.app().relay.connect(origin, 'user-a', 'fixture-password');
    await vi.waitFor(() => expect(test.header()).toContain('older-pc-b'));
    expect(test.historyRequests.every(path => path === '/v1/devices/pc-b/threads/older-pc-b/turns')).toBe(true);
  } finally { test.close(); }
});

it.each(['corrupt', 'wrong-shape', 'blocked'])('keeps navigation usable with %s browser storage', async mode => {
  const test = await fixture({ blockedStorage: mode === 'blocked', storage: { [selectionKey()]: mode === 'corrupt' ? '{invalid' : JSON.stringify({ deviceId: 42, threadId: [] }) } });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('selects reasoning effort and model from the combined composer button', async () => {
  const test = await fixture({ controls: { active: false, text: '排队消息', images: [] } });
  try {
    const label = '模型与推理强度：6.1 Sol，极高';
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector(`[aria-label="${label}"]`); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    test.click(label);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('input[aria-label="推理强度"]')).not.toBeNull());
    const slider = test.dom.window.document.querySelector<HTMLInputElement>('input[aria-label="推理强度"]')!;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(slider, '4');
    slider.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    expect(test.commands.filter(command => command.payload.type === 'thread.effort.update')).toHaveLength(0);
    slider.dispatchEvent(new test.dom.window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    await vi.waitFor(() => expect(test.commands.find(command => command.payload.type === 'thread.effort.update')?.payload).toMatchObject({ effort: 'max', expectedEffort: 'xhigh', expectedModel: 'gpt-6.1-sol' }));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="模型与推理强度：6.1 Sol，最高"]')).not.toBeNull());
    test.click('选择模型');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="选择模型 6 Astra"]')).not.toBeNull());
    test.click('选择模型 6 Astra');
    await vi.waitFor(() => expect(test.commands.find(command => command.payload.type === 'thread.model.update')?.payload).toMatchObject({ model: 'gpt-6-astra', expectedModel: 'gpt-6.1-sol' }));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('restores the saved strength when changing effort fails', async () => {
  const test = await fixture({ controls: { active: false, text: '排队消息', images: [], failEffort: true } });
  try {
    const label = '模型与推理强度：6.1 Sol，极高';
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector(`[aria-label="${label}"]`); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    test.click(label);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('input[aria-label="推理强度"]')).not.toBeNull());
    const slider = test.dom.window.document.querySelector<HTMLInputElement>('input[aria-label="推理强度"]')!;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(slider, '4');
    slider.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(slider.getAttribute('aria-valuetext')).toBe('最高'));
    slider.dispatchEvent(new test.dom.window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    await vi.waitFor(() => expect(test.dom.window.document.body.textContent).toContain('stale-settings'));
    await vi.waitFor(() => expect(slider.getAttribute('aria-valuetext')).toBe('极高'));
    expect(test.dom.window.document.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('edits complete queued messages without dropping their attachments and rejects concurrent overwrites', async () => {
  const controls = { active: true, text: '完整消息与末尾内容。'.repeat(1000), images: ['a'.repeat(64)] };
  const test = await fixture({ controls });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="编辑待发送消息"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    test.click('编辑待发送消息');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('textarea[aria-label="编辑待发送消息"]')).not.toBeNull());
    const input = test.dom.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑待发送消息"]')!;
    expect(input.value).toBe(controls.text);
    const original = controls.text;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '编辑后的消息');
    input.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    test.click('保存消息');
    await vi.waitFor(() => expect(test.commands.find(command => command.payload.type === 'turn.queue.update')?.payload).toEqual({ type: 'turn.queue.update', threadId: 'recent-pc-a', queueId: 'queue-1', text: '编辑后的消息', expectedText: original }));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('textarea[aria-label="编辑待发送消息"]')).toBeNull());
    expect(controls.images).toEqual(['a'.repeat(64)]);
    test.click('编辑待发送消息');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑待发送消息"]')?.value).toBe('编辑后的消息'));
    const second = test.dom.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑待发送消息"]')!;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(second, '保留我的草稿');
    second.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    controls.text = '另一客户端的新消息';
    test.click('保存消息');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('已在其他地方修改'));
    expect(second.value).toBe('保留我的草稿');
    expect(controls.text).toBe('另一客户端的新消息');
    expect(test.dom.window.document.body.textContent).not.toContain('侧边聊天');
    expect(test.dom.window.document.body.textContent).not.toContain('关闭排队');
    expect(test.dom.window.document.querySelector('[aria-label="待发送消息更多操作"]')).toBeNull();
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});
