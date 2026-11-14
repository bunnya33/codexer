import { z } from 'zod';

export const DOWNLOAD_BLOCK_BYTES = 2 * 1024 * 1024;
const remoteSchema = z.object({
  relayUrl: z.string().url().max(2048), userId: z.string().min(1).max(200),
  path: z.string().max(16000).refine(path => /^\/v1\/(?:devices\/[^?#]+\/files\/content\?|client-releases\/[^/?#]+\/[^/?#]+\/download$)/.test(path) && !/[\r\n\\]/.test(path)),
});
export const downloadRecordSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().nonnegative(),
  name: z.string().min(1).max(255), size: z.number().int().min(0).max(512 * 1024 * 1024),
  received: z.number().int().nonnegative(), createdAt: z.number().finite(),
  state: z.enum(['paused', 'downloading', 'completed', 'failed']), error: z.string().max(1000),
  remote: remoteSchema.optional(), version: z.string().max(200).optional(),
  release: z.object({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
}).refine(item => item.received <= item.size);
export type DownloadRecord = z.infer<typeof downloadRecordSchema>;
export type DownloadRemote = NonNullable<DownloadRecord['remote']>;
export type DownloadSeed = Pick<DownloadRecord, 'name' | 'size' | 'remote' | 'version' | 'release'>;
export type DownloadItem = DownloadRecord & { transferred: number };
export type DownloadSnapshot = { ready: boolean; items: readonly DownloadItem[]; error: string };
export interface DownloadPorts {
  load(): Promise<DownloadRecord[]>;
  save(record: DownloadRecord): Promise<void>;
  size(id: string): Promise<number | null>;
  reset(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  block(record: DownloadRecord, start: number, end: number, signal: AbortSignal, progress: (written: number) => void): Promise<number>;
  id(): string;
  now(): number;
}

/** Validate ranges before writing them into an existing file. Never append a
 * full HTTP 200 response to a partial file when a server ignores Range. */
export function downloadResponseBytes(status: number, contentRange: string | undefined, length: number, start: number, end: number, total: number) {
  if (status === 200 && start === 0 && length === total) return length;
  if (status === 200) throw new Error('服务器暂不支持断点续传，请点「重新下载」。');
  if (status !== 206) throw new Error(status === 401 ? '登录已过期，请重新登录后继续。' : `下载失败：HTTP ${status}`);
  if (contentRange !== `bytes ${start}-${end}/${total}` || length !== end - start + 1)
    throw new Error('下载分段不完整或文件已变化，请重试。');
  return length;
}

export class DownloadManager {
  private state: DownloadSnapshot = { ready: false, items: [], error: '' };
  private listeners = new Set<() => void>();
  private initialization?: Promise<void>;
  private mutations: Promise<unknown> = Promise.resolve();
  private running = new Map<string, { controller: AbortController; promise: Promise<DownloadRecord> }>();
  private changing = new Set<string>();
  constructor(private ports: DownloadPorts) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<DownloadSnapshot>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private item(id: string) { const item = this.state.items.find(item => item.id === id); if (!item) throw new Error('下载记录已删除。'); return item; }
  private update(record: DownloadRecord, transferred = record.received) {
    const item = { ...record, transferred };
    this.emit({ items: [item, ...this.state.items.filter(value => value.id !== item.id)].sort((a, b) => b.createdAt - a.createdAt) });
  }
  private async save(record: DownloadRecord) {
    const next = downloadRecordSchema.parse({ ...record, revision: record.revision + 1 });
    await this.ports.save(next); this.update(next); return next;
  }
  initialize = async () => {
    if (this.state.ready) return;
    if (!this.initialization) this.initialization = this.restore().catch(error => {
      this.initialization = undefined;
      this.emit({ error: '读取下载列表失败，请重试。' }); throw error;
    });
    return this.initialization;
  };
  private async restore() {
    const loaded = await this.ports.load(), items: DownloadItem[] = [];
    for (const raw of loaded) {
      const result = downloadRecordSchema.safeParse(raw); if (!result.success) continue;
      let record = result.data;
      const size = await this.ports.size(record.id);
      if (record.state === 'completed' && size !== record.size) record = { ...record, state: 'failed', received: 0, error: '本地文件已丢失，请重新下载。' };
      else if (record.state !== 'completed') {
        record = { ...record, state: 'paused', error: '' };
        if (size === null || size < record.received || size > record.size) { await this.ports.reset(record.id); record.received = 0; }
      }
      items.push({ ...record, transferred: record.received });
    }
    this.emit({ ready: true, error: '', items: items.sort((a, b) => b.createdAt - a.createdAt) });
  }
  enqueue = async (seed: DownloadSeed): Promise<DownloadRecord> => {
    await this.initialize();
    const operation = this.mutations.catch(() => {}).then(async () => {
      const identity = (value: DownloadSeed) => JSON.stringify([value.remote, value.version, value.release, value.name, value.size]);
      const found = this.state.items.find(item => identity(item) === identity(seed) && !this.changing.has(item.id));
      if (found) return found;
      return this.save({ ...seed, id: this.ports.id(), revision: 0, received: 0, createdAt: this.ports.now(), state: 'paused', error: '' });
    });
    this.mutations = operation; return operation;
  };
  start = async (id: string): Promise<DownloadRecord> => {
    if (!this.state.ready) await this.initialize();
    if (this.changing.has(id)) throw new Error('正在管理此文件，请稍后重试。');
    const active = this.running.get(id); if (active) return active.promise;
    const controller = new AbortController();
    const promise = this.run(id, controller.signal).finally(() => { this.running.delete(id); });
    this.running.set(id, { controller, promise }); return promise;
  };
  private async run(id: string, signal: AbortSignal): Promise<DownloadRecord> {
    let item: DownloadRecord = this.item(id);
    try {
      if (item.state === 'completed' && await this.ports.size(id) === item.size) return item;
      if (!item.remote) throw new Error('文件来源不可用，请从原位置重新下载。');
      const size = await this.ports.size(id);
      if (size === null || size < item.received || size > item.size) { await this.ports.reset(id); item = { ...item, received: 0 }; }
      item = await this.save({ ...item, state: 'downloading', error: '' });
      while (item.received < item.size) {
        if (signal.aborted) throw new Error('下载已暂停');
        const start = item.received, end = Math.min(item.size - 1, start + DOWNLOAD_BLOCK_BYTES - 1);
        const count = await this.ports.block(item, start, end, signal, written => {
          if (!signal.aborted) this.update(item, Math.min(item.size, start + Math.max(0, written)));
        });
        if (signal.aborted) throw new Error('下载已暂停');
        if (!Number.isInteger(count) || count <= 0 || start + count > item.size) throw new Error('下载分段无效。');
        item = await this.save({ ...item, received: start + count });
      }
      if (signal.aborted) throw new Error('下载已暂停');
      if (item.size === 0) await this.ports.reset(id);
      if (await this.ports.size(id) !== item.size) throw new Error('文件下载不完整，请重新下载。');
      return await this.save({ ...item, state: 'completed', error: '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载失败，请重试。';
      try { await this.save({ ...item, state: signal.aborted ? 'paused' : 'failed', error: signal.aborted ? '' : message.slice(0, 1000) }); }
      catch { this.update({ ...item, state: 'failed', error: '下载进度未能保存，请检查存储空间后重试。' }); }
      throw error;
    }
  }
  pause = async (id: string) => {
    const active = this.running.get(id); if (!active) return;
    active.controller.abort(); await active.promise.catch(() => {});
  };
  pauseAll = async () => { await Promise.all([...this.running.keys()].map(id => this.pause(id))); };
  invalidate = async (id: string, error: string) => {
    await this.pause(id); await this.ports.reset(id);
    await this.save({ ...this.item(id), received: 0, state: 'failed', error });
  };
  remove = async (id: string) => {
    if (this.changing.has(id)) return;
    this.changing.add(id);
    try { await this.pause(id); await this.ports.remove(id); this.emit({ items: this.state.items.filter(item => item.id !== id) }); }
    finally { this.changing.delete(id); }
  };
  restart = async (id: string) => {
    if (this.changing.has(id)) throw new Error('正在管理此文件，请稍后重试。');
    this.changing.add(id);
    try { await this.pause(id); await this.ports.reset(id); await this.save({ ...this.item(id), received: 0, state: 'paused', error: '' }); }
    finally { this.changing.delete(id); }
    return this.start(id);
  };
}
