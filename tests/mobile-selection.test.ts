import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { normalizeThread } from '../packages/codex-adapter/src/normalize';
import type { DeviceCatalog, HistoryTurn, InteractiveRequest, ModelSettings, RemoteCommand, RemoteSubAgent } from '../packages/protocol/src/index';
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
    plugins: [{ name: 'fixture-pickers', setup(build) {
      build.onResolve({ filter: /^\.\/src\/attachment-picker$/ }, () => ({ path: 'files', namespace: 'fixture' }));
      build.onResolve({ filter: /^\.\/src\/media-picker$/ }, () => ({ path: 'media', namespace: 'fixture' }));
      build.onResolve({ filter: /^expo-image-picker$/ }, () => ({ path: 'images', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'files' ? 'export async function pickAttachments(kind) { return window.__pickAttachments(kind); }' : path === 'media' ? 'export async function pickMedia(options) { const photos = options.imageSlots ? await window.__pickImages() : {assets:[]}; return {images:photos.assets ?? [],videos:options.videoSlots ? await window.__pickAttachments("video") : []}; }' : 'export async function launchImageLibraryAsync() { return window.__pickImages(); } export const launchCameraAsync = launchImageLibraryAsync; export async function requestCameraPermissionsAsync() { return {granted:true}; }', loader: 'js' }));
    } }],
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
  permissions?: boolean; requests?: InteractiveRequest[]; legacyAgent?: boolean;
  storage?: Record<string, string>; userId?: string; devices?: typeof devices; catalogs?: Record<string, DeviceCatalog>;
  delayDevices?: boolean; delayCatalog?: string; blockedStorage?: boolean; blockedThemeStorage?: boolean;
  filePicker?: (kind?: 'video') => Promise<{ name: string; size: number; mimeType: string; readChunk: (offset: number, length: number) => Promise<string> }[]>;
  imagePicker?: () => Promise<{ canceled: boolean; assets: { uri: string; fileName: string; width: number; height: number; mimeType: string; base64: string }[] }>;
  imageUpload?: { wait?: Promise<void>; fail?: boolean };
  submission?: { wait?: Promise<void>; fail?: boolean };
  controls?: { active: boolean; text: string; images: string[]; failEffort?: boolean; failModel?: boolean; failPermissions?: boolean; interrupted?: boolean; unknownTurn?: boolean };
  paging?: { delay?: boolean; fail?: boolean; exhausted?: boolean };
  removal?: { confirmed: boolean; fail?: boolean; calls: string[] };
  clipboard?: { values: string[]; fail?: boolean };
  agentVersions?: Record<string, string>;
  subAgents?: RemoteSubAgent[];
  review?: { turns: HistoryTurn[]; mode?: 'plan' | 'default'; failMode?: boolean; fileError?: string; fileWait?: Promise<void>; fileText?: string; fileCalls?: {url: string; signal?: AbortSignal | null}[] };
  answerSubmission?: { fail?: boolean; wait?: Promise<void> };
  notification?: { enabled: boolean; fail?: boolean; wait?: Promise<void>; updates: { path: string; enabled: boolean }[] };
};
type TestRelay = {
  getSnapshot(): { userId: string | null; devicesReady: boolean; phase: string; syncing: Record<string, boolean> };
  connect(url: string, username: string, password: string): Promise<void>;
  logout(): Promise<void>; loadCatalog(deviceId: string): Promise<void>; refreshDevices(): Promise<void>;
};
async function fixture(options: FixtureOptions = {}) {
  const current = { userId: options.userId ?? 'user-a', devices: options.devices ?? devices, catalogs: options.catalogs ?? Object.fromEntries(devices.map(device => [device.id, catalog(device.id)])) };
  const controls = options.controls;
  const settings: ModelSettings = { model: 'gpt-6.1-sol', modelProvider: 'fixture', reasoningEffort: 'xhigh', collaborationMode: options.review?.mode ?? 'default' };
  if (options.permissions) settings.permissions = permissionSettings(permissionPreset('ask', ['/fixture']));
  let pendingRequests = options.requests ?? [];
  if (controls) for (const item of Object.values(current.catalogs)) item.models = ['gpt-6.1-sol', 'gpt-6-astra'].map((model, index) => ({ model, displayName: index ? '6 Astra' : '6.1 Sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'high' }));
  const sockets: { onmessage?: (event: { data: string }) => void }[] = [];
  const deviceGate = gate(), catalogGate = gate(), historyGate = gate();
  const uploadRequests: string[] = []; let uploadedFile: { name: string; size: number; mimeType: string };
  const imageUploads: { path: string; name: string; id: string }[] = [];
  const earlierRequests: string[] = [];
  const historyRequests: string[] = [], commands: RemoteCommand[] = [], errors: unknown[] = [];
  let refresh!: () => void;
  const dom = new JSDOM(`<style>${css}</style><div id="root"></div>`, {
    url: origin, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      Object.assign(window, { AnimationEvent: window.Event, TextDecoder });
      window.HTMLElement.prototype.getBoundingClientRect = function() { return { x:0,y:0,left:0,top:0,right:390,bottom:800,width:390,height:800,toJSON(){} }; };

      if (options.clipboard) Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (value: string) => {
        if (options.clipboard!.fail) throw new Error('clipboard-denied');
        options.clipboard!.values.push(value);
      } } });
      window.confirm = () => options.removal?.confirmed ?? false;
      window.addEventListener('error', event => errors.push(event.error));
      window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
      Object.assign(window, { __pickAttachments: options.filePicker ?? (async () => []), __pickImages: options.imagePicker ?? (async () => ({ canceled: true, assets: [] })), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, AbortSignal, fetch: async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        if (path === '/health') return response({ version: '8.7.6' });
        if (path.endsWith('/images') && init?.method === 'POST') {
          const { name } = JSON.parse(String(init.body)), id = (imageUploads.length + 1).toString(16).padStart(64, '0');
          imageUploads.push({ path, name, id });
          await options.imageUpload?.wait;
          if (options.imageUpload?.fail) return new Response(JSON.stringify({ error: 'image-upload-failed' }), { status: 503 });
          return response({ id, name });
        }
        if (path.endsWith('/attachments') && init?.method === 'POST') { uploadedFile = JSON.parse(String(init.body)); uploadRequests.push(path); return response({ id: 'f'.repeat(64) }); }
        if (path.includes('/attachments/') && init?.method === 'DELETE') return response({ ok: true });
        if (path.includes('/attachments/') && init?.method === 'PUT') { const data = JSON.parse(String(init.body)); const offset = data.offset + Buffer.from(data.base64, 'base64').length; uploadRequests.push(path); return response({ offset, attachment: { ...uploadedFile, id: 'f'.repeat(64), sha256: 'e'.repeat(64) } }); }
        if (path === '/v1/auth/login') { current.userId = JSON.parse(String(init?.body)).username; return response({ session: 'fixture-token' }); }
        if (path === '/v1/auth/logout' || path === '/v1/auth/active') return response({});
        if (path === '/v1/me') return response({ role: 'user', userId: current.userId });
        if (path === '/v1/devices') { if (options.delayDevices) await deviceGate.promise; return response({ devices: current.devices }); }
        if (path.endsWith('/data') && init?.method === 'DELETE' && options.removal) {
          options.removal.calls.push(path);
          if (options.removal.fail) return new Response(JSON.stringify({error:'device-online'}), {status:409});
          current.devices = current.devices.filter(device => device.id !== path.split('/')[3]);
          return response({removed:true});
        }
        if (path === '/v1/ws/tickets') return response({ ticket: 'fixture-ticket' });
        if (path === '/v1/weixin') return response({ enabled: false, allEnabled: false, available: false, bound: false });
        if (path.endsWith('/weixin-notification')) {
          if (init?.method === 'PUT' && options.notification) {
            const { enabled } = JSON.parse(String(init.body));
            options.notification.updates.push({ path, enabled });
            await options.notification.wait;
            if (options.notification.fail) return new Response(JSON.stringify({ error: 'save-failed' }), { status: 503 });
            options.notification.enabled = enabled;
          }
          return response({ enabled: options.notification?.enabled ?? false, allEnabled: false, available: !!options.notification, bound: !!options.notification });
        }
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
          return response({ threadId, turns: options.review?.turns ?? [], nextCursor: null, generatedAt: 1 });
        }
        if (deviceId && suffix?.includes('/files/')) {
          options.review?.fileCalls?.push({url: String(input), signal: init?.signal});
          const text = options.review?.fileText ?? 'const value = 42;\nexport { value };\n';
          if (suffix.endsWith('/info')) return response({name: '示例.ts', size: Buffer.byteLength(text), version: 'a'.repeat(64)});
          if (suffix.endsWith('/content')) {
            await options.review?.fileWait;
            return options.review?.fileError ? new Response(JSON.stringify({error: options.review.fileError}), {status:409}) : new Response(text);
          }
        }
        if (deviceId && suffix === 'commands') {
          const command = JSON.parse(String(init?.body)) as RemoteCommand;
          commands.push(command);
          if (!controls && !options.permissions && !options.requests && !options.review) return response({ commandId: 'fixture-command' });
          let result: Record<string, unknown> = {}, code = 'ok';
          const payload = command.payload;
          if (payload.type === 'input.respond' || payload.type === 'approval.respond') { await options.answerSubmission?.wait; if (options.answerSubmission?.fail) code = 'request-rejected'; }
          if (payload.type === 'thread.mode.update') { if (options.review?.failMode) code = 'mode-rejected'; else settings.collaborationMode = payload.mode; }
          if (payload.type === 'thread.rename') {
            const thread = current.catalogs[deviceId]?.threads.find(thread => thread.id === payload.threadId);
            if (thread) thread.title = payload.name;
          }
          if (payload.type === 'thread.archive') {
            const thread = current.catalogs[deviceId]?.threads.find(thread => thread.id === payload.threadId);
            if (thread) thread.archived = true;
          }
          if (payload.type === 'thread.delete') {
            const catalog = current.catalogs[deviceId];
            if (catalog) catalog.threads = catalog.threads.filter(thread => thread.id !== payload.threadId);
          }
          if (payload.type === 'turn.start' || payload.type === 'turn.queue' || payload.type === 'turn.steer' || payload.type === 'turn.continue') {
            await options.submission?.wait;
            if (options.submission?.fail) code = 'turn-start-rejected';
          }
          if (code === 'ok' && controls && payload.type === 'turn.interrupt') { controls.active = false; controls.interrupted = true; }
          if (code === 'ok' && controls && payload.type === 'turn.continue') { controls.active = true; controls.interrupted = false; }
          if (payload.type === 'thread.effort.update') {
            if (controls?.failEffort) code = 'stale-settings';
            else settings.reasoningEffort = payload.effort;
          }
          if (payload.type === 'thread.model.update') { if (controls?.failModel) code = 'stale-settings'; else settings.model = payload.model; }
          if (payload.type === 'thread.permissions.update') {
            if (controls?.failPermissions || settings.permissions?.fingerprint !== payload.expectedPermissions) code = 'stale-permissions';
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
          agentVersion: options.agentVersions?.[deviceId],
          runtime: { kind: 'official-desktop-ipc', connected: true, experimental: true, capabilities: { observe: true, startTurn: true, interrupt: true, continueTurn: !options.legacyAgent, activeSettingsUpdate: !options.legacyAgent, approvals: true, userInput: true, images: true, modelUpdate: true, effortUpdate: true, ...(!options.legacyAgent ? { maxImages: 20, maxVideoBytes: 512 * 1024 * 1024 } : {}), attachments: true, collaborationModeUpdate: true, permissionsUpdate: !!options.permissions, mcpApprovals: true, subAgents: !!options.subAgents } },
          threads: Object.fromEntries((current.catalogs[deviceId]?.threads ?? []).map(thread => [thread.id, { ...normalizeThread({ ...thread, threadRuntimeStatus: { type: controls?.active ? 'active' : 'idle', activeFlags: [] }, turns: [], requests: [] }, 0), ownerAvailable: true,
            ...(controls ? { settings, activeTurnId: controls.active && !controls.unknownTurn ? 'active-turn' : null, turns: controls.interrupted ? [{ id: 'active-turn', status: 'interrupted', items: [], plan: [], diff: '', truncated: false }] : [], queuedMessages: [{ id: 'queue-1', text: controls.text.slice(0, 1000), imageCount: controls.images.length, createdAt: 1, status: 'queued' }] } : {}),
            ...(options.permissions || options.review ? {settings} : {}), ...(options.review ? {turns: options.review.turns.map(turn => ({...turn, plan:[], diff:''}))} : {}), requests: pendingRequests, subAgents: thread.id === 'recent-pc-a' ? options.subAgents : undefined,
          }])) };
      }
      refresh = () => { for (const socket of sockets) for (const device of current.devices) { socket.onmessage?.({data:JSON.stringify({type:'device.presence',deviceId:device.id,online:device.online})}); socket.onmessage?.({data:JSON.stringify({type:'device.snapshot',snapshot:snapshot(device.id)})}); } };
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
        window.Storage.prototype.setItem = function(key, value) { if (key === 'codexer.control.appearance.v2') throw new Error('storage-blocked'); set.call(this, key, value); };
      }
    },
  });
  Object.defineProperties(dom.window.document.documentElement, { clientWidth: { value: 1024 }, clientHeight: { value: 800 } });
  dom.window.eval(javascript);
  const app = () => (dom.window as unknown as { selectionApp: { relay: TestRelay; close(): void } }).selectionApp;
  await vi.waitFor(() => expect(app()).toBeDefined());
  const header = () => dom.window.document.querySelector('[data-testid="conversation-header"]')?.textContent;
  const click = async (label: string) => {
    // RN Web refreshes press handlers in passive effects after the DOM changes.
    // Let the browser finish the frame before starting the next interaction.
    await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve()));
    const button = dom.window.document.querySelector(`[aria-label="${label}"]`) as HTMLElement;
    // A real click starts a new press. Selection-based clipboard fallback can
    // cancel the prior RN Web responder; click() alone never resets that state.
    button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
    button.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    button.click();
  };
  const closeDialog = async (label: string) => {
    const button = dom.window.document.querySelector(`[aria-label="${label}"]`)!;
    await click(label);
    if (label === '关闭面板' || label === '关闭模型面板') {
      await vi.waitFor(() => expect(dom.window.document.querySelector(`[aria-label="${label}"]`)).toBeNull());
      return;
    }
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
  return { dom, current, historyRequests, uploadRequests, imageUploads, earlierRequests, commands, errors, app, header, click, closeDialog, close, deviceGate, catalogGate, historyGate, refresh };
}

async function pagingFixture(paging: NonNullable<FixtureOptions['paging']>, options: FixtureOptions = {}) {
  const test = await fixture({ ...options, paging });
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

it.each(['start', 'steer', 'continue'] as const)('restores bottom following on %s, then lets the reader pause during the pending request', async action => {
  const submission = gate();
  const test = await pagingFixture({ exhausted: true }, {
    controls: { active: action === 'steer', interrupted: action === 'continue', text: '', images: [] },
    submission: { wait: submission.promise },
  });
  try {
    let height = 2000;
    Object.defineProperty(test.stream, 'scrollHeight', { configurable: true, get: () => height });
    const scrollToEnd = vi.fn(({ top }: { top: number }) => { test.stream.scrollTop = Math.max(0, Math.min(top, height - 500)); });
    Object.defineProperty(test.stream, 'scroll', { configurable: true, value: scrollToEnd });
    await test.scroll(1500);
    test.wheel(-40);
    await test.scroll(1460);
    scrollToEnd.mockClear();
    if (action !== 'continue') writeDraft(test, '发送后继续跟随新回复');
    const label = action === 'start' ? '发送消息' : action === 'steer' ? '发送引导消息' : '继续任务';
    await vi.waitFor(() => expect(test.dom.window.document.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-disabled')).not.toBe('true'));
    await test.click(label);
    await vi.waitFor(() => expect(test.commands.some(command => command.payload.type === `turn.${action}`)).toBe(true));
    await vi.waitFor(() => expect(test.stream.scrollTop).toBe(1500));
    height = 2600;
    test.stream.dispatchEvent(new test.dom.window.Event('scroll'));
    await vi.waitFor(() => expect(test.stream.scrollTop).toBe(2100));
    // Sending restores follow once. A later response must not undo the user's
    // decision to read earlier output while the command is still pending.
    test.wheel(-120);
    await test.scroll(1900);
    scrollToEnd.mockClear();
    submission.release();
    await vi.waitFor(() => expect(composer(test).value).toBe(''));
    height = 3000;
    test.stream.dispatchEvent(new test.dom.window.Event('scroll'));
    await new Promise(resolve => test.dom.window.setTimeout(resolve, 180));
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(test.stream.scrollTop).toBe(1900);
    expect(test.errors).toEqual([]);
  } finally { submission.release(); test.close(); }
});

it.each(['completed', 'inProgress'] as const)('preserves selected reply text through background sync and timer updates (%s)', async status => {
  const turn: HistoryTurn = { id: 'active-turn', status, truncated: false, startedAtMs: Date.now() - 10000,
    items: [{ id: 'selected-reply', type: 'agentMessage', phase: status === 'inProgress' ? 'commentary' : 'final_answer', text: '保留选中的文字，后台同步不应清除选区。', truncated: false }] };
  const test = await fixture({ controls: { active: status === 'inProgress', text: '', images: [] }, review: { turns: [turn] } });
  try {
    const document = test.dom.window.document;
    await vi.waitFor(() => expect(document.querySelector('.codexer-markdown p')?.textContent).toBe(turn.items[0]!.text));
    await new Promise(resolve => test.dom.window.requestAnimationFrame(() => test.dom.window.requestAnimationFrame(resolve)));
    const paragraph = document.querySelector('.codexer-markdown p')!, node = paragraph.firstChild!;
    const selection = test.dom.window.getSelection()!, range = document.createRange();
    range.setStart(node, 2); range.setEnd(node, 8); selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString();
    test.refresh();
    await new Promise(resolve => test.dom.window.setTimeout(resolve, 1150));
    expect(document.querySelector('.codexer-markdown p')).toBe(paragraph);
    expect(selection.toString()).toBe(selected);
    expect(selection.anchorNode).toBe(node);
    expect(selection.anchorOffset).toBe(2); expect(selection.focusOffset).toBe(8);
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

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

it('lets an idle conversation leave the bottom over code/images without a scroll-to-end feedback loop', async () => {
  const test = await pagingFixture({ exhausted: true });
  try {
    const scrollToEnd = vi.fn(({ top }: { top: number }) => { test.stream.scrollTop = Math.min(top, 1500); });
    Object.defineProperty(test.stream, 'scroll', { configurable: true, value: scrollToEnd });
    await test.scroll(1500);
    const code = test.dom.window.document.createElement('pre');
    code.dataset.drawerSwipe = 'ignore'; code.textContent = 'Idle code'; test.stream.append(code);
    scrollToEnd.mockClear();
    for (const offset of [1490, 1460, 1300]) {
      code.dispatchEvent(new test.dom.window.WheelEvent('wheel', { bubbles: true, deltaY: -30 }));
      test.stream.scrollTop = offset; test.stream.dispatchEvent(new test.dom.window.Event('scroll'));
      await new Promise(resolve => test.dom.window.setTimeout(resolve, 130));
      expect(test.stream.scrollTop).toBe(offset);
    }
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(test.dom.window.document.querySelector('[aria-label="滚动到会话底部"]')).not.toBeNull();
    await test.click('滚动到会话底部');
    await vi.waitFor(() => expect(test.stream.scrollTop).toBe(1500));
    scrollToEnd.mockClear();
    // An offset-only callback (wheel/accessibility input or late native event)
    // must not drive a settled list straight back to the bottom.
    test.stream.scrollTop = 1490; test.stream.dispatchEvent(new test.dom.window.Event('scroll'));
    await new Promise(resolve => test.dom.window.setTimeout(resolve, 130));
    expect(scrollToEnd).not.toHaveBeenCalled();
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

it('manages offline devices with confirmation, removes the current selection and keeps online PCs', async () => {
  const removal = {confirmed:false,calls:[] as string[]};
  const test = await fixture({removal,devices:devices.map(device=>({...device,online:device.id==='pc-a'})),storage:{[selectionKey()]:JSON.stringify({deviceId:'pc-b',threadId:'older-pc-b'})}});
  try {
    await vi.waitFor(()=>expect(test.header()).toContain('older-pc-b'));
    await test.click('切换 PC Agent，当前：pc-b，离线');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="管理设备"]')).not.toBeNull());await test.click('管理设备');
    await vi.waitFor(()=>expect(test.dom.window.document.body.textContent).toContain('在线不可删除'));
    expect(test.dom.window.document.querySelector('[aria-label="删除离线设备 pc-a（pc-a）"]')).toBeNull();
    await test.click('删除离线设备 pc-b（pc-b）');await new Promise(resolve=>setTimeout(resolve,50));
    expect(removal.calls).toEqual([]);expect(test.header()).toContain('older-pc-b');
    removal.confirmed = true;await test.click('删除离线设备 pc-b（pc-b）');
    await vi.waitFor(()=>expect(removal.calls).toEqual(['/v1/devices/pc-b/data']));
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="选择设备 pc-b，离线"]')).toBeNull());
    await vi.waitFor(()=>expect(test.header()).toContain('recent-pc-a'));
    expect(test.dom.window.document.body.textContent).toContain('1 台设备 · 1 台在线');
    expect(test.errors).toEqual([]);
  } finally {test.close();}
});

it('leaves the device in the list and shows a useful failure if it reconnects during confirmation', async () => {
  const removal={confirmed:true,fail:true,calls:[] as string[]};
  const test=await fixture({removal,devices:devices.map(device=>({...device,online:false}))});
  try{
    await vi.waitFor(()=>expect(test.header()).toContain('recent-pc-a'));
    await test.click('切换 PC Agent，当前：pc-a，离线');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="管理设备"]')).not.toBeNull());await test.click('管理设备');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="删除离线设备 pc-b（pc-b）"]')).not.toBeNull());await test.click('删除离线设备 pc-b（pc-b）');
    await vi.waitFor(()=>expect(test.dom.window.document.body.textContent).toContain('设备已上线，请等待离线后再删除'));
    expect(test.current.devices).toHaveLength(2);
    expect(test.dom.window.document.querySelector('[aria-label="选择设备 pc-b，离线"]')).not.toBeNull();
    expect(test.errors).toEqual([]);
  }finally{test.close();}
});

it('remembers an explicit device switch even while its catalog is still loading', async () => {
  const test = await fixture({ delayCatalog: 'pc-b' });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    await test.click('切换 PC Agent，当前：pc-a，在线');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="选择设备 pc-b，在线"]')).not.toBeNull());
    await test.click('选择设备 pc-b，在线');
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

it.each([false, true])('selects reasoning effort and model from the combined composer button (active=%s)', async active => {
  const test = await fixture({ controls: { active, text: '排队消息', images: [] } });
  try {
    const label = '模型与推理强度：6.1 Sol，极高';
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector(`[aria-label="${label}"]`); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    await test.click(label);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('input[aria-label="推理强度"]')).not.toBeNull());
    const slider = test.dom.window.document.querySelector<HTMLInputElement>('input[aria-label="推理强度"]')!;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(slider, '4');
    slider.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    expect(test.commands.filter(command => command.payload.type === 'thread.effort.update')).toHaveLength(0);
    slider.dispatchEvent(new test.dom.window.Event('pointerup', { bubbles: true }));
    await vi.waitFor(() => expect(test.commands.find(command => command.payload.type === 'thread.effort.update')?.payload).toMatchObject({ effort: 'max', expectedEffort: 'xhigh', expectedModel: 'gpt-6.1-sol' }));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="模型与推理强度：6.1 Sol，Max"]')).not.toBeNull());
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="打开模型高级设置"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await test.click('打开模型高级设置');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="选择模型"]')).not.toBeNull());
    await test.click('选择模型');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="6 Astra"]')).not.toBeNull());
    await test.click('6 Astra');
    await vi.waitFor(() => expect(test.commands.find(command => command.payload.type === 'thread.model.update')?.payload).toMatchObject({ model: 'gpt-6-astra', expectedModel: 'gpt-6.1-sol' }));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('restores the saved strength when changing effort fails', async () => {
  const test = await fixture({ controls: { active: false, text: '排队消息', images: [], failEffort: true } });
  try {
    const label = '模型与推理强度：6.1 Sol，极高';
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector(`[aria-label="${label}"]`); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    await test.click(label);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('input[aria-label="推理强度"]')).not.toBeNull());
    const slider = test.dom.window.document.querySelector<HTMLInputElement>('input[aria-label="推理强度"]')!;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(slider, '4');
    slider.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(slider.getAttribute('aria-valuetext')).toBe('Max'));
    slider.dispatchEvent(new test.dom.window.Event('pointerup', { bubbles: true }));
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
    await test.click('编辑待发送消息');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('textarea[aria-label="编辑待发送消息"]')).not.toBeNull());
    const input = test.dom.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑待发送消息"]')!;
    expect(input.value).toBe(controls.text);
    const original = controls.text;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '编辑后的消息');
    input.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    await test.click('保存消息');
    await vi.waitFor(() => expect(test.commands.find(command => command.payload.type === 'turn.queue.update')?.payload).toEqual({ type: 'turn.queue.update', threadId: 'recent-pc-a', queueId: 'queue-1', text: '编辑后的消息', expectedText: original }));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('textarea[aria-label="编辑待发送消息"]')).toBeNull());
    expect(controls.images).toEqual(['a'.repeat(64)]);
    await test.click('编辑待发送消息');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑待发送消息"]')?.value).toBe('编辑后的消息'));
    const second = test.dom.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑待发送消息"]')!;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(second, '保留我的草稿');
    second.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    controls.text = '另一客户端的新消息';
    await test.click('保存消息');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('已在其他地方修改'));
    expect(second.value).toBe('保留我的草稿');
    expect(controls.text).toBe('另一客户端的新消息');
    expect(test.dom.window.document.body.textContent).not.toContain('侧边聊天');
    expect(test.dom.window.document.body.textContent).not.toContain('关闭排队');
    expect(test.dom.window.document.querySelector('[aria-label="待发送消息更多操作"]')).toBeNull();
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});


it('uses categorized settings with version information, keeps operation dialogs centered and project creation beside its heading', async () => {
  const test = await fixture({ controls: { active: false, text: '', images: [] } });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    const add = test.dom.window.document.querySelector('[aria-label="新建项目"]')!;
    expect(add.textContent).toBe(''); expect(add.parentElement?.textContent).toBe('项目');
    await test.click('连接设置');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="关于与版本"]')).not.toBeNull());
    await test.click('关于与版本');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="settings-shell"]')?.textContent).toContain('8.7.6'));
    const card = test.dom.window.document.querySelector<HTMLElement>('[data-testid="settings-shell"]')!;
    expect(card.textContent).toContain('服务器版本'); expect(card.textContent).toContain('控制端版本');
    expect(card.textContent).toContain(controlVersion);
    expect(test.dom.window.document.querySelector('[data-testid="dialog-card"]')).toBeNull();
    await test.closeDialog('关闭设置');
    await test.click('添加附件');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="interaction-surface"]')?.textContent).toContain('方案模式'));
    await test.closeDialog('关闭面板');
    await test.click('管理会话 recent-pc-a');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="dialog-card"]')?.textContent).toContain('归档'));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('copies the full ID of the menu target without selecting it, and the current ID from conversation options', async () => {
  const clipboard = { values: [] as string[] };
  const catalogA = catalog('pc-a');
  const recentId = '019c1133-823a-7f10-a555-ff8123456789', olderId = '019b0022-341a-7990-b666-ee9876543210';
  catalogA.threads[0]!.id = recentId; catalogA.threads[1]!.id = olderId;
  const test = await fixture({ clipboard, catalogs: { 'pc-a': catalogA, 'pc-b': catalog('pc-b') } });
  const document = test.dom.window.document;
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    await test.click('管理会话 older-pc-a');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="conversation-id"]')?.textContent).toBe(olderId));
    await test.click('复制会话 ID');
    await vi.waitFor(() => expect(document.querySelector('[aria-label="复制会话 ID"]')?.textContent).toBe('已复制'));
    expect(clipboard.values).toEqual([olderId]);
    await test.closeDialog('关闭older-pc-a');
    expect(test.header()).toContain('recent-pc-a');
    await test.click('会话选项');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="conversation-options-menu"]')).not.toBeNull());
    expect(document.querySelector('[aria-label="复制会话 ID"]')?.textContent).toBe('复制会话 ID');
    await test.click('复制会话 ID');
    await vi.waitFor(() => expect(clipboard.values).toEqual([olderId, recentId]));
    await test.closeDialog('关闭面板');
    await test.click('会话选项');
    await vi.waitFor(() => expect(document.querySelector('[aria-label="复制会话 ID"]')?.textContent).toBe('复制会话 ID'));
    expect(test.commands).toEqual([]);
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('keeps the full ID selectable and offers retry instead of claiming clipboard success after denial', async () => {
  const clipboard = { values: [] as string[], fail: true };
  const test = await fixture({ clipboard });
  const document = test.dom.window.document;
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    await test.click('会话选项');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="conversation-options-menu"]')).not.toBeNull());
    await test.click('复制会话 ID');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('手动复制'));
    expect(document.querySelector('[data-testid="conversation-id"]')?.textContent).toBe('recent-pc-a');
    expect(document.querySelector('[aria-label="复制会话 ID"]')?.textContent).toBe('复制会话 ID');
    expect(clipboard.values).toEqual([]);
    clipboard.fail = false; await test.click('复制会话 ID');
    await vi.waitFor(() => expect(document.querySelector('[aria-label="复制会话 ID"]')?.textContent).toBe('已复制'));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(clipboard.values).toEqual(['recent-pc-a']);
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('opens a compact title menu and performs rename/archive on the current chat while preserving its draft', async () => {
  const test = await fixture({ controls: { active: false, text: '', images: [] } });
  const doc = test.dom.window.document;
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    const input = doc.querySelector<HTMLTextAreaElement>('[aria-label="给 Codex 发送消息"]')!;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '尚未发送的草稿');
    input.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    await test.click('会话选项');
    await vi.waitFor(() => expect(doc.querySelector('[data-testid="conversation-options-menu"]')).not.toBeNull());
    const menu = doc.querySelector('[data-testid="conversation-options-menu"]')!;
    expect(menu.textContent).toContain('recent-pc-a重命名复制会话 ID归档删除会话刷新会话');
    expect(menu.textContent).not.toContain('会话设置');
    expect(menu.querySelectorAll('[aria-label="复制会话 ID"]')).toHaveLength(1);
    expect(menu.querySelector('[data-testid="conversation-id"]')).toBeNull();
    expect(doc.querySelector('[data-testid="dialog-card"]')).toBeNull();
    const row = doc.querySelector('[aria-label="重命名"]')!;
    expect(row.firstElementChild?.textContent).toBe('重命名');
    expect(row.lastElementChild?.tagName.toLowerCase()).toBe('svg');
    await test.click('重命名');
    await vi.waitFor(() => expect(doc.querySelector<HTMLInputElement>('[aria-label="会话名称"]')?.value).toBe('recent-pc-a'));
    expect(doc.querySelector('[data-testid="conversation-options-menu"]')).toBeNull();
    const name = doc.querySelector<HTMLInputElement>('[aria-label="会话名称"]')!;
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(name, '重命名后的会话');
    name.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    await test.click('保存会话名称');
    await vi.waitFor(() => expect(test.commands.find(command => command.payload.type === 'thread.rename')?.payload).toEqual({ type: 'thread.rename', threadId: 'recent-pc-a', name: '重命名后的会话' }));
    // Finish the existing RN Web dialog's closing CSS animation in JSDOM.
    await vi.waitFor(() => {
      const modal = Array.from(doc.querySelectorAll('*')).find(element => test.dom.window.getComputedStyle(element).animationDuration === '250ms' && test.dom.window.getComputedStyle(element).pointerEvents === 'none');
      expect(modal).toBeDefined(); modal!.dispatchEvent(new test.dom.window.Event('animationend', { bubbles: true }));
    });
    await vi.waitFor(() => expect(test.header()).toContain('重命名后的会话'));
    expect(input.value).toBe('尚未发送的草稿');
    await test.click('会话选项');
    await vi.waitFor(() => expect(doc.querySelector('[data-testid="conversation-options-menu"]')?.textContent).toContain('重命名后的会话'));
    await test.click('归档');
    await vi.waitFor(() => expect(test.commands.find(command => command.payload.type === 'thread.archive')?.payload).toEqual({ type: 'thread.archive', threadId: 'recent-pc-a' }));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('keeps sub-agents at the header and puts deletion below archive with an explicit permanent-delete confirmation', async () => {
  const test = await fixture({ controls: { active: false, text: '', images: [] }, subAgents: [{ threadId: 'child-1', parentThreadId: 'recent-pc-a', name: '排版检查', task: '核对移动端布局', status: 'running', statusSource: 'thread' }] });
  const doc = test.dom.window.document;
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    const agentLabel = '子 Agent，共 1 个，1 个运行中，0 个等待启动';
    await vi.waitFor(() => expect(doc.querySelector(`[data-testid="conversation-header"] [aria-label="${agentLabel}"]`)).not.toBeNull());
    await test.click(agentLabel);
    await vi.waitFor(() => expect(doc.body.textContent).toContain('核对移动端布局'));
    await test.closeDialog('关闭面板');
    await test.click('会话选项');
    await vi.waitFor(() => expect(doc.querySelector('[data-testid="conversation-options-menu"]')).not.toBeNull());
    const menu = doc.querySelector('[data-testid="conversation-options-menu"]')!;
    expect(menu.textContent).not.toContain('子 Agent'); expect(menu.textContent).not.toContain('会话设置');
    expect(menu.querySelectorAll('[aria-label="复制会话 ID"]')).toHaveLength(1);
    const actions = Array.from(menu.querySelectorAll('[role="button"]')).map(node => node.getAttribute('aria-label'));
    expect(actions[actions.indexOf('归档') + 1]).toBe('删除会话');
    await vi.waitFor(() => expect(doc.querySelector('[aria-label="本会话微信通知"]')).not.toBeNull());
    const confirm = vi.fn(() => false); test.dom.window.confirm = confirm;
    await test.click('删除会话');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith('删除会话\n\n这将永久删除“recent-pc-a”，删除后无法恢复。确定删除吗？'));
    expect(test.commands.some(command => command.payload.type === 'thread.delete')).toBe(false);
    expect(test.header()).toContain('recent-pc-a');
    await test.click('会话选项');
    await vi.waitFor(() => expect(doc.querySelector('[aria-label="删除会话"]')).not.toBeNull());
    confirm.mockReturnValue(true); await test.click('删除会话');
    await vi.waitFor(() => expect(test.commands.filter(command => command.payload.type === 'thread.delete').map(command => command.payload)).toEqual([{ type: 'thread.delete', threadId: 'recent-pc-a' }]));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('shows each child usage, a distinct-child total and live updates in the sub-agent panel', async () => {
  const usage = { totalTokens: 1200, recordedTokens: 1200, totalKnown: true, partial: false,
    models: [{ model: 'gpt-5.3-codex', totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200 }] };
  const children: RemoteSubAgent[] = [
    { threadId: 'child-1', parentThreadId: 'recent-pc-a', name: 'Hume', task: '检查用量', status: 'completed', statusSource: 'activity', usage },
    { threadId: 'child-2', parentThreadId: 'child-1', name: 'Nested', status: 'running', statusSource: 'thread', usage: { ...usage, models: [{ ...usage.models[0]!, model: 'gpt-5.4' }] } },
    { threadId: 'missing', parentThreadId: 'recent-pc-a', name: 'Pending', status: 'shutdown', statusSource: 'reported' },
  ];
  const test = await fixture({ controls: { active: false, text: '', images: [] }, subAgents: children });
  const doc = test.dom.window.document;
  try {
    await vi.waitFor(() => expect(doc.querySelector('[aria-label="子 Agent，共 3 个，1 个运行中，0 个等待启动"]')).not.toBeNull(), { timeout: 5000 });
    await test.click('子 Agent，共 3 个，1 个运行中，0 个等待启动');
    await vi.waitFor(() => expect(doc.querySelector('[data-testid="sub-agents-usage-total"]')?.textContent).toContain('子 Agent 合计 ≥2,400 Token · 部分预估 $0.0081'), { timeout: 5000 });
    expect(doc.querySelector('[data-testid="sub-agents-usage-total"]')?.textContent).toContain('2/3 个有累计计数');
    expect(doc.querySelector('[data-testid="sub-agent-usage-child-1"]')?.textContent).toContain('$0.0038');
    expect(doc.querySelector('[data-testid="sub-agent-usage-missing"]')?.textContent).toContain('待同步');
    await test.click('Hume，已完成，展开详情');
    await vi.waitFor(() => expect(doc.body.textContent).toContain('gpt-5.3-codex · 输入 1,000 · 缓存命中 500 · 输出 200'), { timeout: 5000 });
    children[0]!.usage = { ...usage, totalTokens: 2400, recordedTokens: 2400,
      models: [{ model: 'gpt-5.3-codex', totalTokens: 2400, inputTokens: 2000, cachedInputTokens: 1000, outputTokens: 400 }] };
    test.refresh();
    await vi.waitFor(() => expect(doc.querySelector('[data-testid="sub-agents-usage-total"]')?.textContent).toContain('≥3,600 Token'), { timeout: 5000 });
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('saves the inline notification switch for the current chat and keeps it unchanged on failure', async () => {
  const wait = gate(), notification = { enabled: false, updates: [] as { path: string; enabled: boolean }[], wait: wait.promise, fail: false };
  const test = await fixture({ notification, controls: { active: false, text: '', images: [] } });
  const doc = test.dom.window.document;
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('会话选项');
    const toggle = () => doc.querySelector<HTMLInputElement>('[aria-label="本会话微信通知"]')!;
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle().checked).toBe(false);
    await test.click('本会话微信通知');
    await vi.waitFor(() => expect(toggle().disabled).toBe(true));
    expect(toggle().checked).toBe(false);
    wait.release();
    await vi.waitFor(() => expect(toggle().checked).toBe(true));
    expect(notification.updates).toEqual([{ path: '/v1/devices/pc-a/threads/recent-pc-a/weixin-notification', enabled: true }]);
    await test.closeDialog('关闭面板');
    await test.click('会话选项，微信通知已开启');
    await vi.waitFor(() => expect(toggle().checked).toBe(true));
    notification.fail = true; await test.click('本会话微信通知');
    await vi.waitFor(() => expect(doc.querySelector('[data-testid="conversation-options-menu"]')?.textContent).toContain('保存失败，请重试'));
    expect(toggle().checked).toBe(true);
    expect(notification.enabled).toBe(true); expect(test.errors).toEqual([]);
  } finally { wait.release(); test.close(); }
});

it('allows copying the chat ID offline while disabling remote rename and archive', async () => {
  const clipboard = { values: [] as string[] };
  const test = await fixture({ clipboard, controls: { active: false, text: '', images: [] } });
  const doc = test.dom.window.document;
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    // Relay's fixture subscription is the same mechanism used by a real disconnect.
    (test.app().relay as unknown as { set(view: {phase: string}): void }).set({ phase: 'reconnecting' });
    await test.click('会话选项');
    await vi.waitFor(() => expect(doc.querySelector('[aria-label="重命名"]')?.getAttribute('aria-disabled')).toBe('true'));
    expect(doc.querySelector('[aria-label="归档"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(doc.querySelector('[aria-label="删除会话"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(doc.querySelector<HTMLInputElement>('[aria-label="本会话微信通知"]')?.disabled).toBe(true);
    await test.click('复制会话 ID');
    await vi.waitFor(() => expect(clipboard.values).toEqual(['recent-pc-a']));
    expect(test.commands).toEqual([]); expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('shows the selected PC Agent version and marks older agents without guessing a version', async () => {
  const test = await fixture({ agentVersions: { 'pc-a': '0.1.16' } });
  const document = test.dom.window.document;
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('连接设置');
    await vi.waitFor(()=>expect(document.querySelector('[aria-label="服务器与设备"]')).not.toBeNull());await test.click('服务器与设备');
    const version = () => document.querySelector('[data-testid="selected-agent-version"]')?.textContent;
    await vi.waitFor(() => expect(version()).toContain('pc-a · 在线\nmacOS · 0.1.16'));
    expect(version()).not.toContain('未上报');
    await test.closeDialog('关闭设置');
    await test.click('切换 PC Agent，当前：pc-a，在线');
    await vi.waitFor(() => expect(document.querySelector('[aria-label="选择设备 pc-b，在线"]')).not.toBeNull());
    await test.click('选择设备 pc-b，在线');
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-b']).toBe(false));
    await test.click('连接设置');
    await vi.waitFor(()=>expect(document.querySelector('[aria-label="服务器与设备"]')).not.toBeNull());await test.click('服务器与设备');
    await vi.waitFor(() => expect(version()).toContain('pc-b · 在线'));
    expect(version()).toContain('未上报'); expect(version()).not.toContain('0.1.16');
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
    await test.click('连接设置');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="外观"]')).not.toBeNull());await test.click('外观');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="radiogroup"]')).not.toBeNull());
    expect(test.dom.window.document.querySelectorAll('[aria-label="控制端皮肤"] [role="radio"]')).toHaveLength(3);
    for (const [label, id, color] of [['暖白纸张', 'paper', '#faf7f1'], ['中性深色', 'warm-dark', '#111113'], ['默认', 'default', '#ffffff']]) {
      await test.click(label!);
      await vi.waitFor(() => expect(test.dom.window.document.documentElement.dataset.controlTheme).toBe(id));
      expect(test.dom.window.document.documentElement.style.getPropertyValue('--control-bg')).toBe(color);
      expect(test.dom.window.document.querySelector(`[aria-label="${label}"]`)!.getAttribute('aria-checked')).toBe('true');
      await vi.waitFor(() => expect(JSON.parse(test.dom.window.localStorage.getItem('codexer.control.appearance.v2')??'null')).toMatchObject({appearance:id==='warm-dark'?'dark':'light',skin:id==='paper'?'paper':'neutral'}));
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
    await test.click('连接设置');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="外观"]')).not.toBeNull());await test.click('外观');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="中性深色"]')).not.toBeNull());
    await test.click('中性深色');
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
      await test.click('添加附件');
      await vi.waitFor(() => expect(document.querySelector('[aria-label="添加文件"]')).not.toBeNull());
      await test.closeDialog('关闭面板');
      expectSingleToolbar();
      await test.click('模型与推理强度：6.1 Sol，极高');
      await vi.waitFor(() => expect(document.querySelector('input[aria-label="推理强度"]')).not.toBeNull());
      await test.closeDialog('关闭模型面板');
      const row = [...document.querySelectorAll('[role="button"]')].find(element => element.textContent === threadId) as HTMLElement;
      row.click();
      await vi.waitFor(() => expect(test.header()).toContain(threadId));
      expectSingleToolbar();
    }
    for (const [from, to] of [['pc-a', 'pc-b'], ['pc-b', 'pc-a']]) {
      await test.click(`切换 PC Agent，当前：${from}，在线`);
      await vi.waitFor(() => expect(document.querySelector(`[aria-label="选择设备 ${to}，在线"]`)).not.toBeNull());
      await test.click(`选择设备 ${to}，在线`);
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
    await test.click('添加附件');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加文件"]')).not.toBeNull());
    expect(test.dom.window.document.body.textContent).toContain('图片与视频');
    await test.click('添加文件');
    await vi.waitFor(() => expect(test.uploadRequests).toHaveLength(2));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="interaction-surface"]')).toBeNull());
    await test.click('发送消息');
    await vi.waitFor(() => expect(test.commands.some(c => c.payload.type === 'turn.start' && c.payload.text === '' && c.payload.attachments?.[0] === 'f'.repeat(64))).toBe(true));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="移除 说明.txt"]')).toBeNull());
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('offers one mixed media entry and sends photos with an original video larger than the ordinary file limit', async () => {
  const bytes = Buffer.alloc(21 * 1024 * 1024, 7);
  let pickerKind: string | undefined;
  const test = await fixture({ controls: { active: false, text: '', images: [] }, imagePicker: async () => ({ canceled: false, assets: [draftImage('混选图片.png')] }), filePicker: async kind => {
    pickerKind = kind;
    return [{ name: '录屏.mp4', size: bytes.length, mimeType: 'video/mp4', readChunk: async (offset, length) => bytes.subarray(offset, offset + length).toString('base64') }];
  } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('添加附件');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加图片与视频"]')).not.toBeNull());
    expect(test.dom.window.document.querySelector('[aria-label="添加视频"]')).toBeNull();
    expect(test.dom.window.document.body.textContent).toContain('视频每个 512 MB');
    await test.click('添加图片与视频');
    await vi.waitFor(() => expect(test.uploadRequests).toHaveLength(43));
    expect(pickerKind).toBe('video');
    expect(test.imageUploads).toHaveLength(1);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="interaction-surface"]')).toBeNull());
    await test.click('发送消息');
    await vi.waitFor(() => expect(test.commands.some(c => c.payload.type === 'turn.start' && c.payload.text === '' && c.payload.images?.[0] === test.imageUploads[0]!.id && c.payload.attachments?.[0] === 'f'.repeat(64))).toBe(true));
    expect(test.commands.at(-1)!.expiresAt - Date.now()).toBeGreaterThan(290000);
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it.each(['drop', 'paste'])('uploads a video from the browser composer %s event without converting it to an image', async action => {
  const test = await fixture({ controls: { active: false, text: '', images: [] } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    const video = new test.dom.window.File([new Uint8Array([0, 1, 2, 3, 4])], '录屏.webm', { type: 'video/webm' });
    const event = new test.dom.window.Event(action, { bubbles: true, cancelable: true });
    Object.defineProperty(event, action === 'drop' ? 'dataTransfer' : 'clipboardData', { value: { files: [video], types: ['Files'] } });
    composer(test).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(test.uploadRequests).toHaveLength(2));
    expect(test.imageUploads).toHaveLength(0);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="interaction-surface"]')).toBeNull());
    await test.click('发送消息');
    await vi.waitFor(() => expect(test.commands.find(c => c.payload.type === 'turn.start')?.payload).toMatchObject({ text: '', attachments: ['f'.repeat(64)] }));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it.each([false, true])('honors the advertised image limit and legacy fallback (legacy=%s)', async legacyAgent => {
  const limit = legacyAgent ? 4 : 20;
  const test = await fixture({ legacyAgent, controls: { active: false, text: '', images: [] }, imagePicker: async () => ({ canceled: false, assets: Array.from({ length: 21 }, (_, i) => draftImage(`image-${i}.png`)) }) });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('添加附件');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加图片与视频"]')).not.toBeNull());
    expect(test.dom.window.document.body.textContent).toContain(`最多 ${limit} 张图片`);
    await test.click('添加图片与视频');
    await vi.waitFor(() => expect(test.imageUploads).toHaveLength(limit));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="interaction-surface"]')).toBeNull());
    await test.click('发送消息');
    await vi.waitFor(() => expect(test.commands.find(c => c.payload.type === 'turn.start')?.payload).toMatchObject({ text: '', images: test.imageUploads.map(item => item.id) }));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('discards a late file selection when the user has switched devices', async () => {
  const selection = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, filePicker: async () => { await selection.promise; return [{ name: 'old.txt', size: 1, mimeType: 'text/plain', readChunk: async () => 'YQ==' }]; } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('添加附件'); await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加文件"]')).not.toBeNull()); await test.click('添加文件');
    await test.click('切换 PC Agent，当前：pc-a，在线'); await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="选择设备 pc-b，在线"]')).not.toBeNull()); await test.click('选择设备 pc-b，在线');
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-b')); selection.release();
    await new Promise(resolve => setTimeout(resolve, 50)); expect(test.uploadRequests).toEqual([]);
    expect(test.dom.window.document.querySelector('[aria-label="移除 old.txt"]')).toBeNull(); expect(test.errors).toEqual([]);
  } finally { selection.release(); test.close(); }
});

it('keeps a file upload in its original draft while switching conversations', async () => {
  const chunk = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, filePicker: async () => [{ name: 'slow.txt', size: 1, mimeType: 'text/plain', readChunk: async () => { await chunk.promise; return 'YQ=='; } }] });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('添加附件'); await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加文件"]')).not.toBeNull()); await test.click('添加文件');
    await vi.waitFor(() => expect(test.uploadRequests).toHaveLength(1));
    expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).toBe('true');
    const row = [...test.dom.window.document.querySelectorAll('[role="button"]')].find(element => element.textContent === 'older-pc-a') as HTMLElement;
    row.click(); await vi.waitFor(() => expect(test.header()).toContain('older-pc-a'));
    chunk.release(); await vi.waitFor(() => expect(test.uploadRequests).toHaveLength(2));
    expect(test.commands.some(command => command.payload.type === 'turn.start')).toBe(false);
    expect(test.dom.window.document.querySelector('[aria-label="移除 slow.txt"]')).toBeNull();
    await selectDraftThread(test, 'recent-pc-a');
    expect(test.dom.window.document.querySelector('[aria-label="移除 slow.txt"]')).not.toBeNull();
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="interaction-surface"]')).toBeNull());
    await test.click('发送消息');
    await vi.waitFor(() => expect(test.commands.some(command => command.payload.type === 'turn.start' && command.payload.threadId === 'recent-pc-a' && command.payload.attachments?.[0] === 'f'.repeat(64))).toBe(true));
    expect(test.errors).toEqual([]);
  } finally { chunk.release(); test.close(); }
});

const composer = (test: Awaited<ReturnType<typeof fixture>>) => test.dom.window.document.querySelector<HTMLTextAreaElement>('[aria-label="给 Codex 发送消息"]')!;
function writeDraft(test: Awaited<ReturnType<typeof fixture>>, text: string) {
  const input = composer(test);
  Object.getOwnPropertyDescriptor(test.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
}
async function selectDraftThread(test: Awaited<ReturnType<typeof fixture>>, id: string) {
  const row = [...test.dom.window.document.querySelectorAll('[role="button"]')].find(element => element.textContent === id) as HTMLElement;
  row.click();
  await vi.waitFor(() => expect(test.header()).toContain(id));
}
async function selectDraftDevice(test: Awaited<ReturnType<typeof fixture>>, from: string, to: string) {
  await test.click(`切换 PC Agent，当前：${from}，在线`);
  await vi.waitFor(() => expect(test.dom.window.document.querySelector(`[aria-label="选择设备 ${to}，在线"]`)).not.toBeNull());
  await test.click(`选择设备 ${to}，在线`);
  await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing[to]).toBe(false));
}
const draftImage = (name = '草稿 截图.png') => ({ uri: 'data:image/png;base64,ZmFrZQ==', fileName: name, width: 1, height: 1, mimeType: 'image/png', base64: 'ZmFrZQ==' });
async function addDraftImage(test: Awaited<ReturnType<typeof fixture>>) {
  await test.click('添加附件');
  await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加图片与视频"]')).not.toBeNull());
  await test.click('添加图片与视频');
  await vi.waitFor(() => expect(test.imageUploads.length).toBeGreaterThan(0));
}

it('restores independent multiline drafts after immediate conversation switches and repeated selection', async () => {
  const test = await fixture({ controls: { active: false, text: '', images: [] } });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    writeDraft(test, '第一个会话的草稿\n保留换行  和空格');
    await selectDraftThread(test, 'older-pc-a');
    expect(composer(test).value).toBe('');
    writeDraft(test, '第二个会话的内容');
    await selectDraftThread(test, 'recent-pc-a');
    expect(composer(test).value).toBe('第一个会话的草稿\n保留换行  和空格');
    await selectDraftThread(test, 'recent-pc-a');
    expect(composer(test).value).toBe('第一个会话的草稿\n保留换行  和空格');
    await selectDraftThread(test, 'older-pc-a');
    expect(composer(test).value).toBe('第二个会话的内容');
    expect(test.commands).toEqual([]); expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('separates drafts for identical thread ids on different PCs', async () => {
  const catalogs = Object.fromEntries(devices.map(device => [device.id, { ...catalog(device.id), threads: [{ ...catalog(device.id).threads[0]!, id: 'same-thread', title: 'Shared thread id' }] }]));
  const test = await fixture({ catalogs, controls: { active: false, text: '', images: [] } });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    writeDraft(test, 'PC A 草稿');
    await selectDraftDevice(test, 'pc-a', 'pc-b');
    expect(composer(test).value).toBe('');
    writeDraft(test, 'PC B 草稿');
    await selectDraftDevice(test, 'pc-b', 'pc-a');
    expect(composer(test).value).toBe('PC A 草稿');
    await selectDraftDevice(test, 'pc-a', 'pc-b');
    expect(composer(test).value).toBe('PC B 草稿'); expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('restores an image uploaded in the background only to its original draft and sends the correct image id', async () => {
  const upload = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, imagePicker: async () => ({ canceled: false, assets: [draftImage()] }), imageUpload: { wait: upload.promise } });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    writeDraft(test, '带截图的消息');
    await addDraftImage(test);
    expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).toBe('true');
    await selectDraftThread(test, 'older-pc-a');
    expect(composer(test).value).toBe('');
    expect(test.dom.window.document.querySelector('[aria-label="预览 草稿 截图.png"]')).toBeNull();
    writeDraft(test, '保留另一个会话');
    upload.release();
    await selectDraftThread(test, 'recent-pc-a');
    expect(composer(test).value).toBe('带截图的消息');
    expect(test.dom.window.document.querySelector('[aria-label="预览 草稿 截图.png"]')).not.toBeNull();
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="interaction-surface"]')).toBeNull());
    await test.click('发送消息');
    await vi.waitFor(() => expect(composer(test).value).toBe(''));
    expect(test.commands.find(command => command.payload.type === 'turn.start')?.payload).toMatchObject({ threadId: 'recent-pc-a', text: '带截图的消息', images: [test.imageUploads[0]!.id] });
    expect(test.imageUploads.map(upload => upload.path)).toEqual(['/v1/devices/pc-a/threads/recent-pc-a/images']);
    await selectDraftThread(test, 'older-pc-a'); expect(composer(test).value).toBe('保留另一个会话');
    await selectDraftThread(test, 'recent-pc-a');
    expect(composer(test).value).toBe(''); expect(test.dom.window.document.querySelector('[aria-label="移除 草稿 截图.png"]')).toBeNull();
    expect(test.errors).toEqual([]);
  } finally { upload.release(); test.close(); }
});

it.each([false, true])('handles a delayed submission without clearing another draft (failure=%s)', async fail => {
  const pending = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, submission: { wait: pending.promise, fail } });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    await selectDraftThread(test, 'older-pc-a'); writeDraft(test, '另一个草稿');
    await selectDraftThread(test, 'recent-pc-a'); writeDraft(test, '正在发送的草稿');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[data-testid="interaction-surface"]')).toBeNull());
    await test.click('发送消息');
    await vi.waitFor(() => expect(test.commands.some(command => command.payload.type === 'turn.start')).toBe(true));
    await selectDraftThread(test, 'older-pc-a'); pending.release();
    await vi.waitFor(() => expect(composer(test).readOnly).toBe(false));
    expect(composer(test).value).toBe('另一个草稿');
    await selectDraftThread(test, 'recent-pc-a'); expect(composer(test).value).toBe(fail ? '正在发送的草稿' : '');
    expect(test.errors).toEqual([]);
  } finally { pending.release(); test.close(); }
});

it('retains an upload error and lets the original conversation retry its image after switching back', async () => {
  const imageUpload = { fail: true };
  const test = await fixture({ controls: { active: false, text: '', images: [] }, imagePicker: async () => ({ canceled: false, assets: [draftImage()] }), imageUpload });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    await addDraftImage(test);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="重试上传 草稿 截图.png"]')).not.toBeNull());
    await selectDraftThread(test, 'older-pc-a');
    await selectDraftThread(test, 'recent-pc-a');
    expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).toBe('true');
    imageUpload.fail = false; await test.click('重试上传 草稿 截图.png');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="重试上传 草稿 截图.png"]')).toBeNull());
    expect(test.imageUploads).toHaveLength(2); expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('clears all drafts on logout and ignores late image uploads even after logging back into the same account', async () => {
  const upload = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, imagePicker: async () => ({ canceled: false, assets: [draftImage()] }), imageUpload: { wait: upload.promise } });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    writeDraft(test, '退出前的草稿'); await addDraftImage(test);
    await test.app().relay.logout();
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="账号"]')).not.toBeNull());
    await test.app().relay.connect(origin, 'user-a', 'fixture-password');
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    expect(composer(test).value).toBe('');
    writeDraft(test, '重新登录后的新草稿'); upload.release();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(composer(test).value).toBe('重新登录后的新草稿');
    expect(test.dom.window.document.querySelector('[aria-label="预览 草稿 截图.png"]')).toBeNull();
    expect(test.errors).toEqual([]);
  } finally { upload.release(); test.close(); }
});

it.each([[origin, 'user-b'], ['http://other-relay.test', 'user-a']])('keeps drafts private when changing to %s as %s', async (url, user) => {
  const test = await fixture({ controls: { active: false, text: '', images: [] }, imagePicker: async () => ({ canceled: false, assets: [draftImage()] }) });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    writeDraft(test, '上一个账号和服务器的内容'); await addDraftImage(test);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await test.app().relay.connect(url!, user!, 'fixture-password');
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    expect(composer(test).value).toBe('');
    expect(test.dom.window.document.querySelector('[aria-label="预览 草稿 截图.png"]')).toBeNull();
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('cancels pending file uploads on logout and never restores them into a later login', async () => {
  const chunk = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, filePicker: async () => [{ name: 'private.txt', size: 1, mimeType: 'text/plain', readChunk: async () => { await chunk.promise; return 'YQ=='; } }] });
  try {
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    await test.click('添加附件'); await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="添加文件"]')).not.toBeNull()); await test.click('添加文件');
    await vi.waitFor(() => expect(test.uploadRequests).toHaveLength(1));
    await test.app().relay.logout();
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="账号"]')).not.toBeNull());
    await test.app().relay.connect(origin, 'user-a', 'fixture-password');
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="添加附件"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    chunk.release(); await new Promise(resolve => setTimeout(resolve, 40));
    expect(test.uploadRequests).toHaveLength(1);
    expect(test.dom.window.document.querySelector('[aria-label="移除 private.txt"]')).toBeNull();
    expect(test.errors).toEqual([]);
  } finally { chunk.release(); test.close(); }
});

it.each([false, true])('changes App permissions only after explicit confirmation (active=%s)', async active => {
  const test = await fixture({permissions: true, controls: {active, text: '', images: []}});
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="会话权限：请求批准"]')).not.toBeNull());
    await test.click('会话权限：请求批准');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="权限：完全访问"]')).not.toBeNull());
    await test.click('权限：完全访问');
    expect(test.commands.filter(c => c.payload.type === 'thread.permissions.update')).toHaveLength(0);
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="确认使用完全访问"]')).not.toBeNull());
    await test.click('确认使用完全访问');
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

it.each([false, true])('steers the active turn immediately, retaining drafts only on failure (%s)', async fail => {
  const test = await fixture({ controls: { active: true, text: '', images: [] }, submission: { fail } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    writeDraft(test, '直接追加的指令');
    await vi.waitFor(() => expect(composer(test).value).toBe('直接追加的指令'));
    await test.click('发送引导消息');
    await vi.waitFor(() => expect(test.commands.filter(c => c.payload.type === 'turn.steer')).toHaveLength(1));
    expect(test.commands.find(c => c.payload.type === 'turn.steer')!.payload).toEqual({type: 'turn.steer', threadId: 'recent-pc-a', turnId: 'active-turn', text: '直接追加的指令'});
    expect(test.commands.some(c => c.payload.type === 'turn.queue' || c.payload.type === 'turn.start')).toBe(false);
    await vi.waitFor(() => expect(composer(test).value).toBe(fail ? '直接追加的指令' : ''));
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('interrupts, then continues with empty input only after an interrupted snapshot is received', async () => {
  const test = await fixture({ controls: { active: true, text: '', images: [] } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('停止当前任务');
    await vi.waitFor(() => { const button = test.dom.window.document.querySelector('[aria-label="继续任务"]'); expect(button).not.toBeNull(); expect(button?.getAttribute('aria-disabled')).not.toBe('true'); });
    expect(test.commands.find(c => c.payload.type === 'turn.interrupt')!.payload).toMatchObject({turnId: 'active-turn'});
    expect(composer(test).value).toBe('');
    await test.click('继续任务');
    await vi.waitFor(() => expect(test.commands.filter(c => c.payload.type === 'turn.continue')).toHaveLength(1));
    expect(test.commands.find(c => c.payload.type === 'turn.continue')!.payload).toEqual({type: 'turn.continue', threadId: 'recent-pc-a', turnId: 'active-turn'});
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="停止当前任务"]')).not.toBeNull());
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it.each([false, true])('does not submit empty idle messages or steer without a known active turn (%s)', async active => {
  const controls = { active, text: '', images: [], unknownTurn: true };
  const test = await fixture({ controls });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    if (!active) expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).toBe('true');
    writeDraft(test, '保留这条指令');
    if (active) await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送引导消息"]')?.getAttribute('aria-disabled')).toBe('true'));
    expect(test.commands.filter(c => c.payload.type.startsWith('turn.'))).toHaveLength(0);
  } finally { test.close(); }
});

it('keeps active settings and empty continuation unavailable on older connectors', async () => {
  const test = await fixture({ controls: { active: true, text: '', images: [] }, legacyAgent: true });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    expect(test.dom.window.document.querySelector('[aria-label^="模型与推理强度："]')?.getAttribute('aria-disabled')).toBe('true');
    await test.click('停止当前任务');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="发送消息"]')?.getAttribute('aria-disabled')).toBe('true'));
    expect(test.dom.window.document.querySelector('[aria-label="继续任务"]')).toBeNull();
  } finally { test.close(); }
});


it('discards an uncommitted effort gesture and leaves the runtime settings unchanged', async () => {
  const test = await fixture({ controls: { active: true, text: '', images: [] } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('模型与推理强度：6.1 Sol，极高');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('input[aria-label="推理强度"]')).not.toBeNull());
    const slider = test.dom.window.document.querySelector<HTMLInputElement>('input[aria-label="推理强度"]')!;
    slider.dispatchEvent(new test.dom.window.Event('pointerdown', { bubbles: true }));
    Object.getOwnPropertyDescriptor(test.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(slider, '5');
    slider.dispatchEvent(new test.dom.window.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(slider.getAttribute('aria-valuetext')).toBe('Ultra'));
    slider.dispatchEvent(new test.dom.window.Event('pointercancel', { bubbles: true }));
    await vi.waitFor(() => expect(slider.getAttribute('aria-valuetext')).toBe('极高'));
    expect(test.commands.filter(c => c.payload.type === 'thread.effort.update')).toHaveLength(0);
  } finally { test.close(); }
});

it('restores the acknowledged model and permission after rejected settings changes', async () => {
  const test = await fixture({ permissions: true, controls: { active: true, text: '', images: [], failModel: true, failPermissions: true } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    await test.click('模型与推理强度：6.1 Sol，极高');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="打开模型高级设置"]')).not.toBeNull());
    await test.click('打开模型高级设置');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="选择模型"]')).not.toBeNull());
    await test.click('选择模型');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="6 Astra"]')).not.toBeNull());
    await test.click('6 Astra');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('更改未保存'));
    expect(test.dom.window.document.querySelector('[aria-label="模型与推理强度：6.1 Sol，极高"]')).not.toBeNull();
    await test.closeDialog('关闭面板');
    await test.click('会话权限：请求批准');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="权限：只读"]')).not.toBeNull());
    await test.click('权限：只读');
    await vi.waitFor(() => expect(test.commands.some(c => c.payload.type === 'thread.permissions.update')).toBe(true));
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('更改未保存'));
    expect(test.dom.window.document.querySelector('[aria-label="会话权限：请求批准"]')).not.toBeNull();
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('keeps an offline draft editable while preventing sends and runtime settings', async () => {
  const test = await fixture({ devices: devices.map(device => ({ ...device, online: false })), controls: { active: false, text: '', images: [] } });
  try {
    await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
    writeDraft(test, '离线时继续整理的草稿');
    await vi.waitFor(() => expect(composer(test).value).toBe('离线时继续整理的草稿'));
    for (const label of ['发送消息', '添加附件', '模型与推理强度：6.1 Sol，极高']) {
      expect(test.dom.window.document.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-disabled')).toBe('true');
    }
    expect(test.commands).toEqual([]);
  } finally { test.close(); }
});

it('deduplicates a double click before a delayed send acknowledgement', async () => {
  const wait = gate();
  const test = await fixture({ controls: { active: false, text: '', images: [] }, submission: { wait: wait.promise } });
  try {
    await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
    writeDraft(test, '只发送一次');
    await vi.waitFor(() => expect(composer(test).value).toBe('只发送一次'));
    const button = test.dom.window.document.querySelector('[aria-label="发送消息"]') as HTMLElement;
    button.click(); button.click();
    await vi.waitFor(() => expect(test.commands.filter(c => c.payload.type === 'turn.start')).toHaveLength(1));
    wait.release();
    await vi.waitFor(() => expect(composer(test).value).toBe(''));
  } finally { wait.release(); test.close(); }
});


const reviewQuestions = (source = 'rpc'): InteractiveRequest => ({
  id: 'question-request', kind: 'userInput', turnId: 'review-turn', respondable: true, detailsTruncated: false,
  details: { source, questions: [
    { id: 'layout', header: '布局', question: '选择布局', options: [{label:'卡片',description:'展示照片'}, {label:'列表',description:'紧凑排列'}], isOther:true },
    { id: 'secret', header: '口令', question: '填写口令', isSecret: true, options: [] },
  ] },
});
const reviewTurn = (truncated = false, type = 'plan'): HistoryTurn => ({ id:'review-turn',status:'completed',truncated:false,items:[{id:'review-plan',type,status:'completed',text:'# 相册方案\n\n1. 调整卡片布局。\n2. 验证移动端。',truncated}],fileChanges:[{path:'src/示例.ts',additions:1,deletions:1,diff:'--- a/src/示例.ts\n+++ b/src/示例.ts\n@@ -2 +2 @@\n-old\n+new\n',truncated:false}] });
async function reviewReady(test: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() => expect(test.header()).toContain('recent-pc-a'));
  await vi.waitFor(() => expect(test.app().relay.getSnapshot().syncing['pc-a']).toBe(false));
}
function answerInput(test: Awaited<ReturnType<typeof fixture>>, label: string, value: string) {
  const input = test.dom.window.document.querySelector(`[aria-label="${label}"]`) as HTMLTextAreaElement | HTMLInputElement;
  const prototype = input.tagName === 'TEXTAREA' ? test.dom.window.HTMLTextAreaElement.prototype : test.dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);
  input.dispatchEvent(new test.dom.window.Event('input',{bubbles:true}));
}
function chooseAnswer(test: Awaited<ReturnType<typeof fixture>>, label: string) {
  ([...test.dom.window.document.querySelectorAll('[role="radio"]')].find(element => element.textContent?.startsWith(label)) as HTMLElement).click();
}

it('removes only the header new-chat action and retains project creation actions', async () => {
  const test = await fixture();
  try { await reviewReady(test); expect(test.dom.window.document.querySelector('[data-testid="conversation-header"] [aria-label="新建会话"]')).toBeNull(); expect(test.dom.window.document.querySelector('[aria-label="新建项目"]')).not.toBeNull(); }
  finally { test.close(); }
});

it('pages real RPC questions, retains answers across chats, and explicitly submits the complete set once', async () => {
  const test = await fixture({ requests:[reviewQuestions()] });
  try {
    await reviewReady(test); chooseAnswer(test,'卡片');
    expect(test.commands).toHaveLength(0);
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="继续下一题"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    await test.click('继续下一题');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="回答：口令"]')).not.toBeNull());
    expect(test.dom.window.document.querySelector('[aria-label="回答：口令"]')?.getAttribute('type')).toBe('password');
    answerInput(test,'回答：口令','私密答案');
    await selectDraftThread(test,'older-pc-a');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="回答：口令"]')).toBeNull());
    await selectDraftThread(test,'recent-pc-a');
    await vi.waitFor(() => expect((test.dom.window.document.querySelector('[aria-label="回答：口令"]') as HTMLInputElement)?.value).toBe('私密答案'));
    await test.click('上一题'); await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('卡片'));
    chooseAnswer(test,'列表'); await test.click('继续下一题');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="提交回答"]')?.getAttribute('aria-disabled')).not.toBe('true'));
    const submit = test.dom.window.document.querySelector('[aria-label="提交回答"]') as HTMLElement; submit.click(); submit.click();
    await vi.waitFor(() => expect(test.commands.filter(c=>c.payload.type==='input.respond')).toHaveLength(1));
    expect(test.commands[0]!.payload).toEqual({type:'input.respond',threadId:'recent-pc-a',turnId:'review-turn',requestId:'question-request',answers:{layout:{answers:['列表']},secret:{answers:['私密答案']}}});
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('submits async choices per question, retains failed custom answers and retries without duplicating accepted answers', async () => {
  const answerSubmission = {fail:false};
  const test = await fixture({requests:[reviewQuestions('asyncMessage')],answerSubmission});
  try {
    await reviewReady(test); chooseAnswer(test,'卡片');
    await vi.waitFor(() => expect(test.commands.filter(c=>c.payload.type==='input.respond')).toHaveLength(1));
    expect(test.commands[0]!.payload).toMatchObject({answers:{layout:{answers:['卡片']}}});
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[aria-label="回答：口令"]')).not.toBeNull());
    answerInput(test,'回答：口令','保留回答'); answerSubmission.fail=true;
    await test.click('提交回答：填写口令');
    await vi.waitFor(() => expect(test.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('答案已保留'));
    expect((test.dom.window.document.querySelector('[aria-label="回答：口令"]') as HTMLInputElement).value).toBe('保留回答');
    answerSubmission.fail=false; await test.click('提交回答：填写口令');
    await vi.waitFor(() => expect(test.commands.filter(c=>c.payload.type==='input.respond')).toHaveLength(3));
    expect(test.commands.slice(1).every(c=>c.payload.type==='input.respond' && Object.keys(c.payload.answers).join()==='secret')).toBe(true);
    expect(test.errors).toEqual([]);
  } finally { test.close(); }
});

it('erases question drafts when the request expires or the account logs out', async () => {
  const requests=[reviewQuestions()];
  const test=await fixture({requests});
  try {
    await reviewReady(test); chooseAnswer(test,'卡片'); await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="继续下一题"]')?.getAttribute('aria-disabled')).not.toBe('true')); await test.click('继续下一题');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="回答：口令"]')).not.toBeNull());
    answerInput(test,'回答：口令','不应恢复');
    requests.splice(0); test.refresh();
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[data-testid="request-review-card"]')).toBeNull());
    requests.push(reviewQuestions()); test.refresh();
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[role="radio"]')).not.toBeNull());
    expect(test.dom.window.document.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
    await test.app().relay.logout(); await test.app().relay.connect(origin,'user-b','fixture-password');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[role="radio"]')).not.toBeNull());
    expect(test.dom.window.document.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
    expect(test.commands).toHaveLength(0); expect(test.errors).toEqual([]);
  } finally {test.close();}
});

it.each([false,true])('prepares a real plan without sending, preserves attachments, deduplicates and guards mode failures (%s)',async failMode=>{
  const review={turns:[reviewTurn()],mode:'plan' as const,failMode};
  const test=await fixture({review,controls:{active:false,text:'',images:[]},imagePicker:async()=>({canceled:false,assets:[draftImage()]})});
  try {
    await reviewReady(test); await addDraftImage(test); await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="移除 草稿 截图.png"]')).not.toBeNull());
    writeDraft(test,'保留我的补充'); await test.click('执行此方案');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[data-testid="prepared-plan"]')).not.toBeNull());
    expect(composer(test).value).toContain('保留我的补充'); expect(composer(test).value).toContain('review-plan');
    const original=composer(test).value; await test.click('执行此方案'); expect(composer(test).value).toBe(original); expect(test.commands).toHaveLength(0);
    expect(test.dom.window.document.querySelector('[aria-label="移除 草稿 截图.png"]')).not.toBeNull();
    await test.click('发送消息');
    await vi.waitFor(()=>expect(test.commands.some(c=>c.payload.type==='thread.mode.update')).toBe(true));
    if(failMode) {await vi.waitFor(()=>expect(test.dom.window.document.body.textContent).toContain('mode-rejected')); expect(test.commands.some(c=>c.payload.type==='turn.start')).toBe(false); expect(composer(test).value).toBe(original);}
    else {await vi.waitFor(()=>expect(test.commands.some(c=>c.payload.type==='turn.start')).toBe(true)); expect(test.commands.map(c=>c.payload.type)).toEqual(['thread.mode.update','turn.start']); expect(test.commands[1]!.payload).toMatchObject({text:original,images:[test.imageUploads[0]!.id]}); await vi.waitFor(()=>expect(composer(test).value).toBe(''));}
    expect(test.errors).toEqual([]);
  } finally {test.close();}
});

it('waits for an active task before executing a prepared plan and allows removing the pending tag',async()=>{
  const controls={active:true,text:'',images:[] as string[]};
  const test=await fixture({review:{turns:[reviewTurn()],mode:'plan'},controls});
  try {await reviewReady(test);await test.click('执行此方案');await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[data-testid="prepared-plan"]')?.textContent).toContain('等待当前任务结束'));await test.click('发送引导消息'); expect(test.commands).toHaveLength(0);await test.click('移除待执行方案');await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[data-testid="prepared-plan"]')).toBeNull());expect(composer(test).value).toContain('review-plan');expect(test.commands).toHaveLength(0);expect(test.errors).toEqual([]);}finally{test.close();}
});

it('keeps a failed plan submission and reports that the mode has already changed', async()=>{
  const test=await fixture({review:{turns:[reviewTurn()],mode:'plan'},submission:{fail:true}});
  try {await reviewReady(test);await test.click('执行此方案');await vi.waitFor(()=>expect(composer(test).value).toContain('review-plan'));await test.click('发送消息');await vi.waitFor(()=>expect(test.dom.window.document.body.textContent).toContain('已切换为默认模式'));expect(composer(test).value).toContain('review-plan');expect(test.dom.window.document.querySelector('[data-testid="prepared-plan"]')).not.toBeNull();expect(test.commands.map(c=>c.payload.type)).toEqual(['thread.mode.update','turn.start']);expect(test.errors).toEqual([]);}finally{test.close();}
});

it.each([true,false])('only makes explicit complete plan items executable (truncated=%s)',async truncated=>{
  const test=await fixture({review:{turns:[reviewTurn(truncated,truncated?'plan':'agentMessage')]}});
  try {await reviewReady(test);if(truncated){await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[data-testid="plan-review-card"]')).not.toBeNull());expect(test.dom.window.document.querySelector('[aria-label="执行此方案"]')?.getAttribute('aria-disabled')).toBe('true');expect(test.dom.window.document.querySelector('[aria-label="导出方案"]')?.getAttribute('aria-disabled')).toBe('true');expect(test.dom.window.document.body.textContent).toContain('方案内容已截断');await test.click('重新读取完整方案');await vi.waitFor(()=>expect(test.dom.window.document.body.textContent).toContain('当前历史仍未提供完整方案'));expect(test.dom.window.document.querySelector('[aria-label="导出方案"]')?.getAttribute('aria-disabled')).toBe('true');}else{expect(test.dom.window.document.querySelector('[data-testid="plan-review-card"]')).toBeNull();expect(test.dom.window.document.querySelector('[aria-label="执行此方案"]')).toBeNull();}expect(test.commands).toHaveLength(0);expect(test.errors).toEqual([]);}finally{test.close();}
});

it.each([undefined,'file-changed'])('reads versioned source from the real changed-file reader and reports changed files (%s)',async fileError=>{
  const fileCalls: {url:string;signal?:AbortSignal|null}[]=[];
  const test=await fixture({review:{turns:[reviewTurn()],fileCalls,fileError}});
  try {
    await reviewReady(test);await test.click('1 个文件已更改，查看差异');await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="src/示例.ts，查看差异"]')).not.toBeNull());await test.click('src/示例.ts，查看差异');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[data-testid="expanded-file-diff"]')).not.toBeNull());
    expect(test.dom.window.document.querySelector('[data-testid="expanded-file-diff"]')?.textContent).toContain('+new');
    expect(test.dom.window.document.querySelectorAll('.codexer-diff-gutter')).toHaveLength(10);
    await test.click('当前源码');await vi.waitFor(()=>expect(fileCalls).toHaveLength(2));expect(new URL(fileCalls[1]!.url).searchParams.get('version')).toBe('a'.repeat(64));
    if(fileError) await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('文件已更改'));
    else await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="src/示例.ts 源码"]')?.textContent).toContain('const value = 42;'));
    expect(test.errors).toEqual([]);
  }finally{test.close();}
});

it('cancels a slow source read on closing and discards its late response',async()=>{
  const wait=gate(),fileCalls:{url:string;signal?:AbortSignal|null}[]=[];
  const test=await fixture({review:{turns:[reviewTurn()],fileWait:wait.promise,fileCalls}});
  try {await reviewReady(test);await test.click('1 个文件已更改，查看差异');await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="src/示例.ts，查看差异"]')).not.toBeNull());await test.click('src/示例.ts，查看差异');await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="当前源码"]')).not.toBeNull());await test.click('当前源码');await vi.waitFor(()=>expect(fileCalls).toHaveLength(2));await test.closeDialog('关闭面板');expect(fileCalls[1]!.signal?.aborted).toBe(true);wait.release();await new Promise(resolve=>setTimeout(resolve,30));expect(test.dom.window.document.querySelector('[aria-label="src/示例.ts 源码"]')).toBeNull();expect(test.errors).toEqual([]);}finally{wait.release();test.close();}
});


it('retains question drafts while offline snapshots temporarily omit requests',async()=>{
  const requests=[reviewQuestions()];
  const test=await fixture({requests});
  try {
    await reviewReady(test);chooseAnswer(test,'卡片');await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="继续下一题"]')?.getAttribute('aria-disabled')).not.toBe('true'));await test.click('继续下一题');
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[aria-label="回答：口令"]')).not.toBeNull());answerInput(test,'回答：口令','等待恢复');
    test.current.devices=test.current.devices.map(device=>({...device,online:false}));requests.splice(0);test.refresh();
    await vi.waitFor(()=>expect(test.dom.window.document.querySelector('[data-testid="request-review-card"]')).toBeNull());
    requests.push(reviewQuestions());test.current.devices=test.current.devices.map(device=>({...device,online:true}));test.refresh();
    await vi.waitFor(()=>expect((test.dom.window.document.querySelector('[aria-label="回答：口令"]') as HTMLInputElement)?.value).toBe('等待恢复'));
    expect(test.commands).toHaveLength(0);expect(test.errors).toEqual([]);
  }finally{test.close();}
});
