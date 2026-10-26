import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectDirectoryDeletion } from '../apps/pc-agent/src/project-deletion.js';
import { HeadlessAdapter } from '../packages/codex-adapter/src/headless.js';
import { AdapterError } from '../packages/codex-adapter/src/desktop.js';
import type { DeviceCatalog } from '../packages/protocol/src/index.js';

const fixtures: string[] = [];
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codexer-delete-fixture-'))); fixtures.push(root);
  const project = join(root, 'project'), outside = join(root, 'outside');
  await mkdir(project); await mkdir(outside); await writeFile(join(project, 'file.txt'), 'project files'); await writeFile(join(outside, 'keep.txt'), 'outside');
  const catalog: DeviceCatalog = { protocolVersion: 1, deviceId: 'fixture', generatedAt: 1, projects: [{ id: 'empty', name: 'Empty', roots: [project], position: 0, updatedAt: 1 }], threads: [] };
  return { root, project, outside, catalog };
}
it('prepares without modifying files, removes only pinned project roots and leaves child symlink targets intact', async () => {
  const { project, outside, catalog } = await fixture();
  await symlink(outside, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const deletion = await ProjectDirectoryDeletion.prepare(catalog, 'empty', []);
  expect(await readFile(join(project, 'file.txt'), 'utf8')).toBe('project files');
  await deletion.verify(catalog, 'empty'); await deletion.remove();
  await expect(stat(project)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside');
});
it('rejects roots, home, protected trees, shared/nested projects and directory use by archived or unassigned threads', async () => {
  const { project, catalog } = await fixture();
  for (const path of [parse(project).root, homedir()]) await expect(ProjectDirectoryDeletion.prepare({ ...catalog, projects: [{ ...catalog.projects[0]!, roots: [path] }] }, 'empty', [])).rejects.toMatchObject({ code: 'project-directory-protected' });
  await expect(ProjectDirectoryDeletion.prepare(catalog, 'empty', [project])).rejects.toMatchObject({ code: 'project-directory-protected' });
  await expect(ProjectDirectoryDeletion.prepare(catalog, 'empty', [join(project, 'data')])).rejects.toMatchObject({ code: 'project-directory-protected' });
  for (const roots of [[project], [join(project, 'nested')]]) await expect(ProjectDirectoryDeletion.prepare({ ...catalog, projects: [...catalog.projects, { ...catalog.projects[0]!, id: 'other', roots }] }, 'empty', [])).rejects.toMatchObject({ code: 'project-directory-shared' });
  for (const archived of [false, true]) await expect(ProjectDirectoryDeletion.prepare({ ...catalog, threads: [{ id: 'thread', title: 'Thread', projectId: null, cwd: join(project, 'nested'), archived, updatedAt: 1 }] }, 'empty', [])).rejects.toMatchObject({ code: 'project-directory-shared' });
});
it('rejects junction roots/parents and replaces neither a swapped directory nor a new target', async () => {
  const { root, project, outside, catalog } = await fixture();
  const deletion = await ProjectDirectoryDeletion.prepare(catalog, 'empty', []);
  await rename(project, project + '-old'); await mkdir(project); await writeFile(join(project, 'keep.txt'), 'replacement');
  await expect(deletion.verify(catalog, 'empty')).rejects.toMatchObject({ code: 'project-directory-changed' });
  await expect(deletion.remove()).rejects.toMatchObject({ code: 'project-directory-changed' });
  expect(await readFile(join(project, 'keep.txt'), 'utf8')).toBe('replacement');
  const link = join(root, 'link'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(outside, 'nested'));
  for (const path of [link, join(link, 'nested')]) await expect(ProjectDirectoryDeletion.prepare({ ...catalog, projects: [{ ...catalog.projects[0]!, roots: [path] }] }, 'empty', [])).rejects.toMatchObject({ code: 'project-directory-unsafe' });
});
it('revalidates ownership, paths and presence after confirmation', async () => {
  const { project, outside, catalog } = await fixture();
  const deletion = await ProjectDirectoryDeletion.prepare(catalog, 'empty', []);
  await expect(deletion.verify({ ...catalog, projects: [...catalog.projects, { ...catalog.projects[0]!, id: 'new', roots: [project] }] }, 'empty')).rejects.toMatchObject({ code: 'project-directory-shared' });
  await expect(deletion.verify({ ...catalog, projects: [{ ...catalog.projects[0]!, roots: [outside] }] }, 'empty')).rejects.toMatchObject({ code: 'project-deletion-stale' });
  await rm(project, { recursive: true });
  await expect(ProjectDirectoryDeletion.prepare(catalog, 'empty', [])).rejects.toMatchObject({ code: 'project-folder-not-found' });
});

function adapterFixture() {
  const adapter = new HeadlessAdapter(); adapter.connected = true;
  let threads: Record<string, unknown>[] = [];
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === 'project/list') return { data: [{ id: 'project', name: 'Empty', roots: [{ path: join(tmpdir(), 'test-project') }], updatedAt: 1 }], nextCursor: null };
    if (method === 'thread/list') return { data: threads.filter(thread => thread.archived === params.archived && (thread.dbOnly !== true || params.useStateDbOnly === true)), nextCursor: null };
    if (method === 'project/delete') return {};
    throw new Error(`unexpected ${method}`);
  });
  Object.assign(adapter, { rpc: { request } });
  return { adapter, request, setThreads: (value: typeof threads) => { threads = value; } };
}
it('checks state DB, rollouts, archived records and every source before issuing the official deletion', async () => {
  const { adapter, request, setThreads } = adapterFixture();
  for (const archived of [true, false]) {
    setThreads([{ id: randomUUID(), projectId: 'project', cwd: join(tmpdir(), 'test-project'), archived, dbOnly: true }]);
    await expect(adapter.deleteProject('project', async () => {})).rejects.toMatchObject({ code: 'project-not-empty' });
  }
  expect(request.mock.calls.some(([method]) => method === 'project/delete')).toBe(false);
  expect(request.mock.calls.filter(([method]) => method === 'thread/list').every(([, params]) => (params.sourceKinds as string[]).includes('subAgentThreadSpawn'))).toBe(true);
  setThreads([]);
  const verify = vi.fn(async () => {});
  await adapter.deleteProject('project', verify);
  expect(verify).toHaveBeenCalledOnce(); expect(request).toHaveBeenLastCalledWith('project/delete', { projectId: 'project' }, 30000);
});
it('fails closed when enumeration, path verification or official deletion fails', async () => {
  const { adapter, request } = adapterFixture();
  await expect(adapter.deleteProject('missing', async () => {})).rejects.toMatchObject({ code: 'project-not-in-catalog' });
  await expect(adapter.deleteProject('project', async () => { throw new AdapterError('project-directory-changed'); })).rejects.toMatchObject({ code: 'project-directory-changed' });
  expect(request.mock.calls.some(([method]) => method === 'project/delete')).toBe(false);
  request.mockImplementation(async method => { if (method === 'thread/list') throw new AdapterError('unsupported'); return { data: [], nextCursor: null }; });
  await expect(adapter.deleteProject('project', async () => {})).rejects.toMatchObject({ code: 'unsupported' });
  const second = adapterFixture();
  const original = second.request.getMockImplementation()!;
  second.request.mockImplementation(async (method, params) => { if (method === 'project/delete') throw new AdapterError('project/delete-timeout', true); return original(method, params); });
  await expect(second.adapter.deleteProject('project', async () => {})).rejects.toMatchObject({ code: 'project-deletion-unconfirmed', uncertain: true });
});
it('does not truncate an invalid root list or treat malformed thread enumeration as an empty project', async () => {
  for (const malformed of ['roots', 'thread', 'page']) {
    const { adapter, request } = adapterFixture(), original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (malformed === 'roots' && method === 'project/list') return { data: [{ id: 'project', name: 'Too many roots', roots: Array.from({ length: 21 }, () => ({ path: tmpdir() })) }], nextCursor: null };
      if (malformed === 'thread' && method === 'thread/list') return { data: [{}], nextCursor: null };
      if (malformed === 'page' && method === 'thread/list') return {};
      return original(method, params);
    });
    await expect(adapter.deleteProject('project', async () => {})).rejects.toMatchObject({ code: malformed === 'page' ? 'catalog-response-invalid' : 'project-deletion-check-failed' });
    expect(request.mock.calls.some(([method]) => method === 'project/delete')).toBe(false);
  }
});
it('checks later pages before deciding that a project has no conversations', async () => {
  const { adapter, request } = adapterFixture(), original = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    if (method !== 'thread/list') return original(method, params);
    return params.cursor ? { data: [{ id: 'later', projectId: 'project', cwd: join(tmpdir(), 'test-project') }], nextCursor: null } : { data: [], nextCursor: 'next' };
  });
  await expect(adapter.deleteProject('project', async () => {})).rejects.toMatchObject({ code: 'project-not-empty' });
  expect(request.mock.calls.some(([method, params]) => method === 'thread/list' && params.cursor === 'next')).toBe(true);
  expect(request.mock.calls.some(([method]) => method === 'project/delete')).toBe(false);
});
