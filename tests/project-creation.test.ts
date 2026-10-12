import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PcAgent } from '../apps/pc-agent/src/agent.js';
import { loginAgent } from '../apps/pc-agent/src/auth.js';
import { HeadlessAdapter } from '../packages/codex-adapter/src/headless.js';
import { AdapterError } from '../packages/codex-adapter/src/desktop.js';
import type { DeviceCatalog, RemoteCommand } from '../packages/protocol/src/index.js';
import { record } from '../packages/codex-adapter/src/normalize.js';
import { command, waitFor, WsPeer } from './helpers.js';
import { createRelay, RelayStore } from './go-relay.js';
import { testAccount, testPassword } from './account-helpers.js';

it('forwards creation through Go Relay, enforces local roots, deduplicates and keeps new projects during an older catalog read', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codexer-create-project-')));
  const parent = join(directory, 'allowed'); await mkdir(parent);
  const store = await RelayStore.open(), account = await testAccount(store), app = await createRelay({ store });
  let agent: PcAgent | undefined, peer: WsPeer | undefined;
  let finishRead: (() => void) | undefined;
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const credentials = await loginAgent(base, join(directory, 'session'), account.name, testPassword);
    const empty: DeviceCatalog = { protocolVersion: 1, deviceId: credentials.deviceId, generatedAt: 1, projects: [], threads: [] };
    const reader = { list: vi.fn(async () => empty), history: async () => { throw new Error('unused'); } };
    agent = new PcAgent(credentials, join(directory, 'agent'), [], undefined, join(directory, 'home'), 'headless', reader, [parent]);
    const headless = (agent as unknown as { headless: HeadlessAdapter }).headless;
    const rawProjects: Record<string, unknown>[] = [];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'project/list') return { data: rawProjects, nextCursor: null };
      if (method === 'project/create') { const project = { id: randomUUID(), ...params, position: rawProjects.length, updatedAt: 1 }; rawProjects.push(project); return { project }; }
      throw new Error('unexpected-method');
    });
    Object.assign(headless, { rpc: { request, stop: async () => {} } });
    vi.spyOn(headless, 'connect').mockImplementation(async () => { headless.connected = true; });
    await agent.start();
    await waitFor(async () => (await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers: account.headers })).statusCode === 200);
    const catalog = (await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers: account.headers })).json().catalog as DeviceCatalog;
    const parentId = catalog.projectCreation!.parents[0]!.id;
    expect(catalog.projectCreation?.parents).toEqual([{ id: parentId, path: parent }]);
    const ticket = (await app.inject({ method: 'POST', url: '/v1/ws/tickets', headers: account.headers })).json().ticket;
    peer = await WsPeer.open(base.replace('http:', 'ws:') + '/v1/ws/client');
    peer.send({ type: 'client.authenticate', ticket }); await peer.wait(value => value.type === 'client.authenticated');
    peer.send({ type: 'client.subscribe', deviceId: credentials.deviceId }); await peer.wait(value => value.type === 'sync.ready');
    const payload: Extract<RemoteCommand['payload'], { type: 'project.create' }> = { type: 'project.create', parentId, name: 'Remote project', relativePath: 'demo', mode: 'new' };
    const submit = async (input: RemoteCommand) => {
      peer!.send({ type: 'client.command', command: input });
      return record((await peer!.wait(value => value.type === 'command.result' && record(value.result).commandId === input.commandId)).result);
    };
    expect(await submit(command({ ...payload, parentId: parent }, agent.snapshot()))).toMatchObject({ status: 'failed', code: 'project-parent-not-authorized' });
    expect(await submit(command({ ...payload, relativePath: '../outside' }, agent.snapshot()))).toMatchObject({ status: 'failed', code: 'project-path-invalid' });
    expect(request).not.toHaveBeenCalled();
    const input = command(payload, agent.snapshot()), result = await submit(input);
    expect(result.status).toBe('succeeded'); expect((await stat(join(parent, 'demo'))).isDirectory()).toBe(true);
    expect(request.mock.calls.find(([method]) => method === 'project/create')?.[1]).toMatchObject({ name: payload.name, roots: [{ path: join(parent, 'demo') }], idempotencyKey: `codexer:${credentials.deviceId}:${input.commandId}` });
    const projectId = record(result.result).projectId;
    const catalogIndex = peer.messages.findIndex(value => value.type === 'catalog.updated');
    const resultIndex = peer.messages.findIndex(value => value.type === 'command.result' && record(value.result).commandId === input.commandId);
    expect(catalogIndex).toBeGreaterThan(-1); expect(catalogIndex).toBeLessThan(resultIndex);
    expect((await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers: account.headers })).json().catalog.projects).toMatchObject([{ id: projectId }]);
    peer.send({ type: 'client.command', command: input });
    await waitFor(() => peer!.messages.filter(value => value.type === 'command.result' && record(value.result).commandId === input.commandId).length === 2);
    expect(rawProjects).toHaveLength(1);
    const other = await testAccount(store, 'other-account');
    expect((await app.inject({ method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers: other.headers, payload: command({ ...payload, relativePath: 'foreign' }, agent.snapshot()) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers: account.headers, payload: { ...input, payload: { ...payload, relativePath: 'different' } } })).statusCode).toBe(409);
    expect(await submit(command({ ...payload, name: 'Existing', mode: 'existing' }, agent.snapshot()))).toMatchObject({ status: 'succeeded', result: { projectId } });
    expect(rawProjects).toHaveLength(1);

    reader.list.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finishRead = resolve; }); return empty; });
    const reading = (agent as unknown as { refreshCatalog(): Promise<void> }).refreshCatalog();
    await waitFor(() => !!finishRead);
    const second = await submit(command({ ...payload, relativePath: 'second' }, agent.snapshot()));
    expect(second.status).toBe('succeeded'); finishRead!(); await reading;
    const updated = (await app.inject({ url: `/v1/devices/${credentials.deviceId}/catalog`, headers: account.headers })).json().catalog;
    expect(updated.projects).toHaveLength(2);
    agent.disconnect();
    expect((await app.inject({ method: 'POST', url: `/v1/devices/${credentials.deviceId}/commands`, headers: account.headers, payload: command({ ...payload, relativePath: 'paused' }, agent.snapshot()) })).statusCode).toBe(409);
  } finally { finishRead?.(); await peer?.close(); await agent?.stop(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

it('registers a project with bounded response validation and starts conversations with explicit execution permissions', async () => {
  const adapter = new HeadlessAdapter(), root = process.platform === 'win32' ? 'C:\\project' : '/project';
  const request = vi.fn(async (method: string) => method === 'project/list' ? { data: [], nextCursor: null } : method === 'project/create' ? { project: { id: 'p', name: 'Project', roots: [{ path: root }], position: 0 } } : { thread: { id: 't', cwd: root } });
  Object.assign(adapter, { connected: true, rpc: { request, stop: async () => {} } });
  try {
    await expect(adapter.createProject('Project', root, 'key', async () => {})).resolves.toMatchObject({ id: 'p', roots: [root] });
    await adapter.manage({ type: 'thread.create', projectId: 'p' }, [root]);
    expect(request).toHaveBeenCalledWith('thread/start', { projectId: 'p', cwd: root, runtimeWorkspaceRoots: [root], sandbox: 'workspace-write', approvalPolicy: 'on-request' }, 30000);
    request.mockImplementation(async method => method === 'project/list' ? { data: [], nextCursor: null } : { project: { name: 'Missing ID' } } as never);
    await expect(adapter.createProject('Project', root, 'key', async () => {})).rejects.toMatchObject({ code: 'incompatible-app-server-response', uncertain: true });
    request.mockRejectedValueOnce(new AdapterError('project/list-rejected:' + '/private/path/'.repeat(30)));
    await expect(adapter.createProject('Project', root, 'key', async () => {})).rejects.toMatchObject({ code: 'project-registration-rejected', uncertain: false });
  } finally { await adapter.stop(); }
});
