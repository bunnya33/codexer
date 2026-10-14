import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PcAgent } from '../apps/pc-agent/src/agent.js';
import { FileRegistry } from '../packages/codex-adapter/src/files.js';
import { FILE_CHUNK_BYTES } from '../packages/protocol/src/files.js';
import { createRelay, RelayStore } from './go-relay.js';
import { testAccount, testAgent } from './account-helpers.js';
import { FakeDesktop, waitFor } from './helpers.js';

it('streams and seeks cited audio through a real PC Agent, isolates capabilities and cancels closed playback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-audio-relay-'));
  const desktop = new FakeDesktop(), store = await RelayStore.open(), account = await testAccount(store), other = await testAccount(store, 'Other');
  const app = await createRelay({ store });
  const path = join(directory, '音乐 sample.WAV').replaceAll('\\', '/'), archive = join(directory, 'other.zip').replaceAll('\\', '/');
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES * 10 + 51);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  let agent: PcAgent | undefined, releaseRead: (() => void) | undefined;
  const originalRead = FileRegistry.prototype.read;
  let holdReads = false, blockedReads = 0;
  let pendingRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const readerSpy = vi.spyOn(FileRegistry.prototype, 'read').mockImplementation(async function(this: FileRegistry, thread, reference, offset, version) {
    if (holdReads && reference === path && offset !== undefined && offset > 0) { blockedReads++; await pendingRead; }
    return originalRead.call(this, thread, reference, offset, version);
  });
  try {
    await writeFile(path, bytes); await writeFile(archive, 'archive');
    const turns = desktop.state.turnHistory as { history: { entitiesByKey: Record<string, { items: unknown[] }> } };
    turns.history.entitiesByKey['turn-key']!.items = [{ id: 'audio', type: 'agentMessage', text: `![播放音乐](<${path}>)\n[其他文件](<${archive}>)`, phase: 'final_answer' }];
    await desktop.start();
    const base = await app.listen({ port: 0 }), registered = await testAgent(store, account.id);
    const reader = {
      list: async () => ({ protocolVersion: 1 as const, deviceId: registered.id, generatedAt: Date.now(), projects: [], threads: [{ id: 'thread-test', title: 'Audio', cwd: null, projectId: null, updatedAt: 1, archived: false }] }),
      history: async () => ({ threadId: 'thread-test', generatedAt: Date.now(), nextCursor: null, turns: [] }),
    };
    agent = new PcAgent({ relayUrl: base, deviceId: registered.id, session: registered.token, installationId: 'test', username: account.name, expiresAt: Date.now() + 60000 }, directory, ['thread-test'], desktop.endpoint, join(directory, 'empty'), 'desktop', reader);
    await agent.start();
    await waitFor(async () => !!(await store.snapshot(registered.id))?.threads['thread-test']?.turns[0]?.items.length);
    const endpoint = `/v1/devices/${registered.id}/threads/thread-test/files`;
    const info = (await app.inject({ url: endpoint + '/info?path=' + encodeURIComponent(path), headers: account.headers })).json();
    const create = (headers: Record<string, string> = account.headers, filePath = path, version = info.version) => app.inject({ method: 'POST', url: endpoint + '/audio', headers, payload: { path: filePath, version } });
    expect((await create(other.headers)).statusCode).toBe(404);
    expect((await create({}, path)).statusCode).toBe(401);
    expect((await create(account.headers, join(directory, 'uncited.wav'))).json().error).toBe('file-not-in-thread');
    expect((await create(account.headers, path, 'b'.repeat(64))).json().error).toBe('file-changed');
    const archiveInfo = (await app.inject({ url: endpoint + '/info?path=' + encodeURIComponent(archive), headers: account.headers })).json();
    expect((await create(account.headers, archive, archiveInfo.version)).json().error).toBe('unsupported-audio');
    const created = await create(); expect(created.statusCode).toBe(200);
    const playback = created.json().path as string;
    const held: string[] = [];
    for (let i = 0; i < 19; i++) held.push((await create()).json().path as string);
    expect((await create()).json().error).toBe('audio-busy');
    for (const token of held) await app.inject({ method: 'DELETE', url: token, headers: account.headers });
    expect(playback).toMatch(/^\/v1\/audio\/[a-f0-9]{64}$/);
    expect(JSON.stringify(created.json())).not.toContain(info.version);
    const head = await app.inject({ method: 'HEAD', url: playback, headers: { range: 'bytes=0-1' } });
    expect(head.statusCode).toBe(200); expect(head.body).toBe(''); expect(head.headers['content-length']).toBe(String(bytes.length));
    for (const [range, start, end] of [
      ['bytes=0-1', 0, 1],
      [`bytes=${FILE_CHUNK_BYTES - 7}-${FILE_CHUNK_BYTES + 9}`, FILE_CHUNK_BYTES - 7, FILE_CHUNK_BYTES + 9],
      [`bytes=${FILE_CHUNK_BYTES * 2}-`, FILE_CHUNK_BYTES * 2, bytes.length - 1],
      ['bytes=-51', bytes.length - 51, bytes.length - 1],
      [`bytes=${bytes.length - 5}-${bytes.length + 99}`, bytes.length - 5, bytes.length - 1],
    ] as const) {
      const result = await app.inject({ url: playback, headers: { range } });
      expect(result.statusCode).toBe(206); expect(result.rawPayload).toEqual(bytes.subarray(start, end + 1));
      expect(result.headers['content-range']).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(result.headers['content-length']).toBe(String(end - start + 1));
      expect(result.headers['content-type']).toBe('audio/wav'); expect(result.headers['accept-ranges']).toBe('bytes');
      expect(result.headers['cache-control']).toBe('no-store'); expect(result.headers['content-disposition']).toBeUndefined();
      expect(result.headers['set-cookie']).toBeUndefined();
    }
    const whole = await app.inject({ url: playback }); expect(whole.statusCode).toBe(200); expect(whole.rawPayload).toEqual(bytes);
    const invalid = await app.inject({ url: playback, headers: { range: `bytes=${bytes.length}-` } });
    expect(invalid.statusCode).toBe(416); expect(invalid.headers['content-range']).toBe(`bytes */${bytes.length}`); expect(invalid.rawPayload.length).toBe(0);
    expect((await app.inject({ url: playback + '?path=' + encodeURIComponent(archive), headers: { range: 'bytes=0-1' } })).rawPayload).toEqual(bytes.subarray(0, 2));
    expect((await app.inject({ method: 'DELETE', url: playback, headers: other.headers })).statusCode).toBe(404);
    holdReads = true;
    const active = await fetch(base + playback), stream = active.body!.getReader();
    expect((await stream.read()).value!.length).toBeGreaterThan(0);
    await waitFor(() => blockedReads > 0);
    await app.inject({ method: 'DELETE', url: playback, headers: account.headers });
    const completion = (async () => { while (!(await stream.read()).done) { /* Drain already-written bytes. */ } })();
    await expect(completion).rejects.toThrow();
    releaseRead!(); holdReads = false;
    expect((await app.inject({ url: playback })).statusCode).toBe(410);
    const changed = (await create()).json().path as string;
    await writeFile(path, 'changed');
    expect((await app.inject({ url: changed })).json().error).toBe('file-changed');
    await writeFile(path, bytes);
    const nextInfo = (await app.inject({ url: endpoint + '/info?path=' + encodeURIComponent(path), headers: account.headers })).json();
    const revoked = (await create(account.headers, path, nextInfo.version)).json().path as string;
    pendingRead = new Promise<void>(resolve => { releaseRead = resolve; });
    blockedReads = 0; holdReads = true;
    const activeAtLogout = await fetch(base + revoked), logoutStream = activeAtLogout.body!.getReader();
    await logoutStream.read(); await waitFor(() => blockedReads > 0);
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: account.headers });
    const stopped = (async () => { while (!(await logoutStream.read()).done) { /* Drain buffered data. */ } })();
    await expect(stopped).rejects.toThrow(); releaseRead!(); holdReads = false;
    expect((await app.inject({ url: revoked })).statusCode).toBe(410);
    const snapshot = JSON.stringify(await store.snapshot(registered.id));
    expect(snapshot).not.toContain(bytes.toString('base64')); expect(snapshot).not.toContain('/v1/audio/');
  } finally {
    releaseRead?.(); readerSpy.mockRestore();
    await agent?.stop(); await app.close(); await desktop.close(); await rm(directory, { recursive: true, force: true });
  }
}, 25000);
