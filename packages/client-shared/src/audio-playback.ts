export type PlaybackSource = { uri: string; release: () => Promise<void> };

/** A new player waits for the previous URL, including late creation, to be revoked. */
export class AudioPlaybackCoordinator {
  private active?: { stop: () => Promise<void> };
  private cleanup = Promise.resolve();

  start(load: (signal: AbortSignal) => Promise<PlaybackSource>, events: {
    ready: (source: PlaybackSource) => void;
    error: (error: unknown) => void;
    stopped: () => void;
  }): { stop: () => Promise<void> } {
    const previous = this.active?.stop() ?? this.cleanup;
    const controller = new AbortController();
    let source: PlaybackSource | undefined;
    let cleanup: Promise<void> | undefined;
    const operation = {
      stop: () => {
        if (cleanup) return cleanup;
        controller.abort();
        events.stopped();
        if (this.active === operation) this.active = undefined;
        cleanup = loading.then(async () => { await source?.release(); }).catch(() => {});
        this.cleanup = cleanup;
        return cleanup;
      },
    };
    const loading = (async () => {
      await previous;
      if (controller.signal.aborted) return;
      try {
        source = await load(controller.signal);
        if (!controller.signal.aborted) events.ready(source);
      } catch (error) {
        if (!controller.signal.aborted) events.error(error);
      }
    })();
    this.active = operation;
    return operation;
  }
}
