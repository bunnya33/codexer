import { expect, it, vi } from "vitest";
import { AudioPlaybackCoordinator } from "../packages/client-shared/src/audio-playback.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const events = () => ({ ready: vi.fn(), error: vi.fn(), stopped: vi.fn() });

it("waits for an old URL's revocation before loading the next player", async () => {
  const coordinator = new AudioPlaybackCoordinator(), deletion = gate();
  const first = events(), second = events();
  const revoke = vi.fn(() => deletion.promise);
  coordinator.start(async () => ({ uri: "first", release: revoke }), first);
  await vi.waitFor(() => expect(first.ready).toHaveBeenCalled());
  const load = vi.fn(async () => ({ uri: "second", release: vi.fn(async () => {}) }));
  const next = coordinator.start(load, second);
  expect(first.stopped).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce());
  expect(load).not.toHaveBeenCalled();
  deletion.resolve();
  await vi.waitFor(() => expect(second.ready).toHaveBeenCalled());
  await next.stop();
});

it("revokes late creation and skips an intermediate player during rapid changes", async () => {
  const coordinator = new AudioPlaybackCoordinator(), creation = gate();
  const first = events(), intermediate = events(), last = events();
  const revoke = vi.fn(async () => {});
  let started = false, aborted: AbortSignal | undefined;
  coordinator.start(async signal => {
    started = true; aborted = signal;
    await creation.promise;
    return { uri: "first", release: revoke };
  }, first);
  await vi.waitFor(() => expect(started).toBe(true));
  const skippedLoad = vi.fn(async () => ({ uri: "skipped", release: vi.fn(async () => {}) }));
  coordinator.start(skippedLoad, intermediate);
  const finalRevoke = vi.fn(async () => {});
  const finalLoad = vi.fn(async () => ({ uri: "last", release: finalRevoke }));
  const active = coordinator.start(finalLoad, last);
  expect(aborted?.aborted).toBe(true);
  expect(finalLoad).not.toHaveBeenCalled();
  creation.resolve();
  await vi.waitFor(() => expect(last.ready).toHaveBeenCalled());
  expect(first.ready).not.toHaveBeenCalled();
  expect(skippedLoad).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledOnce();
  await Promise.all([active.stop(), active.stop()]);
  expect(finalRevoke).toHaveBeenCalledOnce();
});
