import { expect, it } from 'vitest';
import { DOWNLOAD_BLOCK_BYTES as B, DownloadManager, downloadRecordSchema, downloadResponseBytes } from '../packages/client-shared/src/downloads';
import type { DownloadPorts, DownloadRecord, DownloadSeed } from '../packages/client-shared/src/downloads';

const remote = { relayUrl: 'https://relay.test', userId: 'user-a', path: '/v1/client-releases/control-android/00000000-0000-4000-8000-000000000001/download' };
const seed = (size: number): DownloadSeed => ({ name: '应用.apk', size, version: 'a'.repeat(64), remote });
function fixture(size = B * 2 + 71) {
  const data = Buffer.alloc(size); for (let i = 0; i < size; i++) data[i] = i % 251;
  const records = new Map<string, string>(), files = new Map<string, Buffer>(), requests: number[] = [];
  let sequence = 0;
  const ports: DownloadPorts = {
    load: async () => [...records.values()].map(value => JSON.parse(value)),
    save: async record => { records.set(record.id, JSON.stringify(record)); },
    size: async id => files.get(id)?.length ?? null,
    reset: async id => { files.set(id, Buffer.alloc(0)); },
    remove: async id => { files.delete(id); records.delete(id); },
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, now: () => sequence,
    block: async (record, start, end, signal, progress) => {
      requests.push(start); if (signal.aborted) throw Error('aborted');
      const piece = data.subarray(start, end + 1), old = files.get(record.id) ?? Buffer.alloc(0);
      const next = Buffer.alloc(Math.max(old.length, start + piece.length)); old.copy(next); piece.copy(next, start);
      files.set(record.id, next); progress(piece.length); return piece.length;
    },
  };
  return { data, files, records, requests, ports, manager: new DownloadManager(ports) };
}

it('persists a file in bounded blocks and reuses a completed download without another request', async () => {
  const f = fixture(), item = await f.manager.enqueue(seed(f.data.length));
  await f.manager.start(item.id);
  expect(f.requests).toEqual([0, B, B * 2]); expect(f.files.get(item.id)).toEqual(f.data);
  expect(f.manager.getSnapshot().items[0]).toMatchObject({ state: 'completed', received: f.data.length });
  expect((await f.manager.enqueue(seed(f.data.length))).id).toBe(item.id);
  await f.manager.start(item.id); expect(f.requests).toHaveLength(3);
  expect([...f.records.values()].join('')).not.toMatch(/Authorization|Bearer/);
});

it('restores after an abrupt process exit and overwrites uncommitted bytes from the last checkpoint', async () => {
  const f = fixture(), block = f.ports.block, item = await f.manager.enqueue(seed(f.data.length));
  let reached!: () => void; const started = new Promise<void>(done => { reached = done; });
  f.ports.block = async (record, start, end, signal, progress) => {
    if (start === B) {
      // The OS killed the old process here: some bytes reached disk, but no
      // callback/checkpoint can run in that process ever again.
      f.files.set(record.id, Buffer.concat([f.data.subarray(0, B), Buffer.alloc(217, 255)]));
      progress(217); reached(); return new Promise<number>(() => {});
    }
    return block(record, start, end, signal, progress);
  };
  void f.manager.start(item.id); await started;
  expect(JSON.parse(f.records.get(item.id)!).received).toBe(B);
  f.ports.block = block;
  const restarted = new DownloadManager(f.ports); await restarted.initialize();
  expect(restarted.getSnapshot().items[0]).toMatchObject({ state: 'paused', received: B });
  f.requests.length = 0; await restarted.start(item.id);
  expect(f.requests).toEqual([B, B * 2]); expect(f.files.get(item.id)).toEqual(f.data);
});

it('pauses an active request, keeps completed blocks, and resumes after a manager restart', async () => {
  const f = fixture(), block = f.ports.block, item = await f.manager.enqueue(seed(f.data.length));
  let reached!: () => void; const started = new Promise<void>(done => { reached = done; });
  f.ports.block = async (record, start, end, signal, progress) => {
    if (start !== B) return block(record, start, end, signal, progress);
    progress(100); reached();
    return new Promise<number>((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
  };
  const downloading = f.manager.start(item.id); const rejected = expect(downloading).rejects.toThrow('aborted');
  await started; await f.manager.pause(item.id); await rejected;
  expect(f.manager.getSnapshot().items[0]).toMatchObject({ state: 'paused', received: B, transferred: B });
  f.ports.block = block; const again = new DownloadManager(f.ports); await again.initialize();
  await again.start(item.id); expect(f.files.get(item.id)).toEqual(f.data);
});

it('handles a crash after the final block before completion without redownloading', async () => {
  const f = fixture(17), item = await f.manager.enqueue(seed(17));
  f.files.set(item.id, f.data);
  f.records.set(item.id, JSON.stringify({ ...item, received: 17, state: 'downloading' }));
  const next = new DownloadManager(f.ports); await next.initialize(); await next.start(item.id);
  expect(f.requests).toEqual([]); expect(next.getSnapshot().items[0]?.state).toBe('completed');
});

it('drops missing partial prefixes instead of appending at a stale offset', async () => {
  const f = fixture(), item = await f.manager.enqueue(seed(f.data.length));
  f.records.set(item.id, JSON.stringify({ ...item, received: B, state: 'downloading' }));
  f.files.set(item.id, Buffer.alloc(100));
  const next = new DownloadManager(f.ports); await next.initialize();
  expect(next.getSnapshot().items[0]?.received).toBe(0); await next.start(item.id);
  expect(f.requests[0]).toBe(0); expect(f.files.get(item.id)).toEqual(f.data);
});

it('retains a recoverable checkpoint when saving progress fails', async () => {
  const f = fixture(), item = await f.manager.enqueue(seed(f.data.length)), save = f.ports.save;
  let failed = false;
  f.ports.save = async record => { if (!failed && record.received === B) { failed = true; throw Error('disk-full'); } await save(record); };
  await expect(f.manager.start(item.id)).rejects.toThrow('disk-full');
  expect(f.manager.getSnapshot().items[0]).toMatchObject({ received: 0, state: 'failed' });
  const next = new DownloadManager(f.ports); await next.initialize(); await next.start(item.id);
  expect(f.files.get(item.id)).toEqual(f.data);
});

it('deduplicates concurrent requests, while isolating equal names from different accounts and versions', async () => {
  const f = fixture(10), [a, b] = await Promise.all([f.manager.enqueue(seed(10)), f.manager.enqueue(seed(10))]);
  expect(a.id).toBe(b.id);
  await Promise.all([f.manager.start(a.id), f.manager.start(b.id)]); expect(f.requests).toEqual([0]);
  const other = await f.manager.enqueue({ ...seed(10), remote: { ...remote, userId: 'other' } });
  const changed = await f.manager.enqueue({ ...seed(10), version: 'b'.repeat(64) });
  expect(new Set([a.id, other.id, changed.id]).size).toBe(3);
});

it('deletes an active download only after cancellation and removes both local bytes and its record', async () => {
  const f = fixture(), item = await f.manager.enqueue(seed(f.data.length));
  let reached!: () => void; const started = new Promise<void>(done => { reached = done; });
  f.ports.block = async (_, __, ___, signal) => { reached(); return new Promise<number>((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })); };
  const rejected = expect(f.manager.start(item.id)).rejects.toThrow(); await started;
  await f.manager.remove(item.id); await rejected;
  expect(f.manager.getSnapshot().items).toEqual([]); expect(f.files.has(item.id)).toBe(false); expect(f.records.has(item.id)).toBe(false);
});

it('supports empty files and detects completed files removed outside the manager', async () => {
  const f = fixture(0), item = await f.manager.enqueue(seed(0)); await f.manager.start(item.id);
  expect(f.files.get(item.id)?.length).toBe(0); expect(f.requests).toEqual([]);
  f.files.delete(item.id); const next = new DownloadManager(f.ports); await next.initialize();
  expect(next.getSnapshot().items[0]?.error).toContain('丢失');
});

it('keeps failed-file checkpoints and retries without mixing data from a changed remote file', async () => {
  const f = fixture(), block = f.ports.block, item = await f.manager.enqueue(seed(f.data.length));
  f.ports.block = async (record, start, end, signal, progress) => { if (start === B) throw Error('PC 上的文件已更改，请重新打开'); return block(record, start, end, signal, progress); };
  await expect(f.manager.start(item.id)).rejects.toThrow('已更改');
  expect(f.manager.getSnapshot().items[0]).toMatchObject({ state: 'failed', received: B });
  expect(f.files.get(item.id)).toEqual(f.data.subarray(0, B));
});

it('rejects corrupt records and exposes storage failures with a retryable initialization', async () => {
  const f = fixture(); let fail = true;
  f.ports.load = async () => { if (fail) throw Error('disk'); return [{ id: '../escape' }] as DownloadRecord[]; };
  await expect(f.manager.initialize()).rejects.toThrow(); expect(f.manager.getSnapshot().error).toContain('读取下载列表失败');
  fail = false; await f.manager.initialize(); expect(f.manager.getSnapshot()).toMatchObject({ ready: true, items: [] });
  expect(downloadRecordSchema.safeParse({ ...seed(1), remote: { ...remote, path: '//evil.test/download' } }).success).toBe(false);
});

it('only accepts exact byte ranges, or a whole response replacing offset zero', () => {
  expect(downloadResponseBytes(206, 'bytes 5-9/20', 5, 5, 9, 20)).toBe(5);
  expect(downloadResponseBytes(200, undefined, 20, 0, 4, 20)).toBe(20);
  expect(() => downloadResponseBytes(200, undefined, 20, 5, 9, 20)).toThrow('不支持断点续传');
  expect(() => downloadResponseBytes(206, 'bytes 0-4/20', 5, 5, 9, 20)).toThrow('分段');
  expect(() => downloadResponseBytes(206, 'bytes 5-9/20', 4, 5, 9, 20)).toThrow('分段');
  expect(() => downloadResponseBytes(206, 'bytes 5-9/21', 5, 5, 9, 20)).toThrow('分段');
  expect(() => downloadResponseBytes(401, undefined, 5, 5, 9, 20)).toThrow('登录');
});
