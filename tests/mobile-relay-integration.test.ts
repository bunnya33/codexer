import { testAccount, testAgent, testPassword } from './account-helpers.js';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { createRelay } from './go-relay.js';
import { hash, RelayStore } from './go-relay.js';
import { record } from '../packages/codex-adapter/src/normalize.js';
import { reduceEvent } from '../packages/protocol/src/index.js';
import { event, snapshot, waitFor, WsPeer } from './helpers.js';

vi.mock('../apps/mobile/src/runtime', () => ({ randomId: () => globalThis.crypto.randomUUID(), readCredentials: async () => null, saveCredentials: async () => {}, clearCredentials: async () => {} }));
import { RelayClient } from '../apps/mobile/src/relay.js';

it('keeps the shared client connected when REST overtakes real WebSocket replay, then reconnects and sends a command', async () => {
  const store = await RelayStore.open();
  const account = await testAccount(store); const headers = account.headers;
  const app = await createRelay({ store });
  const client = new RelayClient();
  let agent: WsPeer | undefined;
  const sockets: ClientSocket[] = [];
  const failures: unknown[] = [];
  let delayFirstSubscription = true;
  let overtakeReplay: () => Promise<void>;

  // Delay one outgoing subscription while a newer REST request completes.
  // All incoming frames, authentication, replay and limits use the real Relay.
  class ClientSocket {
    static OPEN = WebSocket.OPEN;
    readonly transport: WebSocket;
    readonly sent: Record<string, unknown>[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: () => void;
    constructor(url: string) {
      sockets.push(this);
      this.transport = new WebSocket(url, { perMessageDeflate: false });
      this.transport.on('open', () => this.onopen?.());
      this.transport.on('message', bytes => this.onmessage?.({ data: bytes.toString() }));
      this.transport.on('close', (code, reason) => this.onclose?.({ code, reason: reason.toString() }));
      this.transport.on('error', () => this.onerror?.());
    }
    get readyState() { return this.transport.readyState; }
    send(data: string) {
      const message = record(JSON.parse(data));
      this.sent.push(message);
      if (message.type === 'client.subscribe' && delayFirstSubscription) {
        delayFirstSubscription = false;
        void overtakeReplay().then(() => this.transport.send(data)).catch(error => failures.push(error));
      } else this.transport.send(data);
    }
    close() { this.transport.close(); }
  }

  vi.stubGlobal('WebSocket', ClientSocket);
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const registered = await testAgent(store, account.id); const token = registered.token, deviceId = registered.id;
    agent = await WsPeer.open(`${base.replace('http:', 'ws:')}/v1/ws/device`, { authorization: `Bearer ${token}`, 'x-device-id': deviceId });
    await agent.wait(message => message.type === 'device.welcome');
    let state = snapshot(deviceId);
    agent.send({ type: 'device.snapshot', snapshot: state });
    agent.send({ type: 'device.catalog', catalog: { protocolVersion: 1, deviceId, generatedAt: Date.now(), projects: [], threads: [] } });
    await waitFor(async () => !!await store.snapshot(deviceId) && !!await store.catalog(deviceId));
    const publishThrough = async (seq: number) => {
      while (state.lastSeq < seq) {
        const next = event(state, true);
        state = reduceEvent(state, next);
        agent!.send({ type: 'device.event', event: next });
      }
      await waitFor(async () => (await store.snapshot(deviceId))?.lastSeq === seq);
    };
    overtakeReplay = async () => {
      await publishThrough(80);
      await client.loadSnapshot(deviceId);
      expect(client.getSnapshot().snapshots[deviceId]?.lastSeq).toBe(80);
    };
    await client.connect(base, account.name, testPassword, false);
    const synchronized = (seq: number) => client.getSnapshot().phase === 'connected' && client.getSnapshot().snapshots[deviceId]?.lastSeq === seq && client.getSnapshot().syncing[deviceId] === false;
    await waitFor(() => synchronized(80));
    expect(failures).toEqual([]);
    expect(sockets[0]!.sent.filter(message => message.type === 'client.subscribe')).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(WebSocket.OPEN);
    expect(client.getSnapshot().devices[0]?.online).toBe(true);

    await publishThrough(81);
    await waitFor(() => synchronized(81));
    sockets[0]!.transport.close(1012, 'test-reconnect');
    await waitFor(() => client.getSnapshot().phase === 'reconnecting');
    expect(client.getSnapshot().devices[0]?.online).toBe(true);
    await expect(client.sendCommand(deviceId, { type: 'thread.watch', threadId: 'thread-test' })).rejects.toThrow('设备暂不可操作');
    await publishThrough(90);
    await waitFor(() => sockets.length === 2 && synchronized(90), 8000);
    expect(sockets[1]!.sent.filter(message => message.type === 'client.subscribe')).toHaveLength(1);

    // Real device loss still disables control and recovers when the Agent returns.
    await agent.close();
    await waitFor(() => client.getSnapshot().devices[0]?.online === false);
    await expect(client.sendCommand(deviceId, { type: 'thread.watch', threadId: 'thread-test' })).rejects.toThrow('设备暂不可操作');
    agent = await WsPeer.open(`${base.replace('http:', 'ws:')}/v1/ws/device`, { authorization: `Bearer ${token}`, 'x-device-id': deviceId });
    await agent.wait(message => message.type === 'device.welcome');
    agent.send({ type: 'device.snapshot', snapshot: state });
    await waitFor(() => client.getSnapshot().devices[0]?.online === true);

    const result = client.sendCommand(deviceId, { type: 'thread.watch', threadId: 'thread-test' });
    const request = await agent.wait(message => message.type === 'command');
    const commandId = record(request.command).commandId;
    agent.send({ type: 'command.result', result: { deviceId, commandId, status: 'succeeded', code: 'ok' } });
    await expect(result).resolves.toMatchObject({ commandId, status: 'succeeded' });
    expect(client.getSnapshot().notice).toBe('');
    expect(sockets).toHaveLength(2);
  } finally {
    client.disconnect();
    for (const socket of sockets) socket.transport.terminate();
    agent?.socket.terminate();
    await app.close();
    vi.unstubAllGlobals();
  }
}, 15000);

it.each([8, 256])('resumes after backgrounding with %i large updates using the latest state and accepts a command', async updates => {
  const store = await RelayStore.open();
  const account = await testAccount(store);
  const admin = await testAccount(store, 'diagnostics', 'admin');
  const app = await createRelay({ store });
  const client = new RelayClient();
  let agent: WsPeer | undefined;
  const sockets: ClientSocket[] = [];
  const closed: { code: number; reason: string }[] = [];
  let resumeRead: ReturnType<typeof setTimeout> | undefined;
  class ClientSocket {
    static OPEN = WebSocket.OPEN;
    readonly transport: WebSocket;
    readonly received: Record<string, unknown>[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: () => void;
    constructor(url: string) {
      sockets.push(this);
      this.transport = new WebSocket(url, { perMessageDeflate: false });
      this.transport.on('open', () => this.onopen?.());
      this.transport.on('message', bytes => {
        const data = bytes.toString();
        const message = record(JSON.parse(data));
        this.received.push(message);
        if (sockets.length === 2 && message.type === 'client.authenticated') {
          // Mobile JS/network delivery can be slow while the cached screen resumes.
          this.transport.pause();
          resumeRead = setTimeout(() => this.transport.resume(), 1500);
        }
        this.onmessage?.({ data });
      });
      this.transport.on('close', (code, reason) => {
        const event = { code, reason: reason.toString() };
        if (sockets.length >= 2) closed.push(event);
        this.onclose?.(event);
      });
      this.transport.on('error', () => this.onerror?.());
    }
    get readyState() { return this.transport.readyState; }
    send(data: string) { this.transport.send(data); }
    close() { this.transport.close(); }
  }
  vi.stubGlobal('WebSocket', ClientSocket);
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const { id: deviceId, token } = await testAgent(store, account.id);
    agent = await WsPeer.open(`${base.replace('http:', 'ws:')}/v1/ws/device`, { authorization: `Bearer ${token}`, 'x-device-id': deviceId });
    await agent.wait(message => message.type === 'device.welcome');
    let state = snapshot(deviceId);
    await store.saveSnapshot(state);
    await store.saveCatalog({ protocolVersion: 1, deviceId, generatedAt: Date.now(), projects: [], threads: [] });
    const synchronized = (seq: number) => client.getSnapshot().phase === 'connected' && client.getSnapshot().snapshots[deviceId]?.lastSeq === seq && client.getSnapshot().syncing[deviceId] === false;
    await client.connect(base, account.name, testPassword, false);
    await waitFor(() => synchronized(0));
    client.setAppState('background');
    await waitFor(() => sockets[0]!.readyState === WebSocket.CLOSED);
    const thread = {
      ...state.threads['thread-test']!,
      turns: [{ id: 'turn-A', status: 'inProgress', items: Array.from({ length: 16 }, (_, i) => ({ id: `item-${i}`, type: 'commandExecution', output: 'x'.repeat(8192), truncated: false })), plan: [], diff: '', truncated: false }],
    };
    for (let seq = 1; seq <= updates; seq++) {
      const next = { ...event(state, true), change: { type: 'thread.updated' as const, thread: { ...thread, revision: seq } } };
      await store.saveEvent(next);
      state = reduceEvent(state, next);
    }
    client.setAppState('active');
    await waitFor(() => closed.length > 0 || synchronized(updates), 8000);
    const diagnostics = await app.inject({ url: '/v1/admin/system/logs?code=backpressure', headers: admin.headers });
    expect(diagnostics.json().entries).toEqual([]);
    expect(closed).toEqual([]);
    expect(synchronized(updates)).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.readyState).toBe(WebSocket.OPEN);
    expect(sockets[1]!.received.find(message => message.type === 'sync.begin')?.mode).toBe('snapshot');
    expect(sockets[1]!.received.filter(message => message.type === 'device.event')).toEqual([]);
    await waitFor(() => client.getSnapshot().devices[0]?.online === true);
    const result = client.sendCommand(deviceId, { type: 'thread.watch', threadId: 'thread-test' });
    const request = await agent.wait(message => message.type === 'command');
    const commandId = record(request.command).commandId;
    agent.send({ type: 'command.result', result: { deviceId, commandId, status: 'succeeded', code: 'ok' } });
    await expect(result).resolves.toMatchObject({ commandId, status: 'succeeded' });
    expect(client.getSnapshot().notice).toBe('');
  } finally {
    if (resumeRead) clearTimeout(resumeRead);
    client.disconnect();
    for (const socket of sockets) socket.transport.terminate();
    agent?.socket.terminate();
    await app.close();
    vi.unstubAllGlobals();
  }
}, 30000);
