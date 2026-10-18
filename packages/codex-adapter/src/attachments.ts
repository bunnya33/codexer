import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { attachmentIdSchema, attachmentSchema, MAX_ATTACHMENTS } from '../../protocol/src/uploads.js';
import type { UserInput } from '../../codex-generated/src/v2/UserInput.js';

export class AttachmentInputs {
  constructor(private directory: string, private endpoint: (threadId: string, id: string) => { url: URL; token: string }) {}
  async prepare(threadId: string, ids: string[]): Promise<UserInput[]> {
    if (ids.length > MAX_ATTACHMENTS) throw new Error('invalid-attachment');
    const result: UserInput[] = [];
    for (const id of ids) {
      attachmentIdSchema.parse(id);
      const directory = join(this.directory, createHash('sha256').update(threadId).digest('hex'), id);
      const metadata = join(directory, 'reference.json');
      let ref;
      try {
        ref = attachmentSchema.parse(JSON.parse(await readFile(metadata, 'utf8')));
        const path = join(directory, 'content', this.safeName(ref.name));
        const stat = await lstat(path);
        if (ref.id !== id || !stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.size || createHash('sha256').update(await readFile(path)).digest('hex') !== ref.sha256) ref = undefined;
      } catch { ref = undefined; }
      if (!ref) {
        const { url, token } = this.endpoint(threadId, id);
        const headers = { authorization: `Bearer ${token}` }, signal = AbortSignal.timeout(60000);
        const info = new URL(url); info.searchParams.set('info', '1');
        const response = await fetch(info, { headers, signal, redirect: 'error' });
        if (!response.ok) throw new Error('attachments-not-ready');
        ref = attachmentSchema.parse(await response.json());
        if (ref.id !== id) throw new Error('invalid-attachment');
        const name = this.safeName(ref.name), contentDirectory = join(directory, 'content');
        await mkdir(contentDirectory, { recursive: true, mode: 0o700 });
        const path = join(contentDirectory, name), temporary = join(directory, randomUUID() + '.part');
        const file = await open(temporary, 'wx', 0o600);
        try {
          const download = await fetch(url, { headers, signal, redirect: 'error' });
          if (!download.ok || !download.body) throw new Error('attachments-not-ready');
          let size = 0; const hash = createHash('sha256');
          for await (const chunk of download.body) {
            size += chunk.length;
            if (size > ref.size) { await download.body.cancel().catch(() => {}); throw new Error('invalid-attachment'); }
            hash.update(chunk); await file.writeFile(chunk);
          }
          if (size !== ref.size || hash.digest('hex') !== ref.sha256) throw new Error('invalid-attachment');
          await file.sync(); await file.close();
          await rename(temporary, path);
          await writeFile(metadata, JSON.stringify(ref), { mode: 0o600 });
        } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
      }
      const path = join(directory, 'content', this.safeName(ref.name)).replaceAll('\\', '/');
      result.push({ type: 'text', text: `附加文件：[${ref.name.replace(/[\[\]\\]/g, '\\$&')}](<${path.replaceAll('>', '%3E')}>)`, text_elements: [] });
    }
    return result;
  }
  private safeName(name: string): string {
    let safe = name.replace(/[/\\\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, '');
    if (!safe || safe === '.' || safe === '..') safe = 'file';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = '_' + safe;
    while (Buffer.byteLength(safe, 'utf8') > 240) safe = safe.slice(0, -1);
    return safe;
  }
}
