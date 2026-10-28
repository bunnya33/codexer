import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it, vi} from 'vitest';
import {PcAgent} from '../apps/pc-agent/src/agent.js';
import {loginAgent} from '../apps/pc-agent/src/auth.js';
import {HeadlessAdapter} from '../packages/codex-adapter/src/headless.js';
import {command, FakeDesktop, waitFor} from './helpers.js';
import {createRelay, RelayStore} from './go-relay.js';
import {testAccount, testPassword} from './account-helpers.js';

it('authorizes remote refresh, remembers deferral, preserves the device epoch and deduplicates retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-runtime-refresh-')), desktop = new FakeDesktop();
  const store = await RelayStore.open(), account = await testAccount(store), other = await testAccount(store, 'other'), app = await createRelay({store});
  let agent: PcAgent | undefined;
  try {
    await desktop.start();
    const base = await app.listen({host: '127.0.0.1', port: 0});
    const credentials = await loginAgent(base, join(directory, 'session'), account.name, testPassword);
    const reader = {list: async () => ({protocolVersion: 1 as const, deviceId: credentials.deviceId, generatedAt: Date.now(), projects: [], threads: []}), history: async () => {throw new Error('unused');}};
    agent = new PcAgent(credentials, directory, ['thread-test'], desktop.endpoint, join(directory, 'home'), 'desktop', reader);
    await agent.start(); await waitFor(() => !!agent!.snapshot().threads['thread-test'] && agent!.status().relayConnected);
    const headless = new HeadlessAdapter();
    const refresh = vi.spyOn(headless, 'refreshRuntime').mockResolvedValue('deferred');
    Object.assign(agent, {headless});
    const epoch = agent.snapshot().epoch;
    const input = command({type: 'runtime.refresh'}, agent.snapshot());
    const path = `/v1/devices/${credentials.deviceId}/commands`;
    expect((await app.inject({method: 'POST', url: path, headers: other.headers, payload: input})).statusCode).toBe(404);
    expect((await app.inject({method: 'POST', url: path, headers: account.headers, payload: {...input, payload: {type: 'runtime.refresh', binary: '/untrusted'}}})).statusCode).toBe(400);
    expect(refresh).not.toHaveBeenCalled();
    expect((await app.inject({method: 'POST', url: path, headers: account.headers, payload: input})).statusCode).toBe(200);
    const result = async () => (await app.inject({url: `${path}/${input.commandId}`, headers: account.headers})).json().result;
    await waitFor(async () => !!await result());
    expect(await result()).toMatchObject({status: 'succeeded', result: {runtimeRefresh: 'deferred'}});
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    // The next idle automatic check retains the user's explicit refresh request.
    refresh.mockResolvedValue('refreshed');
    await expect(agent.refreshRuntime()).resolves.toBe('refreshed');
    expect(refresh.mock.calls[1]).toEqual([true]);
    await app.inject({method: 'POST', url: path, headers: account.headers, payload: input});
    await agent.refreshRuntime(true); // Repeated requests also obey the successful-refresh cooldown.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(agent.snapshot().epoch).toBe(epoch);
    expect(agent.status()).toMatchObject({relayConnected: true, desktopConnected: true});
    expect(desktop.received.some(item => item.method === 'thread-follower-interrupt-turn')).toBe(false);
    // A connected older Agent cannot be sent the new operation.
    const legacy = structuredClone(agent.snapshot()); delete legacy.runtime.capabilities.runtimeRefresh;
    await store.saveSnapshot(legacy);
    const unsupported = await app.inject({method: 'POST', url: path, headers: account.headers, payload: command({type: 'runtime.refresh'}, legacy)});
    expect(unsupported.statusCode).toBe(409);
    Object.assign(agent, {lastRuntimeRefreshAt: 0});
    let finishCheck!: (result: 'unchanged') => void;
    refresh.mockImplementationOnce(() => new Promise(resolve => {finishCheck = resolve;}));
    const automatic = agent.refreshRuntime();
    await waitFor(() => typeof finishCheck === 'function');
    const manual = agent.refreshRuntime(true);
    finishCheck('unchanged');
    await automatic;
    await expect(manual).resolves.toBe('refreshed');
    expect(refresh.mock.calls.at(-1)).toEqual([true]);
  } finally {await agent?.stop(); await app.close(); await desktop.close(); await rm(directory, {recursive: true, force: true});}
});
