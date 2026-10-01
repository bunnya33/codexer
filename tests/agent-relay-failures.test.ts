import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { PcAgent } from '../apps/pc-agent/src/agent.js';
import { FakeDesktop, waitFor } from './helpers.js';

it('pauses permanent rejection, redacts unknown reasons, preserves local tasks and login, then reconnects explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-relay-rejection-')), desktop = new FakeDesktop();
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  let agent: PcAgent | undefined, connections = 0;
  const logs: string[] = [];
  try {
    if (!server.address()) await new Promise<void>(resolve => server.once('listening', resolve));
    await desktop.start();
    const address = server.address() as {port: number};
    server.on('connection', socket => {
      connections++;
      socket.send(JSON.stringify({type: 'device.welcome', features: []}));
      if (connections === 1) setTimeout(() => socket.close(1008, 'invalid-device-state'), 80);
      if (connections === 2) setTimeout(() => socket.close(1008, 'secret https://relay.example.com'), 80);
    });
    const credentials = {relayUrl: `http://127.0.0.1:${address.port}`, deviceId: 'synthetic-device', session: 'synthetic-session', expiresAt: Date.now() + 100000, username: 'synthetic-user', installationId: 'synthetic-installation'};
    const reader = {list: async () => ({protocolVersion: 1 as const, deviceId: credentials.deviceId, generatedAt: 1, projects: [], threads: []}), history: async () => {throw new Error('unused');}};
    agent = new PcAgent(credentials, directory, ['thread-test'], desktop.endpoint, join(directory, 'empty'), 'desktop', reader);
    agent.on('diagnostic', ({code}) => logs.push(code)); await agent.start();
    await waitFor(() => !!agent!.status().paused);
    expect(agent.status()).toMatchObject({sessionValid: true, relayConnected: false, desktopConnected: true, activeTasks: 1, relayError: 'relay-rejected-invalid-device-state'});
    await new Promise(resolve => setTimeout(resolve, 1800)); expect(connections).toBe(1);
    agent.reconnect(); await waitFor(() => agent!.status().relayError === 'relay-rejected-policy');
    expect(logs.join(',')).not.toMatch(/secret|example\.com/);
    agent.reconnect(); await waitFor(() => connections === 3 && !!agent!.status().relayConnected);
    expect(agent.status()).toMatchObject({paused: false, sessionValid: true, activeTasks: 1, relayError: null});
  } finally { await agent?.stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await desktop.close(); await rm(directory, {recursive: true, force: true}); }
});

it('backs off repeated short connections after server storage errors instead of resetting on every handshake', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-relay-backoff-'));
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  let agent: PcAgent | undefined;
  const times: number[] = [], logs: string[] = [];
  try {
    if (!server.address()) await new Promise<void>(resolve => server.once('listening', resolve));
    const {port} = server.address() as {port: number};
    server.on('connection', socket => {
      times.push(Date.now()); socket.send(JSON.stringify({type: 'device.welcome', features: []}));
      setTimeout(() => socket.close(1011, 'storage-error'), 30);
    });
    const credentials = {relayUrl: `http://127.0.0.1:${port}`, deviceId: 'synthetic-device', session: 'synthetic-session', expiresAt: Date.now() + 100000, username: 'synthetic-user', installationId: 'synthetic-installation'};
    const reader = {list: async () => ({protocolVersion: 1 as const, deviceId: credentials.deviceId, generatedAt: 1, projects: [], threads: []}), history: async () => {throw new Error('unused');}};
    agent = new PcAgent(credentials, directory, [], join(directory, 'missing-endpoint'), join(directory, 'empty'), 'desktop', reader);
    agent.on('diagnostic', ({code}) => logs.push(code)); await agent.start();
    await waitFor(() => times.length >= 3, 8000);
    await waitFor(() => agent!.status().relayError === 'relay-storage-error');
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(2000);
    expect(agent.status()).toMatchObject({paused: false, sessionValid: true});
    expect(logs).toContain('relay-storage-error');
  } finally { await agent?.stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, {recursive: true, force: true}); }
});
