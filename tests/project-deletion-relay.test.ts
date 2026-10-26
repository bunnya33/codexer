import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PcAgent } from '../apps/pc-agent/src/agent.js';
import { loginAgent } from '../apps/pc-agent/src/auth.js';
import { HeadlessAdapter, normalizeOfficialCatalog } from '../packages/codex-adapter/src/headless.js';
import { AdapterError } from '../packages/codex-adapter/src/desktop.js';
import { record } from '../packages/codex-adapter/src/normalize.js';
import type { DeviceCatalog, ProjectDeletionPlan, RemoteCommand } from '../packages/protocol/src/index.js';
import type { ProjectDirectoryDeletion } from '../apps/pc-agent/src/project-deletion.js';
import { command, waitFor, WsPeer } from './helpers.js';
import { createRelay, RelayStore } from './go-relay.js';
import { testAccount, testPassword } from './account-helpers.js';

it('deletes empty projects through Relay with scoped confirmations, fresh checks, idempotency and stale-read protection', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codexer-delete-relay-')));
  const store = await RelayStore.open(), account = await testAccount(store), app = await createRelay({ store });
  let agent: PcAgent | undefined, peer: WsPeer | undefined, finishRead: (() => void) | undefined;
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const credentials = await loginAgent(base, join(directory, 'session'), account.name, testPassword);
    let rawProjects: Record<string, unknown>[] = [];
    for (const id of ['keep', 'remove', 'partial']) {
      const path = join(directory, id); await mkdir(path); await writeFile(join(path, 'file.txt'), id);
      rawProjects.push({ id, name: id, roots: [{ path }], position: rawProjects.length, updatedAt: 1 });
    }
    let rawThreads: Record<string, unknown>[] = [], rejectDelete = false, claimDirectory = false;
    const catalog = () => normalizeOfficialCatalog(credentials.deviceId, rawProjects, rawThreads);
    const reader = { list: vi.fn(async () => catalog()), history: async () => { throw new Error('unused'); } };
    agent = new PcAgent(credentials, join(directory, 'agent'), [], undefined, join(directory, 'home'), 'headless', reader);
    const internal = agent as unknown as { headless: HeadlessAdapter; refreshCatalog(): Promise<void>; projectDeletionPlans: Map<string, { plan: ProjectDeletionPlan; directory: ProjectDirectoryDeletion }> };
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'project/list') return { data: [...rawProjects], nextCursor: null };
      if (method === 'thread/list') return { data: rawThreads.filter(thread => thread.archived === params.archived), nextCursor: null };
      if (method === 'project/delete') {
        if (rejectDelete) throw new AdapterError('project/delete-rejected');
        const deleting = rawProjects.find(project => project.id === params.projectId)!;
        rawProjects = rawProjects.filter(project => project.id !== params.projectId);
        if (claimDirectory) rawProjects.push({ ...deleting, id: 'replacement' });
        return {};
      }
      throw new Error('unexpected-method');
    });
    Object.assign(internal.headless, { rpc: { request, stop: async () => {} } });
    vi.spyOn(internal.headless, 'connect').mockImplementation(async () => { internal.headless.connected = true; });
    await agent.start();
    const readCatalog = async () => (await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers: account.headers })).json().catalog as DeviceCatalog;
    await waitFor(async () => !!(await readCatalog())?.projectDeletion);
    const ticket = (await app.inject({ method: 'POST', url: '/v1/ws/tickets', headers: account.headers })).json().ticket;
    peer = await WsPeer.open(base.replace('http:', 'ws:') + '/v1/ws/client');
    peer.send({ type: 'client.authenticate', ticket }); await peer.wait(value => value.type === 'client.authenticated');
    peer.send({ type: 'client.subscribe', deviceId: credentials.deviceId }); await peer.wait(value => value.type === 'sync.ready');
    const submit = async (payload: RemoteCommand['payload']) => {
      const input = command(payload, agent!.snapshot()); peer!.send({ type: 'client.command', command: input });
      const result = record((await peer!.wait(value => value.type === 'command.result' && record(value.result).commandId === input.commandId)).result);
      return { input, result };
    };
    const prepare = async (projectId: string) => {
      const { result } = await submit({ type: 'project.delete.prepare', projectId });
      expect(result.status).toBe('succeeded'); return result.result as ProjectDeletionPlan;
    };
    const plan = await prepare('keep');
    expect(plan).toMatchObject({ projectId: 'keep', directoryDeletion: true, roots: [join(directory, 'keep')] });
    expect(await readFile(join(directory, 'keep', 'file.txt'), 'utf8')).toBe('keep');
    expect(request.mock.calls.some(([method]) => method === 'project/delete')).toBe(false);
    expect((await submit({ type: 'project.delete', projectId: 'remove', token: plan.token, deleteDirectory: true })).result).toMatchObject({ status: 'failed', code: 'project-deletion-stale' });
    const other = await testAccount(store, 'other');
    expect((await app.inject({ method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers: other.headers, payload: command({ type: 'project.delete', projectId: 'keep', token: plan.token, deleteDirectory: false }, agent.snapshot()) })).statusCode).toBe(404);
    rejectDelete = true;
    expect((await submit({ type: 'project.delete', projectId: 'keep', token: plan.token, deleteDirectory: true })).result).toMatchObject({ status: 'failed', code: 'project-deletion-rejected' });
    expect(await readFile(join(directory, 'keep', 'file.txt'), 'utf8')).toBe('keep'); rejectDelete = false;
    const deleted = await submit({ type: 'project.delete', projectId: 'keep', token: plan.token, deleteDirectory: false });
    expect(deleted.result).toMatchObject({ status: 'succeeded', result: { directoryDeleted: false } });
    expect((await readCatalog()).projects.some(project => project.id === 'keep')).toBe(false);
    expect(await readFile(join(directory, 'keep', 'file.txt'), 'utf8')).toBe('keep');
    const deleteCount = request.mock.calls.filter(([method]) => method === 'project/delete').length;
    peer.send({ type: 'client.command', command: deleted.input });
    await waitFor(() => peer!.messages.filter(value => value.type === 'command.result' && record(value.result).commandId === deleted.input.commandId).length === 2);
    expect(request.mock.calls.filter(([method]) => method === 'project/delete')).toHaveLength(deleteCount);
    expect((await app.inject({ method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers: account.headers, payload: { ...deleted.input, payload: { ...deleted.input.payload, deleteDirectory: true } } })).statusCode).toBe(409);

    rawThreads = [{ id: 'archived', projectId: 'remove', cwd: join(directory, 'remove'), name: 'Archived', archived: true }];
    expect((await submit({ type: 'project.delete.prepare', projectId: 'remove' })).result).toMatchObject({ status: 'failed', code: 'project-not-empty' });
    rawThreads = [];
    const stalePlan = await prepare('remove');
    rawThreads = [{ id: 'empty-thread', projectId: 'remove', cwd: join(directory, 'remove'), archived: false }];
    expect((await submit({ type: 'project.delete', projectId: 'remove', token: stalePlan.token, deleteDirectory: true })).result).toMatchObject({ status: 'failed', code: 'project-not-empty' });
    rawThreads = [];
    const expired = await prepare('remove'); internal.projectDeletionPlans.get(expired.token)!.plan.expiresAt = Date.now() - 1;
    expect((await submit({ type: 'project.delete', projectId: 'remove', token: expired.token, deleteDirectory: true })).result).toMatchObject({ status: 'failed', code: 'project-deletion-stale' });
    await rename(join(directory, 'remove'), join(directory, 'original')); await mkdir(join(directory, 'remove'));
    expect((await submit({ type: 'project.delete', projectId: 'remove', token: stalePlan.token, deleteDirectory: true })).result).toMatchObject({ status: 'failed', code: 'project-directory-changed' });
    await rm(join(directory, 'remove'), { recursive: true }); await rename(join(directory, 'original'), join(directory, 'remove'));

    const final = await prepare('remove'), before = catalog();
    reader.list.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finishRead = resolve; }); return before; });
    const reading = internal.refreshCatalog(); await waitFor(() => !!finishRead);
    const removed = await submit({ type: 'project.delete', projectId: 'remove', token: final.token, deleteDirectory: true });
    expect(removed.result).toMatchObject({ status: 'succeeded', result: { directoryDeleted: true } });
    await expect(stat(join(directory, 'remove'))).rejects.toMatchObject({ code: 'ENOENT' });
    finishRead!(); await reading;
    expect((await readCatalog()).projects.map(project => project.id)).toEqual(['partial']);
    const ackIndex = peer.messages.findIndex(value => value.type === 'command.result' && record(value.result).commandId === removed.input.commandId);
    expect(peer.messages.slice(0, ackIndex).some(value => value.type === 'catalog.updated')).toBe(true);

    const partial = await prepare('partial');
    vi.spyOn(internal.projectDeletionPlans.get(partial.token)!.directory, 'remove').mockRejectedValue(new Error('EPERM'));
    expect((await submit({ type: 'project.delete', projectId: 'partial', token: partial.token, deleteDirectory: true })).result).toMatchObject({ status: 'succeeded', result: { directoryDeleted: false, directoryError: 'project-directory-delete-failed' } });
    expect(await readFile(join(directory, 'partial', 'file.txt'), 'utf8')).toBe('partial');
    expect((await readCatalog()).projects).toEqual([]);
    expect((await submit({ type: 'thread.create', projectId: 'remove' })).result.status).toBe('failed');
    const claimedPath = join(directory, 'claimed'); await mkdir(claimedPath); await writeFile(join(claimedPath, 'keep.txt'), 'claimed');
    rawProjects.push({ id: 'claimed', name: 'Claimed', roots: [{ path: claimedPath }], position: 0, updatedAt: 1 });
    await internal.refreshCatalog();
    const claimed = await prepare('claimed'); claimDirectory = true;
    expect((await submit({ type: 'project.delete', projectId: 'claimed', token: claimed.token, deleteDirectory: true })).result).toMatchObject({ status: 'succeeded', result: { directoryDeleted: false, directoryError: 'project-directory-delete-failed' } });
    expect(await readFile(join(claimedPath, 'keep.txt'), 'utf8')).toBe('claimed');
  } finally { finishRead?.(); await peer?.close(); await agent?.stop(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
