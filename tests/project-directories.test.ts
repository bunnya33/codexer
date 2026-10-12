import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalProjectParents, ProjectDirectories } from '../apps/pc-agent/src/project-directories.js';
import { validProjectPath } from '../packages/client-shared/src/project-creation.js';

const fixtures: string[] = [];
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codexer-projects-'))); fixtures.push(root);
  const parent = join(root, 'allowed'), outside = join(root, 'outside');
  await mkdir(parent); await mkdir(outside);
  const directories = new ProjectDirectories([parent]); await directories.initialize();
  const id = (await directories.list())[0]!.id;
  return { root, parent, outside, directories, id };
}
it('denies project creation by default and rejects remote absolute parent paths', async () => {
  const { parent, directories } = await fixture();
  const denied = new ProjectDirectories([]); await denied.initialize();
  expect(await denied.list()).toEqual([]);
  await expect(denied.prepare(parent, 'demo', 'new')).rejects.toMatchObject({ code: 'project-parent-not-authorized' });
  await expect(directories.prepare(parent, 'demo', 'new')).rejects.toMatchObject({ code: 'project-parent-not-authorized' });
});
it('creates one descendant and imports existing files without modifying them', async () => {
  const { parent, directories, id } = await fixture();
  await mkdir(join(parent, 'apps'));
  const created = await directories.prepare(id, 'apps/项目', 'new');
  expect(created.path).toBe(join(parent, 'apps/项目')); await created.verify();
  await writeFile(join(created.path, 'README.md'), 'keep me');
  await expect(directories.prepare(id, 'apps/项目', 'new')).rejects.toMatchObject({ code: 'project-folder-exists' });
  await expect(directories.prepare(id, 'apps/项目', 'existing')).resolves.toMatchObject({ path: created.path });
  expect(await readFile(join(created.path, 'README.md'), 'utf8')).toBe('keep me');
  await expect(directories.prepare(id, 'missing/demo', 'new')).rejects.toMatchObject({ code: 'project-folder-not-found' });
});
it.each(['../outside/demo', '/tmp/demo', 'apps/../../demo', 'apps//demo', './demo', 'C:/demo', 'C:\\demo', 'apps\\demo', 'nul', 'COM1.txt', 'bad\0name', 'bad.', 'bad ', ''])('rejects unsafe path %j before any filesystem creation', async path => {
  const { directories, id } = await fixture();
  expect(validProjectPath(path)).toBe(false);
  await expect(directories.prepare(id, path, 'new')).rejects.toMatchObject({ code: 'project-path-invalid' });
});
it('rejects directory symlinks, replaced authorizations and a replaced prepared folder', async () => {
  const { parent, outside, directories, id } = await fixture();
  await symlink(outside, join(parent, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(directories.prepare(id, 'escape/demo', 'new')).rejects.toMatchObject({ code: 'project-path-not-allowed' });
  await expect(directories.prepare(id, 'escape', 'existing')).rejects.toMatchObject({ code: 'project-path-not-allowed' });
  const prepared = await directories.prepare(id, 'demo', 'new');
  await rename(prepared.path, join(parent, 'original')); await mkdir(prepared.path);
  await expect(prepared.verify()).rejects.toMatchObject({ code: 'project-path-not-allowed' });
  await rename(parent, parent + '-old'); await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
  expect(await directories.list()).toEqual([]);
  await expect(directories.prepare(id, 'demo', 'new')).rejects.toMatchObject({ code: 'project-parent-unavailable' });
  const restarted = new ProjectDirectories([parent]); await restarted.initialize();
  expect(await restarted.list()).toEqual([]);
});
it('honors disconnect before creating and again before registering a prepared folder', async () => {
  const { directories, id } = await fixture();
  await expect(directories.prepare(id, 'demo', 'new', () => false)).rejects.toMatchObject({ code: 'remote-disconnected' });
  let allowed = true;
  const prepared = await directories.prepare(id, 'demo', 'new', () => allowed); allowed = false;
  await expect(prepared.verify()).rejects.toMatchObject({ code: 'remote-disconnected' });
});
it('normalizes locally chosen parents and refuses invalid local settings', async () => {
  const { parent, root } = await fixture();
  expect(await canonicalProjectParents([parent, parent])).toEqual([parent]);
  await expect(canonicalProjectParents(['relative'])).rejects.toThrow('完整');
  await expect(canonicalProjectParents([join(root, 'missing')])).rejects.toThrow('不存在');
});
