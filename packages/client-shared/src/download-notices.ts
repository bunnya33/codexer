import type { DownloadSnapshot } from './downloads';

type Source = {
  initialize(): Promise<void>;
  getSnapshot(): DownloadSnapshot;
  subscribe(listener: () => void): () => void;
};
type Storage = { load(): Promise<string[]>; save(seen: string[]): Promise<void> };

/** Keep acknowledgement separate from file records so opening the list cannot
 * race with a checkpoint, deletion, or restart of a download. */
export class DownloadCompletionNotice {
  private seen = new Set<string>();
  private unread = false;
  private ready = false;
  private initialization?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(private source: Source, private storage: Storage) {
    source.subscribe(() => this.refresh());
  }
  getSnapshot = () => this.unread;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private completed() {
    return this.source.getSnapshot().items.filter(item => item.state === 'completed').map(item => `${item.id}:${item.revision}`);
  }
  private refresh() {
    const next = this.ready && this.completed().some(key => !this.seen.has(key));
    if (next === this.unread) return;
    this.unread = next;
    for (const listener of this.listeners) listener();
  }
  initialize = async () => {
    if (!this.initialization) this.initialization = (async () => {
      await this.source.initialize();
      this.seen = new Set(await this.storage.load().catch(() => []));
      this.ready = true;
      this.refresh();
    })().catch(error => { this.initialization = undefined; throw error; });
    return this.initialization;
  };
  markRead = async () => {
    await this.initialize();
    const completed = this.completed();
    this.seen = new Set(completed);
    this.refresh();
    this.writes = this.writes.catch(() => {}).then(() => this.storage.save(completed));
    return this.writes;
  };
}
