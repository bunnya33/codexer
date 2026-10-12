import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AdapterError } from '../../../packages/codex-adapter/src/desktop.js';
import { validProjectPath } from '../../../packages/client-shared/src/project-creation.js';

type Parent = { id: string; path: string; dev: number; ino: number };
const samePath = (a: string, b: string) => relative(a, b) === '';

export async function canonicalProjectParents(paths: string[]): Promise<string[]> {
  if (paths.length > 20) throw new Error('最多授权 20 个父目录。');
  return [...new Set(await Promise.all(paths.map(async path => {
    if (!isAbsolute(path)) throw new Error('请选择完整的本地目录路径。');
    try { const root = await realpath(path); if (!(await stat(root)).isDirectory()) throw new Error(); return root; }
    catch { throw new Error('授权目录不存在或无法访问，请重新选择。'); }
  })))];
}

export function projectPathParts(path: string): string[] {
  const parts = path.split('/');
  // Use the same portable names on all PCs, including Windows device names.
  if (!validProjectPath(path)) throw new AdapterError('project-path-invalid');
  return parts;
}

/** Authorizations are local, pinned to directory identity, and never accepted from Relay. */
export class ProjectDirectories {
  private parents: Parent[] = [];
  constructor(private readonly configured: readonly string[]) {}
  async initialize(): Promise<void> {
    this.parents = [];
    for (const path of this.configured.slice(0, 20)) {
      if (!isAbsolute(path)) continue;
      try {
        const root = await realpath(path), info = await stat(root);
        if (!info.isDirectory() || !samePath(path, root) || this.parents.some(parent => samePath(parent.path, root))) continue;
        this.parents.push({ path: root, dev: info.dev, ino: info.ino, id: createHash('sha256').update(root).digest('hex') });
      } catch { /* A missing local authorization stays unavailable. */ }
    }
  }
  private async validate(parent: Parent): Promise<void> {
    try {
      const info = await stat(parent.path), root = await realpath(parent.path);
      if (!info.isDirectory() || !samePath(root, parent.path) || info.dev !== parent.dev || info.ino !== parent.ino) throw new Error();
    } catch { throw new AdapterError('project-parent-unavailable'); }
  }
  async list(): Promise<{ id: string; path: string }[]> {
    const available = [];
    for (const parent of this.parents) {
      try { await this.validate(parent); available.push({ id: parent.id, path: parent.path }); } catch { /* Fail closed. */ }
    }
    return available;
  }
  async prepare(parentId: string, relativePath: string, mode: 'new' | 'existing', allowed: () => boolean = () => true): Promise<{ path: string; verify: () => Promise<void> }> {
    const parent = this.parents.find(item => item.id === parentId);
    if (!parent) throw new AdapterError('project-parent-not-authorized');
    const parts = projectPathParts(relativePath);
    const checkAllowed = () => { if (!allowed()) throw new AdapterError('remote-disconnected'); };
    const check = async (path: string) => {
      checkAllowed(); await this.validate(parent);
      const info = await lstat(path), resolved = await realpath(path);
      const inside = relative(parent.path, resolved);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(path, resolved) || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new AdapterError('project-path-not-allowed');
    };
    try {
      checkAllowed(); await this.validate(parent);
      let path = parent.path;
      for (const part of parts.slice(0, -1)) { path = join(path, part); await check(path); }
      const containing = path;
      path = join(path, parts.at(-1)!);
      if (mode === 'new') {
        await check(containing); checkAllowed();
        await mkdir(path, { mode: 0o700 });
      }
      await check(path);
      const identity = await stat(path);
      const verify = async () => {
        let current = parent.path;
        for (const part of parts) { current = join(current, part); await check(current); }
        const info = await stat(current);
        if (identity.dev !== info.dev || identity.ino !== info.ino) throw new AdapterError('project-path-not-allowed');
      };
      await verify();
      return { path, verify };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new AdapterError(code === 'EEXIST' ? 'project-folder-exists' : code === 'ENOENT' ? 'project-folder-not-found' : 'project-folder-unavailable');
    }
  }
}
