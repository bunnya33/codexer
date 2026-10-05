import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PcAgent } from '../apps/pc-agent/src/agent.js';
import { loginAgent } from '../apps/pc-agent/src/auth.js';
import { createRelay } from '../apps/relay/src/server.js';
import { RelayStore } from '../apps/relay/src/storage/store.js';
import { command, FakeDesktop, rawThread, waitFor } from './helpers.js';
import { testAccount, testPassword } from './account-helpers.js';
import { CommandJournal } from '../apps/pc-agent/src/journal.js';
it('pauses remote control and queued starts while preserving a running local task, then resumes explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-disconnect-')), desktop = new FakeDesktop();
  const store = await RelayStore.open(), account = await testAccount(store), app = await createRelay({ store });
  let agent: PcAgent | undefined;
  try {
    await desktop.start(); const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const credentials = await loginAgent(base, join(directory,'session'), account.name, testPassword);
    const reader = { list: async () => ({ protocolVersion: 1 as const, deviceId: credentials.deviceId, generatedAt: Date.now(), projects: [], threads: [] }), history: async () => { throw new Error('unused'); } };
    agent = new PcAgent(credentials, directory, ['thread-test'], desktop.endpoint, join(directory,'empty'), 'desktop', reader);
    await agent.start(); await waitFor(() => !!agent!.snapshot().threads['thread-test']?.ownerAvailable && agent!.status().relayConnected);
    const submit = (payload: Parameters<typeof command>[0]) => app.inject({ method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers: account.headers, payload: command(payload, agent!.snapshot()) });
    expect((await submit({ type: 'turn.queue', threadId: 'thread-test', text: 'wait for idle' })).statusCode).toBe(200);
    await waitFor(() => !!agent!.snapshot().threads['thread-test']?.queuedMessages?.length);
    const epoch = agent.snapshot().epoch;
    agent.disconnect(); expect(agent.status()).toMatchObject({ paused: true, relayConnected: false, desktopConnected: true, activeTasks: 1 });
    await waitFor(async () => (await app.inject({ url: '/v1/devices', headers: account.headers })).json().devices[0]?.online === false);
    expect((await submit({ type: 'turn.interrupt', threadId: 'thread-test', turnId: 'turn-A' })).statusCode).toBe(409);
    desktop.state = rawThread('idle'); desktop.publishSnapshot(); await waitFor(() => agent!.status().activeTasks === 0);
    await new Promise(resolve => setTimeout(resolve,1600));
    expect(agent.status()).toMatchObject({ paused: true, relayConnected: false, desktopConnected: true });
    expect(desktop.received.filter(item => item.method === 'thread-follower-start-turn' || item.method === 'thread-follower-interrupt-turn')).toHaveLength(0);
    agent.reconnect(); await waitFor(() => desktop.received.some(item => item.method === 'thread-follower-start-turn'));
    expect(agent.snapshot().epoch).toBe(epoch); expect(agent.status().relayConnected).toBe(true);
  } finally { await agent?.stop(); await app.close(); await desktop.close(); await rm(directory,{recursive:true,force:true}); }
});

it('waits for an in-flight queued start before closing the command journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-stop-queue-')), desktop = new FakeDesktop();
  const store = await RelayStore.open(), account = await testAccount(store), app = await createRelay({ store });
  let agent: PcAgent | undefined, stopping: Promise<void> | undefined;
  let finishExecute = () => {};
  try {
    await desktop.start();
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const credentials = await loginAgent(base, join(directory, 'session'), account.name, testPassword);
    const reader = { list: async () => ({ protocolVersion: 1 as const, deviceId: credentials.deviceId, generatedAt: Date.now(), projects: [], threads: [] }), history: async () => { throw new Error('unused'); } };
    agent = new PcAgent(credentials, directory, ['thread-test'], desktop.endpoint, join(directory, 'empty'), 'desktop', reader);
    await agent.start();
    await waitFor(() => !!agent!.snapshot().threads['thread-test']?.ownerAvailable && agent!.status().relayConnected);
    const execution = new Promise<Record<string, unknown>>(resolve => { finishExecute = () => resolve({ turnId: 'queued-turn' }); });
    const execute = vi.spyOn(agent.adapter, 'execute').mockImplementation(() => execution);
    const queued = command({ type: 'turn.queue', threadId: 'thread-test', text: 'start after idle' }, agent.snapshot());
    const response = await app.inject({ method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers: account.headers, payload: queued });
    expect(response.statusCode).toBe(200);
    await waitFor(() => !!agent!.snapshot().threads['thread-test']?.queuedMessages?.length);
    desktop.state = rawThread('idle'); desktop.publishSnapshot();
    await waitFor(() => execute.mock.calls.length === 1);
    let settled = false;
    stopping = agent.stop().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const stoppedBeforeExecutionFinished = settled;
    finishExecute();
    await stopping;
    expect(stoppedBeforeExecutionFinished).toBe(false);
    const journal = new CommandJournal(join(directory, 'commands.sqlite'));
    try { expect(journal.queued('thread-test')).toEqual([]); }
    finally { journal.close(); }
  } finally {
    finishExecute(); await stopping; await agent?.stop(); await app.close(); await desktop.close(); await rm(directory, { recursive: true, force: true });
  }
});
