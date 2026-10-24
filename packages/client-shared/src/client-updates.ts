import {
  CLIENT_UPDATE_INTERVAL,
  clientReleaseSchema,
  emptyClientUpdate,
} from "../../shared/src/client-release";
import type {
  ClientRelease,
  ClientTarget,
  ClientUpdateState,
} from "../../shared/src/client-release";

/** One checker per running client; old logins and server switches cannot publish late results. */
export class ClientUpdateChecker {
  private view = emptyClientUpdate();
  private listeners = new Set<() => void>();
  private key = "";
  private target: ClientTarget | undefined;
  private load: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(value: Partial<ClientUpdateState>) {
    this.view = { ...this.view, ...value };
    for (const listener of this.listeners) listener();
  }
  configure(
    key: string,
    target: ClientTarget | undefined,
    load?: (signal: AbortSignal) => Promise<unknown>,
  ) {
    if (this.key === key && this.target === target) return;
    this.abort?.abort();
    clearInterval(this.timer);
    this.pending = undefined;
    this.key = key;
    this.target = target;
    this.load = load;
    this.set(emptyClientUpdate());
    if (key && target && load) {
      void this.check();
      this.timer = setInterval(() => {
        void this.check();
      }, CLIENT_UPDATE_INTERVAL);
      (this.timer as any).unref?.();
    }
  }
  async check(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.load || !this.key) return;
    const load = this.load,
      key = this.key,
      abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 15000);
    this.set({ checking: true, error: "" });
    const current = () => this.key === key && this.abort === abort;
    const task = (async () => {
      try {
        const value = (await Promise.resolve().then(() => load(abort.signal))) as {
          release: unknown;
        };
        const release: ClientRelease | null =
          value?.release === null ? null : clientReleaseSchema.parse(value?.release);
        if (release && release.target !== this.target) throw new Error("wrong-client-target");
        if (current()) this.set({ release, checkedAt: Date.now(), error: "" });
      } catch {
        if (current()) this.set({ error: "更新检查暂不可用，请稍后重试" });
      } finally {
        clearTimeout(timeout);
        if (current()) {
          this.pending = undefined;
          this.set({ checking: false });
        }
      }
    })();
    this.pending = task;
    await task;
  }
  dispose() {
    this.configure("", undefined);
  }
}
