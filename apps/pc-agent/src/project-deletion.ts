import { randomUUID } from 'node:crypto';
import { lstat, opendir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { DeviceCatalog } from '../../../packages/protocol/src/index.js';
import { AdapterError } from '../../../packages/codex-adapter/src/desktop.js';

const inside = (parent: string, path: string) => {
  const part = relative(parent, path);
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
type Identity = { path: string; dev: number; ino: number };

/** Paths come exclusively from the official project catalog, never a remote payload. */
export class ProjectDirectoryDeletion {
  private readonly remaining = new Map<string, string>();
  private constructor(readonly roots: string[], private readonly identities: Identity[], private readonly protectedTrees: string[]) {
    for (const root of roots) this.remaining.set(root, root);
  }
  get remainingPaths(): string[] { return [...this.remaining.values()]; }

  static async prepare(catalog: DeviceCatalog, projectId: string, protectedTrees: string[]): Promise<ProjectDirectoryDeletion> {
    const project = catalog.projects.find(item => item.id === projectId);
    if (!project?.roots.length) throw new AdapterError('project-root-unavailable');
    const roots = project.roots.map(path => {
      if (!isAbsolute(path)) throw new AdapterError('project-directory-unsafe');
      return resolve(path);
    });
    const protectedPaths = await Promise.all([
      ...protectedTrees, dirname(process.execPath),
      ...[process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((value): value is string => !!value),
      ...(process.platform !== 'win32' ? ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/dev', '/proc', '/sys', '/boot', '/lib', '/lib64', '/var/db', '/var/log', '/private/var/db', '/private/var/log'] : []),
    ].map(async path => realpath(path).catch(() => resolve(path))));
    for (const root of roots) {
      const reserved = process.platform !== 'win32' && ['/tmp', '/var/tmp', '/private', '/private/tmp', '/private/var', '/private/var/tmp', '/Volumes', '/mnt', '/media', '/opt', '/srv'].some(path => relative(root, path) === '');
      if (reserved || relative(parse(root).root, root) === '' || inside(root, homedir()) || protectedPaths.some(path => overlaps(root, path))) throw new AdapterError('project-directory-protected');
      if (roots.some(other => other !== root && overlaps(root, other)) || roots.filter(other => other === root).length !== 1) throw new AdapterError('project-directory-shared');
      if (catalog.projects.some(other => other.id !== projectId && other.roots.some(path => isAbsolute(path) && overlaps(root, resolve(path)))) || catalog.threads.some(thread => thread.cwd && isAbsolute(thread.cwd) && inside(root, resolve(thread.cwd)))) throw new AdapterError('project-directory-shared');
    }
    const identities: Identity[] = [];
    try {
      // Pin every ancestor as well as the target; reject junctions and symlink parents.
      for (const root of roots) {
        let path = parse(root).root;
        const chain = [path];
        for (const part of relative(path, root).split(sep).filter(Boolean)) { path = join(path, part); chain.push(path); }
        for (const path of chain) {
          if (identities.some(item => relative(item.path, path) === '')) continue;
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink() || relative(path, await realpath(path)) !== '') throw new AdapterError('project-directory-unsafe');
          identities.push({ path, dev: info.dev, ino: info.ino });
        }
        if ((await lstat(root)).dev !== (await lstat(dirname(root))).dev) throw new AdapterError('project-directory-unsafe');
      }
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'project-folder-not-found' : 'project-folder-unavailable');
    }
    return new ProjectDirectoryDeletion(roots, identities, protectedPaths);
  }

  async verify(catalog: DeviceCatalog, projectId: string): Promise<void> {
    // Repeat protection and ownership checks against a fresh, complete catalog.
    const fresh = await ProjectDirectoryDeletion.prepare(catalog, projectId, this.protectedTrees);
    if (JSON.stringify(fresh.roots) !== JSON.stringify(this.roots)) throw new AdapterError('project-deletion-stale');
    for (const pinned of this.identities) {
      const current = fresh.identities.find(item => relative(item.path, pinned.path) === '');
      if (!current || current.dev !== pinned.dev || current.ino !== pinned.ino) throw new AdapterError('project-directory-changed');
    }
  }

  async remove(): Promise<void> {
    for (const root of this.roots) {
      for (const pinned of this.identities.filter(item => inside(item.path, root))) {
        const info = await lstat(pinned.path);
        if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== pinned.dev || info.ino !== pinned.ino || relative(pinned.path, await realpath(pinned.path)) !== '') throw new AdapterError('project-directory-changed');
      }
      const pinned = this.identities.find(item => relative(item.path, root) === '')!;
      // Do not recurse into a volume mounted inside the project. Child symlinks
      // are unlinked by rm, never traversed here.
      const pending = [root];
      let visited = 0;
      while (pending.length) {
        const directory = await opendir(pending.pop()!);
        for await (const child of directory) {
          if (++visited > 200_000) throw new AdapterError('project-directory-unsafe');
          if (!child.isDirectory() || child.isSymbolicLink()) continue;
          const path = join(directory.path, child.name), info = await lstat(path);
          if (info.isSymbolicLink()) continue;
          if (info.dev !== pinned.dev) throw new AdapterError('project-directory-unsafe');
          pending.push(path);
        }
      }
      // Move within the verified parent before recursive removal, then check identity
      // again. rm never follows child symlinks into another directory.
      const staged = join(dirname(root), `.codexer-delete-${randomUUID()}`);
      if (!isAbsolute(staged) || dirname(staged) !== dirname(root) || !inside(dirname(root), staged)) throw new AdapterError('project-directory-unsafe');
      await rename(root, staged);
      this.remaining.set(root, staged);
      const info = await lstat(staged);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== pinned.dev || info.ino !== pinned.ino) throw new AdapterError('project-directory-changed');
      // A failure leaves the remaining files here. Do not restore with rename:
      // Node has no cross-platform no-replace rename for a newly recreated root.
      await rm(staged, { recursive: true, force: false });
      this.remaining.delete(root);
    }
  }
}
