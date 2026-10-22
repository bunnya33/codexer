import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PcAgent } from '../apps/pc-agent/src/agent';
import { FileRegistry } from '../packages/codex-adapter/src/files';
import { FILE_CHUNK_BYTES } from '../packages/protocol/src/files';
import { createRelay, RelayStore } from './go-relay';
import { testAccount, testAgent } from './account-helpers';
import { FakeDesktop, waitFor } from './helpers';
import { silentWav } from './fixtures/audio-wav';

it('publicly shares only the chosen audio, persists expiry, seeks and cancels disabled or expired streams', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexer-audio-share-'));
  const path = join(directory, '音乐 & sample.WAV').replaceAll('\\', '/');
  const otherPath = join(directory, 'other.wav').replaceAll('\\', '/');
  const html = join(directory, 'page.html').replaceAll('\\', '/');
  const desktop = new FakeDesktop(), bytes = silentWav();
  let store = await RelayStore.open(undefined, join(directory, 'db'));
  const account = await testAccount(store), other = await testAccount(store, 'Other'), registered = await testAgent(store, account.id);
  let app = await createRelay({ store }), agent: PcAgent | undefined;
  let block = false, blocked = 0, release: (() => void) | undefined, pending: Promise<void>;
  const original = FileRegistry.prototype.read;
  const spy = vi.spyOn(FileRegistry.prototype, 'read').mockImplementation(async function(this: FileRegistry, thread, reference, offset, version) {
    if (block && reference === path && offset !== undefined && offset > 0) { blocked++; await pending; }
    return original.call(this, thread, reference, offset, version);
  });
  try {
    await writeFile(path, bytes); await writeFile(otherPath, 'private'); await writeFile(html, '<h1>Page</h1>');
    const turns = desktop.state.turnHistory as { history: { entitiesByKey: Record<string, { items: unknown[] }> } };
    turns.history.entitiesByKey['turn-key']!.items = [{ id: 'audio', type: 'agentMessage', text: `![音乐](<${path}>)\n[页面](<${html}>)`, phase: 'final_answer' }];
    await desktop.start(); const base = await app.listen({ port: 0 });
    const reader = {
      list: async () => ({ protocolVersion: 1 as const, deviceId: registered.id, generatedAt: Date.now(), projects: [], threads: [{ id: 'thread-test', title: 'Audio', cwd: null, projectId: null, updatedAt: 1, archived: false }] }),
      history: async () => ({ threadId: 'thread-test', generatedAt: Date.now(), nextCursor: null, turns: [] }),
    };
    agent = new PcAgent({ relayUrl: base, deviceId: registered.id, session: registered.token, installationId: 'test', username: account.name, expiresAt: Date.now() + 600000 }, directory, ['thread-test'], desktop.endpoint, join(directory, 'empty'), 'desktop', reader);
    await agent.start(); await waitFor(async () => !!(await store.snapshot(registered.id))?.threads['thread-test']?.turns[0]?.items.length);
    const endpoint = `/v1/devices/${registered.id}/threads/thread-test/preview-shares`;
    const create = (extra = {}, headers: Record<string, string> = account.headers) => app.inject({ method: 'POST', url: endpoint, headers, payload: { kind: 'audio', source: path, ...extra } });
    expect((await create({}, {})).statusCode).toBe(401);
    expect((await create({}, other.headers)).statusCode).toBe(404);
    expect((await create({ source: otherPath })).json().error).toBe('file-not-in-thread');
    expect((await create({ source: html })).statusCode).toBe(400);
    expect((await create({ durationMinutes: 0 })).statusCode).toBe(400);
    const result = await create(); expect(result.statusCode).toBe(200); const share = result.json();
    expect(share).toMatchObject({ kind: 'audio', enabled: true, durationMinutes: 30 });
    expect(share.expiresAt - Date.now()).toBeGreaterThan(29 * 60000);
    const metadata = () => app.inject({ url: endpoint + '?' + new URLSearchParams({ kind: 'audio', source: path }), headers: account.headers });
    expect((await metadata()).json().share.expiresAt).toBe(share.expiresAt);
    const page = await app.inject({ url: share.path });
    expect(page.statusCode).toBe(200); expect(page.body).toContain('音频分享');
    expect(page.body).toContain('音乐 &amp; sample.WAV'); expect(page.body).not.toContain(directory);
    expect(page.headers['content-security-policy']).toContain("media-src 'self'");
    expect(page.headers['set-cookie']).toBeUndefined(); expect(page.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ url: share.path + '/' })).statusCode).toBe(200);
    const audio = share.path + '/audio';
    const head = await app.inject({ method: 'HEAD', url: audio, headers: { range: 'bytes=0-1' } });
    expect(head.statusCode).toBe(200); expect(head.body).toBe(''); expect(head.headers['content-length']).toBe(String(bytes.length));
    for (const [range, start, end] of [['bytes=0-43', 0, 43], [`bytes=${FILE_CHUNK_BYTES - 7}-${FILE_CHUNK_BYTES + 9}`, FILE_CHUNK_BYTES - 7, FILE_CHUNK_BYTES + 9], ['bytes=-51', bytes.length - 51, bytes.length - 1]] as const) {
      const part = await app.inject({ url: audio, headers: { range } });
      expect(part.statusCode).toBe(206); expect(part.rawPayload).toEqual(bytes.subarray(start, end + 1));
      expect(part.headers['content-range']).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(part.headers['content-type']).toBe('audio/wav'); expect(part.headers['cache-control']).toBe('no-store');
    }
    expect((await app.inject({ url: audio })).rawPayload).toEqual(bytes);
    expect((await app.inject({ url: audio, headers: { range: `bytes=${bytes.length}-` } })).statusCode).toBe(416);
    expect((await app.inject({ url: audio + '?' + new URLSearchParams({ path: otherPath, kind: 'html' }), headers: { range: 'bytes=0-43' } })).rawPayload).toEqual(bytes.subarray(0, 44));
    const web = (await create({ kind: 'html', source: html })).json();
    expect((await app.inject({ url: web.path + '/audio' })).statusCode).toBe(410);
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: account.headers });
    expect((await app.inject({ url: audio, headers: { range: 'bytes=0-1' } })).statusCode).toBe(206);
    account.headers.authorization = `Bearer ${(await store.createSession(account.id)).session}`;
    const updated = silentWav(2); await writeFile(path, updated);
    expect((await app.inject({ url: audio })).rawPayload).toEqual(updated);
    await writeFile(path, bytes);
    // The key and deadline survive a Relay restart without renewing.
    await app.close(); store = await RelayStore.open(undefined, join(directory, 'db')); app = await createRelay({ store });
    await app.listen({ port: Number(new URL(base).port) }); agent.reconnect();
    await waitFor(async () => !!agent!.status().relayConnected && (await app.inject({ url: share.path })).statusCode === 200, 10000);
    expect((await metadata()).json().share.expiresAt).toBe(share.expiresAt);
    // Expiration/disable must stop a stream waiting for another PC chunk.
    for (const mode of ['disable', 'expire'] as const) {
      const renewed = (await create({ durationMinutes: 1 })).json(); expect(renewed.path).toBe(share.path);
      if (mode === 'expire') await store.query('UPDATE preview_shares SET expires_at=$1 WHERE id=$2', [Date.now() + 900, share.id]);
      blocked = 0; block = true; pending = new Promise<void>(done => { release = done; });
      const active = await fetch(base + audio), stream = active.body!.getReader();
      expect((await stream.read()).value!.length).toBeGreaterThan(0); await waitFor(() => blocked > 0);
      if (mode === 'disable') {
        expect((await app.inject({ method: 'DELETE', url: `/v1/devices/${registered.id}/preview-shares/${share.id}`, headers: other.headers })).statusCode).toBe(404);
        await app.inject({ method: 'DELETE', url: `/v1/devices/${registered.id}/preview-shares/${share.id}`, headers: account.headers });
      }
      await expect((async () => { while (!(await stream.read()).done) { /* Drain buffered data. */ } })()).rejects.toThrow();
      release!(); block = false;
      expect((await app.inject({ url: audio })).statusCode).toBe(410);
      expect((await app.inject({ url: share.path })).statusCode).toBe(410);
      expect((await metadata()).json().share.enabled).toBe(false);
    }
    const reopened = (await create({ durationMinutes: 1440 })).json(); expect(reopened.path).toBe(share.path); expect(reopened.durationMinutes).toBe(1440);
    const rotated = (await create({ rotate: true, durationMinutes: 75 })).json(); expect(rotated.path).not.toBe(share.path);
    expect((await app.inject({ url: audio })).statusCode).toBe(410);
    expect((await app.inject({ url: rotated.path + '/audio', headers: { range: 'bytes=0-1' } })).statusCode).toBe(206);
    agent.disconnect(); await waitFor(async () => !(await app.inject({ url: '/v1/devices', headers: account.headers })).json().devices[0].online);
    expect((await app.inject({ url: rotated.path })).statusCode).toBe(503);
    agent.reconnect(); await waitFor(async () => (await app.inject({ url: rotated.path })).statusCode === 200, 10000);
    await store.query('UPDATE users SET revoked_at=$1 WHERE id=$2', [Date.now(), account.id]);
    expect((await app.inject({ url: rotated.path + '/audio' })).statusCode).toBe(410);
  } finally {
    release?.(); spy.mockRestore(); await agent?.stop(); await app.close(); await desktop.close(); await rm(directory, { recursive: true, force: true });
  }
}, 40000);
