import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { normalizeThread } from '../packages/codex-adapter/src/normalize';
import type { DeviceCatalog, InteractiveRequest, ModelSettings, RemoteCommand } from '../packages/protocol/src/index';
import { permissionPreset, permissionSettings } from '../packages/codex-adapter/src/permissions';

const origin = 'http://selection.test';
const controlVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
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
    plugins: [{ name: 'fixture-file-picker', setup(build) { build.onResolve({ filter: /^\.\/src\/attachment-picker$/ }, () => ({ path: 'picker', namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function pickAttachments() { return window.__pickAttachments(); }', loader: 'js' })); } }],
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
  permissions?: boolean; requests?: InteractiveRequest[];
  storage?: Record<string, string>; userId?: string; devices?: typeof devices; catalogs?: Record<string, DeviceCatalog>;
  delayDevices?: boolean; delayCatalog?: string; blockedStorage?: boolean; blockedThemeStorage?: boolean;
  filePicker?: () => Promise<{ name: string; size: number; mimeType: string; readChunk: (offset: number, length: number) => Promise<string> }[]>;
  controls?: { active: boolean; text: string; images: string[]; failEffort?: boolean };
  paging?: { delay?: boolean; fail?: boolean; exhausted?: boolean };
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
  if (options.permissions) settings.permissions = permissionSettings(permissionPreset('ask', ['/fixture']));
  let pendingRequests = options.requests ?? [];
  if (controls) for (const item of Object.values(current.catalogs)) item.models = ['gpt-6.1-sol', 'gpt-6-astra'].map((model, index) => ({ model, displayName: index ? '6 Astra' : '6.1 Sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'high' }));
  const sockets: { onmessage?: (event: { data: string }) => void }[] = [];
  const deviceGate = gate(), catalogGate = gate(), historyGate = gate();
  const uploadRequests: string[] = []; let uploadedFile: { name: string; size: number; mimeType: string };
  const earlierRequests: string[] = [];
  const historyRequests: string[] = [], commands: RemoteCommand[] = [], errors: unknown[] = [];
  const dom = new JSDOM(`<style>${css}</style><div id="root"></div>`, {
    url: origin, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      Object.assign(window, { AnimationEvent: window.Event });
      window.addEventListener('error', event => errors.push(event.error));
      window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
      Object.assign(window, { __pickAttachments: options.filePicker ?? (async () => []), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, AbortSignal, fetch: async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        if (path === '/health') return response({ version: '8.7.6' });
        if (path.endsWith('/attachments') && init?.method === 'POST') { uploadedFile = JSON.parse(String(init.body)); uploadRequests.push(path); return response({ id: 'f'.repeat(64) }); }
        if (path.includes('/attachments/') && init?.method === 'DELETE') return response({ ok: true });
        if (path.includes('/attachments/') && init?.method === 'PUT') { const data = JSON.parse(String(init.body)); const offset = data.offset + Buffer.from(data.base64, 'base64').length; uploadRequests.push(path); return response({ offset, attachment: { ...uploadedFile, id: 'f'.repeat(64), sha256: 'e'.repeat(64) } }); }
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
          if (options.paging) {
            const cursor = new URL(input).searchParams.get('cursor');
            if (cursor) {
              earlierRequests.push(cursor);
              if (options.paging.delay) await historyGate.promise;
              if (options.paging.fail) return new Response('history-unavailable', { status: 503 });
              return response({ threadId, turns: [{ id: 'older-turn', status: 'completed', truncated: false, items: [{ id: 'older-message', type: 'agentMessage', phase: 'final_answer', text: '自动加载的更早记录', truncated: false }] }], nextCursor: null, generatedAt: 1 });
            }
            return response({ threadId, turns: [], nextCursor: options.paging.exhausted ? null : 'earlier-page', generatedAt: 1 });
          }
          return response({ threadId, turns: [], nextCursor: null, generatedAt: 1 });
        }
        if (deviceId && suffix === 'commands') {
          const command = JSON.parse(String(init?.body)) as RemoteCommand;
          commands.push(command);
          if (!controls && !options.permissions && !options.requests) return response({ commandId: 'fixture-command' });
          let result: Record<string, unknown> = {}, code = 'ok';
          const payload = command.payload;
          if (payload.type === 'thread.effort.update') {
            if (controls?.failEffort) code = 'stale-settings';
            else settings.reasoningEffort = payload.effort;
          }
          if (payload.type === 'thread.model.update') settings.model = payload.model;
          if (payload.type === 'thread.permissions.update') {
            if (settings.permissions?.fingerprint !== payload.expectedPermissions) code = 'stale-permissions';
            else settings.permissions = permissionSettings(permissionPreset(payload.mode, ['/fixture']));
          }
          if (payload.type === 'elicitation.respond') pendingRequests = pendingRequests.filter(r => r.id !== payload.requestId);
          if (payload.type === 'turn.queue.read' && controls) result = { queueId: payload.queueId, text: controls.text, images: controls.images };
          if (payload.type === 'turn.queue.update' && controls) {
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
          runtime: { kind: 'official-desktop-ipc', connected: true, experimental: true, capabilities: { observe: true, startTurn: true, interrupt: true, approvals: true, userInput: true, images: true, attachments: true, collaborationModeUpdate: true, permissionsUpdate: !!options.permissions, mcpApprovals: true } },
          threads: Object.fromEntries((current.catalogs[deviceId]?.threads ?? []).map(thread => [thread.id, { ...normalizeThread({ ...thread, threadRuntimeStatus: { type: controls?.active ? 'active' : 'idle', activeFlags: [] }, turns: [], requests: [] }, 0), ownerAvailable: true,
            ...(controls ? { settings, activeTurnId: controls.active ? 'active-turn' : null, queuedMessages: [{ id: 'queue-1', text: controls.text.slice(0, 1000), imageCount: controls.images.length, createdAt: 1, status: 'queued' }] } : {}),
            ...(options.permissions ? {settings} : {}), requests: pendingRequests,
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
      if (options.blockedThemeStorage) {
        const set = window.Storage.prototype.setItem;
        window.Storage.prototype.setItem = function(key, value) { if (key === 'codexer.control.theme.v1') throw new Error('storage-blocked'); set.call(this, key, value); };
      }
    },
  });
  Object.defineProperties(dom.window.document.documentElement, { clientWidth: { value: 1024 }, clientHeight: { value: 800 } });
  dom.window.eval(javascript);
  const app = () => (dom.window as unknown as { selectionApp: { relay: TestRelay; close(): void } }).selectionApp;
  await vi.waitFor(() => expect(app()).toBeDefined());
  const header = () => dom.window.document.querySelector('[data-testid="conversation-header"]')?.textContent;
  const click = (label: string) => (dom.window.document.querySelector(`[aria-label="${label}"]`) as HTMLElement).click();
  const closeDialog = async (label: string) => {
    const button = dom.window.document.querySelector(`[aria-label="${label}"]`)!;
    click(label);
    // JSDOM does not advance CSS animations; finish the real RN Web fade-out.
    await vi.waitFor(() => {
      let element: Element | null = button;
      while (element && dom.window.getComputedStyle(element).animationDuration !== '250ms') element = element.parentElement;
      expect(element).not.toBeNull(); expect(dom.window.getComputedStyle(element!).pointerEvents).toBe('none');
      element!.dispatchEvent(new dom.window.Event('animationend', { bubbles: true }));
    });
    await vi.waitFor(() => expect(dom.window.document.querySelector(`[aria-label="${label}"]`)).toBeNull());
  };
  const close = () => { deviceGate.release(); catalogGate.release(); historyGate.release(); app().close(); dom.window.close(); };
  return { dom, current, historyRequests, uploadRequests, earlierRequests, commands, errors, app, header, click, closeDialog, close, deviceGate, catalogGate, historyGate };
}

async function pagingFixture(paging: NonNullable<FixtureOptions['paging']>) {
  const test = await fixture({ paging });
  await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
  await vi.waitFor(() => expect(test.historyRequests.length).toBeGreaterThan(0));
  await new Promise(resolve => test.dom.window.requestAnimationFrame(() => test.dom.window.requestAnimationFrame(resolve)));
  const stream = test.dom.window.document.querySelector('[data-testid="conversation-stream"]') as HTMLElement;
  Object.defineProperties(stream, {
    scrollHeight: { configurable: true, value: 2000 },
    offsetHeight: { configurable: true, value: 500 },
    clientHeight: { configurable: true, value: 500 },
  });
  const scroll = async (offset: number) => {
    // A physical scroll carries input intent. Layout-only notifications must
    // no longer masquerade as an unmarked scrollbar drag.
    stream.dispatchEvent(new test.dom.window.KeyboardEvent('keydown', { bubbles: true, key: offset <= stream.scrollTop ? 'ArrowUp' : 'ArrowDown' }));
    stream.scrollTop = offset;
    stream.dispatchEvent(new test.dom.window.Event('scroll', { bubbles: true }));
    // React Native Web publishes its final position after a 100ms scroll debounce.
    await new Promise(resolve => test.dom.window.setTimeout(resolve, 120));
  };
  const wheel = (deltaY: number) => stream.dispatchEvent(new test.dom.window.WheelEvent('wheel', { bubbles: true, deltaY }));
  return { ...test, stream, scroll, wheel };
}

it('keeps the real conversation list at the true end after tall content and delayed resize scrolls', async () => {
  const test = await pagingFixture({ exhausted: true });
  try {
    let height = 2000;
    Object.defineProperty(test.stream, 'scrollHeight', { configurable: true, get: () => height });
    const scrollToEnd = vi.fn(({ top }: { top: number }) => { test.stream.scrollTop = Math.max(0, Math.min(top, height - 500)); });
    Object.defineProperty(test.stream, 'scroll', { configurable: true, value: scrollToEnd });
    await test.scroll(1500);
    scrollToEnd.mockClear();
    // A layout-only callback reports an older, smaller offset while a card
    // much taller than the viewport has already been inserted.
    height = 8000;
    test.stream.scrollTop = 1300;
    test.stream.dispatchEvent(new test.dom.window.Event('scroll'));
    await vi.waitFor(() => expect(test.stream.scrollTop).toBe(7500));
    expect(scrollToEnd).toHaveBeenCalledWith(expect.objectContaining({ top: 8000 }));
    height = 20000;
    test.stream.scrollTop = 1200;
    test.stream.dispatchEvent(new test.dom.window.Event('scroll'));
    await vi.waitFor(() => expect(test.stream.scrollTop).toBe(19500));
    // Explicit upward input must win even over a delayed end-position event.
    test.wheel(-80);
    scrollToEnd.mockClear();
    test.stream.scrollTop = 19499;
    test.stream.dispatchEvent(new test.dom.window.Event('scroll'));
    await new Promise(resolve => test.dom.window.setTimeout(resolve, 150));
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(test.stream.scrollTop).toBe(19499);
  } finally { test.close(); }
});

it('automatically loads earlier history on upward scrolling near the top and deduplicates while loading', async () => {
  const test = await pagingFixture({ delay: true });
  try {
    expect(test.earlierRequests).toEqual([]);
    await test.scroll(400);
    test.wheel(-80);
    await test.scroll(30);
    await vi.waitFor(() => expect(test.earlierRequests).toEqual(['earlier-page']));
    test.wheel(-80);
    await test.scroll(0);
    test.wheel(-80);
    expect(test.earlierRequests).toHaveLength(1);
    test.historyGate.release();
    await vi.waitFor(() => expect(test.dom.window.document.body.textContent).toContain('自动加载的更早记录'));
    expect(test.dom.window.document.querySelector('[aria-label="加载更早消息"]')).toBeNull();
    test.wheel(-80);
    expect(test.earlierRequests).toHaveLength(1);
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('loads on an upward gesture while already at the top even if no new scroll event is emitted', async () => {
  const test = await pagingFixture({});
  try {
    await test.scroll(0);
    test.wheel(80);
    expect(test.earlierRequests).toEqual([]);
    test.wheel(-80);
    await vi.waitFor(() => expect(test.earlierRequests).toEqual(['earlier-page']));
    await vi.waitFor(() => expect(test.dom.window.document.body.textContent).toContain('自动加载的更早记录'));
  } finally { test.close(); }
});

it('allows another upward gesture to retry a failed history request and does not load without a cursor', async () => {
  const test = await pagingFixture({ fail: true });
  try {
    await test.scroll(0);
    test.wheel(-80);
    await vi.waitFor(() => expect(test.dom.window.document.body.textContent).toContain('HTTP 503'));
    test.wheel(-80);
    await vi.waitFor(() => expect(test.earlierRequests).toEqual(['earlier-page', 'earlier-page']));
  } finally { test.close(); }
  const exhausted = await pagingFixture({ exhausted: true });
  try {
    await exhausted.scroll(0);
    exhausted.wheel(-80);
    await new Promise(resolve => exhausted.dom.window.requestAnimationFrame(resolve));
    expect(exhausted.earlierRequests).toEqual([]);
  } finally { exhausted.close(); }
});

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


it('uses centered settings and operation dialogs, shows server and loaded-control versions, and puts project creation beside its heading', async () => {
  const test = await fixture({ controls: { active: false, text: '', images: [] } });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    const add = test.dom.window.document.querySelector('[aria-label="新建项目"]')!;
    expect(add.textContent).toBe(''); expect(add.parentElement?.textContent).toBe('项目');
    test.click('连接设置');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="dialog-card"]')?.textContent).toContain('8.7.6'));
    const card = test.dom.window.document.querySelector<HTMLElement>('[data-testid="dialog-card"]')!;
    expect(card.textContent).toContain('服务器版本'); expect(card.textContent).toContain('控制端版本');
    expect(card.textContent).toContain(controlVersion);
    expect(test.dom.window.getComputedStyle(card.parentElement!).justifyContent).toBe('center');
    await test.closeDialog('关闭设置');
    test.click('工作模式：默认');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="dialog-card"]')?.textContent).toContain('Plan Mode'));
    await test.closeDialog('关闭工作模式');
    test.click('管理会话 recent-pc-a');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="dialog-card"]')?.textContent).toContain('归档'));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('switches three skins through settings without remounting the composer or losing its draft', async () => {
  const test = await fixture({ controls: { active: false, text: '', images: [] } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    const input = test.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="给 Codex 发送消息"]')!;
    const text = '保留草稿\n第二行\n第三行';
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    test.click('连接设置');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="radiogroup"]')).not.toBeNull());
    expect(test.dom.window.document.querySelectorAll('[role="radiogroup"] [role="radio"]')).toHaveLength(3);
    for (const [label, id, color] of [['暖白纸张', 'paper', '#faf7f1'], ['暖棕暗色', 'warm-dark', '#262322'], ['默认', 'default', '#ffffff']]) {
      test.click(label!);
      await vi.waitFor(() => expect(test.dom.window.document.documentElement.dataset.controlTheme).toBe(id));
      expect(test.dom.window.document.documentElement.style.getPropertyValue('--control-bg')).toBe(color);
      expect(test.dom.window.document.querySelector(`[aria-label="${label}"]`)!.getAttribute('aria-checked')).toBe('true');
      await vi.waitFor(() => expect(test.dom.window.localStorage.getItem('codexer.control.theme.v1')).toBe(id));
      expect(test.dom.window.document.querySelector('[aria-label="给 Codex 发送消息"]')).toBe(input);
      expect(input.value).toBe(text);
      expect(test.header()).toContain('recent-pc-a');
    }
    expect(test.commands).toEqual([]); expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it.each(['paper', 'warm-dark', 'unknown'])('restores the saved skin safely (%s)', async id => {
  const test = await fixture({ storage: { 'codexer.control.theme.v1': id } });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    expect(test.dom.window.document.documentElement.dataset.controlTheme).toBe(id === 'unknown' ? 'default' : id);
    expect(test.dom.window.document.documentElement.style.colorScheme).toBe(id === 'warm-dark' ? 'dark' : 'light');
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('keeps a selected skin usable and explains a failed preference save', async () => {
  const test = await fixture({ blockedThemeStorage: true });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    test.click('连接设置');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="暖棕暗色"]')).not.toBeNull());
    test.click('暖棕暗色');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('偏好未能保存'));
    expect(test.dom.window.document.documentElement.dataset.controlTheme).toBe('warm-dark');
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('keeps one attachment and model button after restoring, reopening menus and switching conversations or devices', async () => {
  const test = await fixture({ controls: { active: false, text: '', images: [] } });
  const document = test.dom.window.document;
  const expectSingleToolbar = () => {
    expect(document.querySelectorAll('[aria-label="添加附件"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-label^="模型与推理强度："]')).toHaveLength(1);
  };
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    expectSingleToolbar();
    for (const threadId of ['older-pc-a', 'recent-pc-a', 'older-pc-a']) {
      test.click('添加附件');
      await vi.waitFor(() => expect(document.querySelector('[aria-label="添加文件"]')).not.toBeNull());
      await test.closeDialog('关闭菜单');
      expectSingleToolbar();
      test.click('模型与推理强度：6.1 Sol，极高');
      await vi.waitFor(() => expect(document.querySelector('input[aria-label="推理强度"]')).not.toBeNull());
      await test.closeDialog('关闭菜单');
      const row = [...document.querySelectorAll('[role="button"]')].find(element => element.textContent === threadId) as HTMLElement;
      row.click();
      await vi.waitFor(() => expect(test.header()).toContain(threadId));
      expectSingleToolbar();
    }
    for (const [from, to] of [['pc-a', 'pc-b'], ['pc-b', 'pc-a']]) {
      test.click(`切换 PC Agent，当前：${from}，在线`);
      await vi.waitFor(() => expect(document.querySelector(`[aria-label="选择设备 ${to}，在线"]`)).not.toBeNull());
      test.click(`选择设备 ${to}，在线`);
      await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing[to!]).toBe(false));
      await vi.waitFor(() => expect(test.header()).toContain(`recent-${to}`));
      expectSingleToolbar();
    }
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('opens attachment actions from plus and sends a file-only message after upload', async () => {
  const bytes = Buffer.from('附件内容');
  const test = await fixture({ controls: { active: false, text: '', images: [] }, filePicker: async () => [{ name: '说明.txt', size: bytes.length, mimeType: 'text/plain', readChunk: async (offset, length) => bytes.subarray(offset, offset + length).toString('base64') }] });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    test.click('添加附件');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加文件"]')).not.toBeNull());
    expect(test.dom.window.document.body.textContent).toContain('照片');
    test.click('添加文件');
    await vi.waitFor(() => expect(test.uploadRequests).toHaveLength(2));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    test.click('发送消息');
    await vi.waitFor(() => expect(test.commands.some(c => c.payload.type === 'turn.start' && c.payload.text === '' && c.payload.attachments?.[0] === 'f'.repeat(64))).toBe(true));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="移除文件 说明.txt"]')).toBeNull());
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('discards a late file selection when the user has switched devices', async () => {
  const selection = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, filePicker: async () => { await selection.promise; return [{ name: 'old.txt', size: 1, mimeType: 'text/plain', readChunk: async () => 'YQ==' }]; } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    test.click('添加附件'); await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加文件"]')).not.toBeNull()); test.click('添加文件');
    test.click('切换 PC Agent，当前：pc-a，在线'); await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="选择设备 pc-b，在线"]')).not.toBeNull()); test.click('选择设备 pc-b，在线');
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-b')); selection.release();
    await new Promise(resolve => setTimeout(resolve, 50)); expect(test.uploadRequests).toEqual([]);
    expect(test.dom.window.document.querySelector('[aria-label="移除文件 old.txt"]')).toBeNull(); expect(test.errors).toEqual([]);
  } finally { selection.release(); test.close(); }
});

it('cancels a chunk read when switching conversations and cannot send an unfinished file', async () => {
  const chunk = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, filePicker: async () => [{ name: 'slow.txt', size: 1, mimeType: 'text/plain', readChunk: async () => { await chunk.promise; return 'YQ=='; } }] });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    test.click('添加附件'); await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加文件"]')).not.toBeNull()); test.click('添加文件');
    await vi.waitFor(() => expect(test.uploadRequests).toHaveLength(1));
    expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).toBe('true');
    const row = [...test.dom.window.document.querySelectorAll('[role="button"]')].find(element => element.textContent === 'older-pc-a') as HTMLElement;
    row.click(); await vi.waitFor(() => expect(test.header()).toContain('older-pc-a'));
    chunk.release(); await new Promise(resolve => setTimeout(resolve, 50));
    expect(test.uploadRequests).toHaveLength(1); expect(test.commands.some(command => command.payload.type === 'turn.start')).toBe(false);
    expect(test.dom.window.document.querySelector('[aria-label="移除文件 slow.txt"]')).toBeNull(); expect(test.errors).toEqual([]);
  } finally { chunk.release(); test.close(); }
});

it('changes real App permission controls only after explicit full-access confirmation', async () => {
  const test = await fixture({permissions: true});
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="会话权限：请求批准"]')).not.toBeNull());
    test.click('会话权限：请求批准');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="权限：完全访问"]')).not.toBeNull());
    test.click('权限：完全访问');
    expect(test.commands.filter(c => c.payload.type === 'thread.permissions.update')).toHaveLength(0);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="确认使用完全访问"]')).not.toBeNull());
    test.click('确认使用完全访问');
    await vi.waitFor(() => expect(test.commands.filter(c => c.payload.type === 'thread.permissions.update')).toHaveLength(1));
    const update = test.commands.find(c => c.payload.type === 'thread.permissions.update')!;
    expect(update.payload).toMatchObject({type: 'thread.permissions.update', mode: 'full-access', threadId: 'recent-pc-a'});
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="会话权限：完全访问"]')).not.toBeNull());
    expect(test.errors).toEqual([]);
  } finally {test.close();}
});

it.each(['browser', 'computer'] as const)('answers %s access requests from the actual App, including standalone browser requests', async kind => {
  const request: InteractiveRequest = {id: 'access-1', kind: 'mcpElicitation', turnId: kind === 'browser' ? null : 'active-turn', details: {}, detailsTruncated: false, respondable: true,
    approval: {kind, target: kind === 'browser' ? 'http://localhost:5173' : 'Fixture App', scopes: kind === 'browser' ? ['once', 'always'] : ['once', 'session', 'always']}};
  const test = await fixture({requests: [request], controls: {active: true, text: '', images: []}});
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    const label = kind === 'browser' ? '始终允许此网站' : '允许本次会话';
    const find = () => [...test.dom.window.document.querySelectorAll('[role="button"]')].find(e => e.textContent === label) as HTMLElement | undefined;
    await vi.waitFor(() => expect(find()).toBeDefined());
    const button = find()!; button.click(); button.click();
    await vi.waitFor(() => expect(test.commands.filter(c => c.payload.type === 'elicitation.respond')).toHaveLength(1));
    expect(test.commands.find(c => c.payload.type === 'elicitation.respond')!.payload).toEqual({type: 'elicitation.respond', threadId: 'recent-pc-a', turnId: request.turnId, requestId: 'access-1', decision: 'accept', scope: kind === 'browser' ? 'always' : 'session'});
    await vi.waitFor(() => expect(find()).toBeUndefined());
    expect(test.errors).toEqual([]);
  } finally {test.close();}
});
