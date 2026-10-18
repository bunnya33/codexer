import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { PcAgent } from '../apps/pc-agent/src/agent.js';
import { createRelay, RelayStore } from './go-relay.js';
import { testAccount, testAgent } from './account-helpers.js';
import { command, FakeDesktop, rawThread, waitFor, WsPeer } from './helpers.js';
import { UPLOAD_CHUNK_BYTES } from '../packages/protocol/src/uploads.js';
import { record } from '../packages/codex-adapter/src/normalize.js';

it('uploads chunks, scopes files to account/thread, and delivers verified local files through the real Agent, including its queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-attachments-'));
  const desktop = new FakeDesktop(); desktop.state = rawThread('idle');
  const store = await RelayStore.open(), owner = await testAccount(store), other = await testAccount(store, 'Other');
  const registered = await testAgent(store, owner.id), app = await createRelay({ store });
  let agent: PcAgent | undefined, peer: WsPeer | undefined;
  try {
    await desktop.start();
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const credentials = { relayUrl: base, deviceId: registered.id, session: registered.token, installationId: 'test', username: owner.name, expiresAt: Date.now() + 60000 };
    const catalog = { list: async () => ({ protocolVersion: 1 as const, deviceId: registered.id, generatedAt: 1, projects: [], threads: ['thread-test', 'other-thread'].map(id => ({ id, title: id, cwd: null, projectId: null, updatedAt: 1, archived: false })) }), history: async (threadId: string) => ({ threadId, generatedAt: 1, nextCursor: null, turns: [] }) };
    agent = new PcAgent(credentials, directory, ['thread-test'], desktop.endpoint, join(directory, 'empty'), 'desktop', catalog);
    await agent.start();
    await waitFor(async () => !!(await store.snapshot(registered.id))?.runtime.capabilities.attachments && !!await store.catalog(registered.id));
    const path = `/v1/devices/${registered.id}/threads/thread-test/attachments`;
    const content = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 71, 97);
    content.write('中文测试\n');
    const start = await app.inject({ method: 'POST', url: path, headers: owner.headers, payload: { name: '资料 with spaces.txt', size: content.length, mimeType: 'text/plain' } });
    expect(start.statusCode).toBe(200);
    const id = start.json().id as string;
    const agentUrl = `/v1/agent/${registered.id}/threads/thread-test/attachments/${id}`;
    expect((await app.inject({ url: agentUrl, headers: { authorization: `Bearer ${registered.token}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: path + '/' + id, headers: other.headers, payload: { offset: 0, base64: 'YQ==' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: path.replace('thread-test', 'other-thread') + '/' + id, headers: owner.headers, payload: { offset: 0, base64: 'YQ==' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: path + '/' + id, headers: owner.headers, payload: { offset: 1, base64: 'YQ==' } })).statusCode).toBe(409);
    for (let offset = 0; offset < content.length; offset += UPLOAD_CHUNK_BYTES) {
      const response = await app.inject({ method: 'PUT', url: path + '/' + id, headers: owner.headers, payload: { offset, base64: content.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString('base64') } });
      expect(response.statusCode).toBe(200);
      if (offset + UPLOAD_CHUNK_BYTES >= content.length) expect(response.json().attachment).toMatchObject({ id, name: '资料 with spaces.txt', sha256: createHash('sha256').update(content).digest('hex') });
    }
    expect((await app.inject({ url: agentUrl })).statusCode).toBe(401);
    expect((await app.inject({ url: agentUrl, headers: owner.headers })).statusCode).toBe(401);
    const downloaded = await app.inject({ url: agentUrl, headers: { authorization: `Bearer ${registered.token}` } });
    expect(downloaded.rawPayload).toEqual(content); expect(downloaded.headers['content-type']).toContain('application/octet-stream');
    expect(downloaded.headers['content-disposition']).toContain('attachment');
    const empty = await app.inject({ method: 'POST', url: path, headers: owner.headers, payload: { name: 'empty.txt', size: 0, mimeType: 'text/plain' } });
    const emptyId = empty.json().id;
    const finalizedEmpty = await app.inject({ method: 'PUT', url: path + '/' + emptyId, headers: owner.headers, payload: { offset: 0, base64: '' } });
    expect(finalizedEmpty.json().attachment.sha256).toBe(createHash('sha256').update('').digest('hex'));
    const dedup = command({ type: 'turn.start', threadId: 'thread-test', text: '', attachments: [id] }, agent.snapshot());
    expect((await app.inject({ method: 'POST', url: `/v1/devices/${registered.id}/commands`, headers: owner.headers, payload: { ...dedup, payload: { type: 'turn.start', threadId: 'thread-test', text: '' } } })).statusCode).toBe(400);
    const ticket = (await app.inject({ method: 'POST', url: '/v1/ws/tickets', headers: owner.headers })).json().ticket;
    peer = await WsPeer.open(base.replace('http:', 'ws:') + '/v1/ws/client');
    peer.send({ type: 'client.authenticate', ticket }); await peer.wait(m => m.type === 'client.authenticated');
    peer.send({ type: 'client.subscribe', deviceId: registered.id }); await peer.wait(m => m.type === 'sync.ready');
    const send = async (payload: Parameters<typeof command>[0]) => {
      const c = command(payload, agent!.snapshot()); peer!.send({ type: 'client.command', command: c });
      return record((await peer!.wait(m => m.type === 'command.result' && record(m.result).commandId === c.commandId)).result);
    };
    expect((await send({ type: 'turn.start', threadId: 'thread-test', text: '', attachments: [id] })).status).toBe('succeeded');
    const sent = desktop.received.find(m => m.method === 'thread-follower-start-turn')!;
    const inputs = record(record(record(sent.params).turnStart).request).input as { type: string; text: string }[];
    const attachmentText = inputs.find(input => input.text?.includes('附加文件'))!.text;
    const local = attachmentText.match(/\]\(<(.+)>\)/)![1]!;
    expect(await readFile(local)).toEqual(content);
    desktop.state = rawThread('active'); desktop.publishSnapshot();
    await waitFor(() => agent!.snapshot().threads['thread-test']?.status === 'active');
    expect(await send({ type: 'turn.queue', threadId: 'thread-test', text: '', attachments: ['b'.repeat(64)] })).toMatchObject({ status: 'failed', code: 'attachments-not-ready' });
    const queued = await send({ type: 'turn.queue', threadId: 'thread-test', text: '', attachments: [id] });
    expect(queued.status).toBe('succeeded');
    const queueId = record(queued.result).queueId as string;
    expect((await send({ type: 'turn.queue.read', threadId: 'thread-test', queueId })).result).toMatchObject({ text: '', attachments: [id] });
    expect((await send({ type: 'turn.queue.update', threadId: 'thread-test', queueId, text: '', expectedText: '' })).status).toBe('succeeded');
    expect((await app.inject({ method: 'DELETE', url: path + '/' + id, headers: owner.headers })).statusCode).toBe(200);
    // The queued message uses the verified PC copy after the Relay upload is removed.
    expect((await send({ type: 'turn.queue.steer', threadId: 'thread-test', turnId: 'turn-A', queueId })).status).toBe('succeeded');
    expect(desktop.received.some(m => m.method === 'thread-follower-steer-turn')).toBe(true);
    const bad = await app.inject({ method: 'POST', url: path, headers: owner.headers, payload: { name: '../escape.txt', size: 1, mimeType: 'text/plain' } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: path, headers: owner.headers, payload: { name: 'large.bin', size: 21 * 1024 * 1024, mimeType: 'x' } })).statusCode).toBe(400);
  } finally { peer?.socket.terminate(); await agent?.stop(); await app.close(); await desktop.close(); await rm(directory, { recursive: true, force: true }); }
});
