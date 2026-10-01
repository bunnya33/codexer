import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectorController, defaultSettings, safeCode, type Vault, type Worker } from '../apps/desktop/src/controller.js';
import type { AgentCredentials } from '../apps/pc-agent/src/auth.js';
import type { AgentStatus } from '../apps/desktop/src/types.js';
const idle: AgentStatus = { relayConnected: true, paused: false, sessionValid: true, desktopConnected: true, runtime: 'official-desktop-ipc', runtimeConnected: true, activeTasks: 0, threads: 1, updatedAt: Date.now() };
function fixture() {
  const settings = { ...defaultSettings(), relayUrl: 'https://relay.example.com' };
  let value: AgentCredentials | null = null;
  const vault: Vault = { available: () => true, read: async () => value, write: vi.fn(async next => { value = next; }), clear: vi.fn(async () => { value = null; }) };
  const worker: Worker = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), reconnect: vi.fn(async () => undefined) };
  const persist = vi.fn(async () => undefined), controller = new ConnectorController(vault, worker, settings, persist);
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(JSON.stringify(url.pathname.endsWith('login') ? { session: 'synthetic-session-secret', expiresAt: Date.now() + 100000, deviceId: randomUUID() } : { loggedOut: true }), { status: 200 })));
  return { vault, worker, persist, controller, settings, read: () => value };
}
afterEach(() => vi.unstubAllGlobals());
it('keeps credentials out of UI state, pauses without stopping local work and blocks runtime changes while active', async () => {
  const { controller, vault, worker, settings } = fixture();
  await controller.login('member', 'synthetic-password'); controller.update({ ...idle, activeTasks: 1 });
  expect(vault.write).toHaveBeenCalled(); expect(worker.start).toHaveBeenCalled();
  expect(JSON.stringify(controller.state())).not.toMatch(/synthetic-session-secret|synthetic-password/);
  await controller.disconnect(); expect(controller.state().phase).toBe('disconnected'); expect(worker.stop).not.toHaveBeenCalled();
  await expect(controller.save({ ...settings, runtime: 'headless' })).rejects.toThrow('本机仍有任务');
  await expect(controller.login('other', 'password')).rejects.toThrow('本机仍有任务');
  await controller.logout(); expect(vault.clear).toHaveBeenCalled(); expect(controller.state().loggedIn).toBe(false); expect(worker.stop).not.toHaveBeenCalled();
});
it('retains a valid saved account while starting disconnected unless auto-connect is enabled', async () => {
  const { controller, worker, read, vault, settings } = fixture();
  await controller.login('member', 'test-password');
  const saved = read()!; await controller.shutdown(); vi.mocked(worker.start).mockClear();
  const restored = new ConnectorController({ ...vault, read: async () => saved }, worker, settings, async () => undefined);
  await restored.initialize(); expect(restored.state().phase).toBe('disconnected'); expect(worker.start).not.toHaveBeenCalled();
  const automatic = new ConnectorController({ ...vault, read: async () => saved }, worker, { ...settings, autoConnect: true }, async () => undefined);
  await automatic.initialize(); expect(worker.start).toHaveBeenCalledOnce();
});
it('clears revoked sessions while keeping the local service alive', async () => {
  const { controller, worker, vault } = fixture(); await controller.login('member', 'password');
  controller.update({ ...idle, sessionValid: false, activeTasks: 1 });
  expect(controller.state().phase).toBe('signed-out'); expect(vault.clear).toHaveBeenCalled(); expect(worker.stop).not.toHaveBeenCalled();
  await expect(controller.connect()).rejects.toThrow('请先登录');
});
it('rejects public HTTP without explicit opt-in and refuses unsafe storage', async () => {
  const { controller, settings, vault, worker } = fixture();
  await expect(controller.save({ ...settings, relayUrl: 'http://relay.example.com' })).rejects.toThrow('relay-http');
  const insecure = new ConnectorController({ ...vault, available: () => false }, worker, settings, async () => undefined);
  await expect(insecure.login('member', 'password')).rejects.toThrow('系统安全存储'); expect(fetch).not.toHaveBeenCalled();
});
it('cancels a pending login on disconnect and revokes a late response instead of reconnecting', async () => {
  const { controller, worker, read } = fixture(); let resolveResponse!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname.endsWith('login') ? await new Promise<Response>(resolve => { resolveResponse = resolve; }) : new Response('{}')));
  const login = controller.login('member', 'password');
  await vi.waitFor(() => expect(resolveResponse).toBeTypeOf('function'));
  await controller.disconnect(); resolveResponse(new Response(JSON.stringify({ session: 'late-session', deviceId: randomUUID(), expiresAt: Date.now() + 100000 })));
  await login; expect(read()).toBeNull(); expect(worker.start).not.toHaveBeenCalled(); expect(controller.state().phase).toBe('signed-out');
  expect(vi.mocked(fetch).mock.calls.map(([url]) => (url as URL).pathname)).toEqual(['/v1/agents/login','/v1/auth/logout']);
});
it('logs only safe diagnostic codes', () => { expect(safeCode('https://relay.example.com bearer-secret')).toBe('diagnostic-redacted'); expect(safeCode('relay-connected')).toBe('relay-connected'); });
it('shows protocol rejection as paused while retaining the account and resumes without restarting local tasks', async () => {
  const {controller, worker, vault} = fixture(); await controller.login('member', 'password');
  controller.update({...idle, relayConnected: false, paused: true, activeTasks: 1, relayError: 'relay-rejected-invalid-message'});
  expect(controller.state()).toMatchObject({phase: 'disconnected', loggedIn: true});
  expect(controller.state().error).toContain('已暂停自动重连'); expect(vault.clear).toHaveBeenCalledTimes(1);
  await controller.reconnect(); controller.update({...idle, relayConnected: true, relayError: null});
  expect(controller.state()).toMatchObject({phase: 'connected', error: ''}); expect(worker.stop).not.toHaveBeenCalled(); expect(worker.reconnect).toHaveBeenCalled();
});
it('does not reconnect if disconnected while writing the final login settings', async () => {
  const { controller, persist, worker, read } = fixture(); let release!: () => void;
  persist.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); });
  const login = controller.login('member','password'); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await controller.disconnect(); release(); await login; expect(read()).toBeNull(); expect(worker.start).not.toHaveBeenCalled();
});
