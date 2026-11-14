import { expect, it } from 'vitest';
import { DownloadCompletionNotice } from '../packages/client-shared/src/download-notices';
import type { DownloadItem, DownloadSnapshot } from '../packages/client-shared/src/downloads';

function fixture() {
  const listeners = new Set<() => void>();
  let state: DownloadSnapshot = { ready: true, error: '', items: [] }, saved: string[] = [];
  const source = { initialize: async () => {}, getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  const storage = { load: async () => saved, save: async (value: string[]) => { saved = value; } };
  const set = (items: DownloadItem[]) => { state = { ...state, items }; for (const fn of listeners) fn(); };
  const item = (id: string, status: DownloadItem['state'], revision = 1): DownloadItem => ({ id, name: id, state: status, revision, size: 12, received: status === 'completed' ? 12 : 0, transferred: 0, createdAt: 1, error: '' });
  return { source, storage, set, item, notice: new DownloadCompletionNotice(source, storage) };
}

it('shows a badge only for completed files and clears all current completions on opening the list', async () => {
  const f = fixture(); await f.notice.initialize();
  f.set([f.item('a', 'downloading'), f.item('b', 'failed')]); expect(f.notice.getSnapshot()).toBe(false);
  f.set([f.item('a', 'completed'), f.item('b', 'paused')]); expect(f.notice.getSnapshot()).toBe(true);
  await f.notice.markRead(); expect(f.notice.getSnapshot()).toBe(false);
  f.set([f.item('a', 'completed'), f.item('b', 'downloading')]); expect(f.notice.getSnapshot()).toBe(false);
  f.set([f.item('a', 'completed'), f.item('b', 'completed')]); expect(f.notice.getSnapshot()).toBe(true);
});

it('preserves acknowledgement across restart and notices a new completed revision of the same file', async () => {
  const f = fixture(); f.set([f.item('a', 'completed', 8)]); await f.notice.markRead();
  const again = new DownloadCompletionNotice(f.source, f.storage); await again.initialize(); expect(again.getSnapshot()).toBe(false);
  f.set([f.item('a', 'downloading', 9)]); expect(again.getSnapshot()).toBe(false);
  f.set([f.item('a', 'completed', 10)]); expect(again.getSnapshot()).toBe(true);
  f.set([]); expect(again.getSnapshot()).toBe(false);
});

it('handles corrupt acknowledgement storage and retains completions that arrive while saving acknowledgement', async () => {
  const f = fixture(); f.storage.load = async () => { throw Error('truncated'); };
  let finish!: () => void, started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  f.storage.save = () => new Promise<void>(resolve => { finish = resolve; started(); });
  f.set([f.item('a', 'completed')]); await f.notice.initialize(); expect(f.notice.getSnapshot()).toBe(true);
  const saving = f.notice.markRead(); await reached;
  f.set([f.item('a', 'completed'), f.item('b', 'completed')]); expect(f.notice.getSnapshot()).toBe(true);
  finish(); await saving; expect(f.notice.getSnapshot()).toBe(true);
});
