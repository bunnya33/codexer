import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event, snapshot } from './helpers.js';

vi.mock('../apps/mobile/src/runtime', () => ({ randomId: () => '00000000-0000-4000-8000-000000000001', readCredentials: vi.fn(async () => null), saveCredentials: vi.fn(async () => undefined), clearCredentials: vi.fn(async () => undefined) }));
import { RelayClient, normalizeRelayUrl } from '../apps/mobile/src/relay.js';
import { clearCredentials, readCredentials, saveCredentials } from '../apps/mobile/src/runtime';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 0;
  sent: unknown[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) { FakeSocket.last = this; }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
let client: RelayClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new RelayClient();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === '/v1/auth/login') return response({ session: 'a'.repeat(40) });
    if (path === '/v1/auth/logout') return response({ loggedOut: true });
    if (path === '/v1/me') return response({ role: 'user' });
    if (path === '/v1/auth/active') return response({ expiresAt: Date.now() + 604800000, idleTimeoutMinutes: 10080 });
    if (path === '/v1/devices') return response({ devices: [{ id: 'device-test', name: 'Test Mac', platform: 'darwin', online: true }] });
    if (path === '/v1/devices/device-test/catalog') return response({ catalog: { protocolVersion: 1, deviceId: 'device-test', generatedAt: 1, projects: [], threads: [] } });
    if (path === '/v1/devices/device-test/snapshot') return response({ online: true, snapshot: snapshot() });
    if (path === '/v1/ws/tickets') return response({ ticket: 'one-use-test-ticket-xxxxxxxx' });
    if (path === '/v1/devices/device-test/commands' && options?.method === 'POST') return response({ type: 'command.accepted', commandId: '00000000-0000-4000-8000-000000000001' });
    throw new Error(`unexpected-request:${path}`);
  }));
});
afterEach(() => { client.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function connectedSocket() {
  await client.connect('http://192.0.2.10:8899', 'test', 'test-password-12345');
  const socket = FakeSocket.last;
  socket.open();
  socket.message({ type: 'client.authenticated' });
  await vi.waitFor(() => expect(client.getSnapshot().snapshots['device-test']).toBeDefined());
  socket.message({ type: 'sync.ready', deviceId: 'device-test', epoch: 'epoch-test', lastSeq: 0 });
  return socket;
}

it('accepts only a relay root URL', () => {
  expect(normalizeRelayUrl('http://192.0.2.10:8899/')).toBe('http://192.0.2.10:8899');
  expect(() => normalizeRelayUrl('http://user:secret@192.0.2.10:8899/')).toThrow();
  expect(() => normalizeRelayUrl('https://example.com/other')).toThrow();
});

it('authenticates with a one-use ticket, subscribes, and awaits a confirmed command', async () => {
  await client.connect('http://192.0.2.10:8899', 'test', 'test-password-12345');
  const socket = FakeSocket.last;
  expect(socket.url).toBe('ws://192.0.2.10:8899/v1/ws/client');
  socket.open();
  expect(socket.sent[0]).toEqual({ type: 'client.authenticate', ticket: 'one-use-test-ticket-xxxxxxxx' });
  socket.message({ type: 'client.authenticated' });
  expect(client.getSnapshot().phase).toBe('connected');
  expect(socket.sent).toContainEqual(expect.objectContaining({ type: 'client.subscribe', deviceId: 'device-test' }));
  await vi.waitFor(() => expect(client.getSnapshot().snapshots['device-test']).toBeDefined());
  socket.message({ type: 'sync.ready', deviceId: 'device-test', epoch: 'epoch-test', lastSeq: 0 });
  const result = client.sendCommand('device-test', { type: 'thread.watch', threadId: 'thread-test' });
  socket.message({ type: 'command.result', result: { commandId: '00000000-0000-4000-8000-000000000001', deviceId: 'device-test', status: 'succeeded', code: 'ok' } });
  await expect(result).resolves.toMatchObject({ status: 'succeeded' });
  client.disconnect();
  expect(client.getSnapshot().devices).toEqual([]);
  expect(client.getSnapshot().phase).toBe('locked');
});

it('ignores a device response after disconnecting', async () => {
  const originalFetch = globalThis.fetch;
  let reply!: (response: Response) => void;
  vi.stubGlobal('fetch', (input: string, options?: RequestInit) => new URL(input).pathname === '/v1/devices'
    ? new Promise<Response>(resolve => { reply = resolve; })
    : originalFetch(input, options));
  const connecting = client.connect('http://192.0.2.10:8899', 'test', 'test-password-12345');
  await vi.waitFor(() => expect(reply).toBeDefined());
  client.disconnect();
  reply(response({ devices: [{ id: 'device-test', name: 'Test Mac', platform: 'darwin', online: true }] }));
  await connecting;
  expect(client.getSnapshot()).toMatchObject({ phase: 'locked', devices: [], snapshots: {} });
});

it('restores saved login credentials and clears them when the Relay rejects the token', async () => {
  vi.mocked(readCredentials).mockResolvedValueOnce(JSON.stringify({ url: 'http://192.0.2.10:8899', session: 'a'.repeat(40) }));
  expect(await client.restore()).toBe(true);
  expect(saveCredentials).not.toHaveBeenCalled();
  FakeSocket.last.open();
  FakeSocket.last.message({ type: 'client.authenticated' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })));
  await expect(client.refreshDevices()).rejects.toThrow('unauthorized');
  expect(clearCredentials).toHaveBeenCalledOnce();
  expect(client.getSnapshot()).toMatchObject({ phase: 'locked', devices: [], notice: '登录已过期，请重新登录' });
});

it('does not fail an authenticated login when credential storage is unavailable', async () => {
  vi.mocked(saveCredentials).mockRejectedValueOnce(new Error('storage-blocked'));
  await expect(client.connect('http://192.0.2.10:8899', 'test', 'test-password-12345')).resolves.toBeUndefined();
  FakeSocket.last.open();
  FakeSocket.last.message({ type: 'client.authenticated' });
  expect(client.getSnapshot().phase).toBe('connected');
});

it('keeps a saved login through an offline restore and retries without requesting a password', async () => {
  vi.useFakeTimers();
  vi.mocked(readCredentials).mockResolvedValueOnce(JSON.stringify({url: 'http://relay.example', session: 'saved-account-session'}));
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network-unavailable'));
  expect(await client.restore()).toBe(true);
  expect(client.getSnapshot().phase).toBe('reconnecting');
  expect(clearCredentials).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  FakeSocket.last.open(); FakeSocket.last.message({type: 'client.authenticated'});
  expect(client.getSnapshot().phase).toBe('connected');
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/v1/auth/login'))).toBe(false);
});

it('only renews while in the foreground and reconnects a suspended socket on return', async () => {
  const original = await connectedSocket();
  vi.useFakeTimers();
  client.setForeground(false);
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(fetch).mockClear();
  await vi.advanceTimersByTimeAsync(90000);
  expect(fetch).not.toHaveBeenCalled();
  client.setForeground(true);
  await vi.advanceTimersByTimeAsync(0);
  const resumed = FakeSocket.last;
  expect(resumed).not.toBe(original);
  resumed.open(); resumed.message({type: 'client.authenticated'});
  expect(client.getSnapshot().phase).toBe('connected');
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/v1/auth/active'))).toBe(true);
  vi.mocked(fetch).mockClear();
  await vi.advanceTimersByTimeAsync(30000);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/v1/auth/active'))).toBe(true);
});

it('requires login after the server rejects an expired session on foreground return', async () => {
  await connectedSocket(); client.setForeground(false);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {status: 401})));
  client.setForeground(true);
  await vi.waitFor(() => expect(client.getSnapshot().phase).toBe('locked'));
  expect(clearCredentials).toHaveBeenCalledOnce();
});

it('does not request catalogs or history after logging out', async () => {
  await client.connect('http://192.0.2.10:8899', 'test', 'test-password-12345');
  client.disconnect(true);
  vi.mocked(fetch).mockClear();
  await client.loadCatalog('device-test');
  await client.loadHistory('device-test', 'thread-test');
  expect(fetch).not.toHaveBeenCalled();
  expect(client.getSnapshot()).toMatchObject({ phase: 'locked', notice: '', histories: {} });
});

it('keeps a new login when an old request returns unauthorized', async () => {
  await client.connect('http://192.0.2.10:8899', 'test', 'test-password-12345');
  const originalFetch = globalThis.fetch;
  let reply!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { reply = resolve; }));
  const oldRequest = client.refreshDevices();
  const oldResult = expect(oldRequest).rejects.toThrow('unauthorized');
  await client.connect('http://192.0.2.11:8899', 'b'.repeat(40));
  FakeSocket.last.open();
  FakeSocket.last.message({ type: 'client.authenticated' });
  reply(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
  await oldResult;
  expect(clearCredentials).not.toHaveBeenCalled();
  expect(client.getSnapshot()).toMatchObject({ phase: 'connected', url: 'http://192.0.2.11:8899', notice: '' });
  vi.stubGlobal('fetch', originalFetch);
});

it('ignores events already included in a REST snapshot instead of repeatedly subscribing', async () => {
  const socket = await connectedSocket();
  const latest = { ...snapshot(), lastSeq: 80, generatedAt: Date.now() };
  vi.mocked(fetch).mockResolvedValueOnce(response({ online: true, snapshot: latest }));
  await client.loadSnapshot('device-test');
  const sent = socket.sent.length;
  for (let seq = 1; seq <= 80; seq++) socket.message({ type: 'device.event', event: { ...event(snapshot()), seq } });
  expect(client.getSnapshot().snapshots['device-test']?.lastSeq).toBe(80);
  expect(socket.sent).toHaveLength(sent);
  expect(client.getSnapshot().syncing['device-test']).toBe(false);
});

it('keeps the newer snapshot when an older WebSocket snapshot arrives', async () => {
  const socket = await connectedSocket();
  socket.message({ type: 'device.event', event: event(snapshot()) });
  socket.message({ type: 'device.snapshot', snapshot: snapshot() });
  expect(client.getSnapshot().snapshots['device-test']?.lastSeq).toBe(1);
});

it('requests one full snapshot for a burst of missing events and resumes after reconciliation', async () => {
  const socket = await connectedSocket();
  const before = socket.sent.length;
  for (let seq = 3; seq <= 80; seq++) socket.message({ type: 'device.event', event: { ...event(snapshot()), seq } });
  expect(socket.sent.slice(before)).toEqual([{ type: 'client.subscribe', deviceId: 'device-test' }]);
  socket.message({ type: 'device.snapshot', snapshot: { ...snapshot(), lastSeq: 80 } });
  socket.message({ type: 'sync.ready', deviceId: 'device-test', epoch: 'epoch-test', lastSeq: 80 });
  socket.message({ type: 'device.event', event: { ...event(snapshot()), seq: 81 } });
  expect(client.getSnapshot().snapshots['device-test']?.lastSeq).toBe(81);
  expect(client.getSnapshot().syncing['device-test']).toBe(false);
});

it('does not overwrite live presence with an older device-list response', async () => {
  const socket = await connectedSocket();
  let reply!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { reply = resolve; }));
  const refreshing = client.refreshDevices();
  socket.message({ type: 'device.presence', deviceId: 'device-test', online: false });
  reply(response({ devices: [{ id: 'device-test', name: 'Test Mac', platform: 'darwin', online: true }] }));
  await refreshing;
  expect(client.getSnapshot().devices[0]?.online).toBe(false);
});

it('retains PC presence during client reconnect and ignores callbacks from the old socket', async () => {
  const socket = await connectedSocket();
  vi.useFakeTimers();
  socket.close();
  expect(client.getSnapshot()).toMatchObject({ phase: 'reconnecting', devices: [{ online: true }] });
  await expect(client.sendCommand('device-test', { type: 'thread.watch', threadId: 'thread-test' })).rejects.toThrow('设备暂不可操作');
  await vi.advanceTimersByTimeAsync(3000);
  const reconnect = FakeSocket.last;
  expect(reconnect).not.toBe(socket);
  reconnect.open();
  reconnect.message({ type: 'client.authenticated' });
  reconnect.message({ type: 'sync.ready', deviceId: 'device-test', epoch: 'epoch-test', lastSeq: 0 });
  reconnect.message({ type: 'device.presence', deviceId: 'device-test', online: true });
  socket.message({ type: 'device.presence', deviceId: 'device-test', online: false });
  socket.close();
  expect(client.getSnapshot()).toMatchObject({ phase: 'connected', devices: [{ online: true }] });
});

it('does not restore legacy access tokens or save the account password', async () => {
  vi.mocked(readCredentials).mockResolvedValueOnce(JSON.stringify({ url: 'http://relay.example', token: 'old-token' }));
  expect(await client.restore()).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  await client.connect('http://192.0.2.10:8899', 'test', 'test-password-12345');
  expect(saveCredentials).toHaveBeenCalledWith(JSON.stringify({ url: 'http://192.0.2.10:8899', session: 'a'.repeat(40) }));
});

it('lets an administrator use the same account-scoped PC client flow', async () => {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => new URL(input).pathname === '/v1/me' ? response({ role: 'admin' }) : original(input, options)));
  await client.connect('http://192.0.2.10:8899', 'admin', 'test-password-12345');
  FakeSocket.last.open(); FakeSocket.last.message({ type: 'client.authenticated' });
  expect(client.getSnapshot()).toMatchObject({ role: 'admin', phase: 'connected', devices: [{ id: 'device-test' }] });
});
