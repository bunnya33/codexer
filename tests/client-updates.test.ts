import { afterEach, expect, it, vi } from "vitest";
import { ClientUpdateChecker } from "../packages/client-shared/src/client-updates";
import {
  clientUpdateAvailable,
  CLIENT_UPDATE_INTERVAL,
} from "../packages/shared/src/client-release";
const release = {
  id: "f659243b-2d6b-45b4-bc97-d121a2098385",
  target: "control-android" as const,
  name: "Control.apk",
  version: "0.1.4",
  buildNumber: 5,
  notes: "New release",
  size: 512,
  sha256: "a".repeat(64),
  uploadedAt: 1,
};
afterEach(() => vi.useRealTimers());
it("compares product versions numerically and requires Android versionCode to advance", () => {
  expect(clientUpdateAvailable({ ...release, version: "0.2.10" }, "0.2.9")).toBe(true);
  expect(clientUpdateAvailable(release, "0.1.4")).toBe(false);
  expect(clientUpdateAvailable(release, "0.1.4", 4)).toBe(true);
  expect(clientUpdateAvailable(release, "0.1.3", 5)).toBe(false);
  expect(clientUpdateAvailable(release, "0.1.5", 4)).toBe(false);
  expect(clientUpdateAvailable(release, "development")).toBe(false);
});
it("keeps a known update through transient failures and clears only when the server has no release or the installed version catches up", async () => {
  const checker = new ClientUpdateChecker(),
    load = vi.fn().mockResolvedValue({ release });
  try {
    checker.configure("server-user", "control-android", load);
    await checker.check();
    expect(clientUpdateAvailable(checker.getSnapshot().release, "0.1.3", 4)).toBe(true);
    load.mockRejectedValueOnce(new Error("offline"));
    await checker.check();
    expect(checker.getSnapshot().error).toBeTruthy();
    expect(checker.getSnapshot().release).toEqual(release);
    load.mockResolvedValueOnce({ release: null });
    await checker.check();
    expect(checker.getSnapshot().release).toBeNull();
  } finally {
    checker.dispose();
  }
});
it("rejects another platform and ignores a late response after switching relay accounts", async () => {
  const checker = new ClientUpdateChecker();
  let finish!: (v: unknown) => void;
  try {
    checker.configure(
      "old",
      "control-android",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    checker.configure("new", "control-android", async () => ({ release: null }));
    await checker.check();
    finish({ release });
    await Promise.resolve();
    await Promise.resolve();
    expect(checker.getSnapshot().release).toBeNull();
    checker.configure("desktop", "control-windows-x64", async () => ({ release }));
    await checker.check();
    expect(checker.getSnapshot().release).toBeNull();
    expect(checker.getSnapshot().error).toBeTruthy();
  } finally {
    checker.dispose();
  }
});
it("checks every six hours and releases its timers after logout", async () => {
  vi.useFakeTimers();
  const checker = new ClientUpdateChecker(),
    load = vi.fn().mockResolvedValue({ release });
  checker.configure("logged-in", "control-android", load);
  await checker.check();
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(CLIENT_UPDATE_INTERVAL);
  expect(load).toHaveBeenCalledTimes(2);
  checker.dispose();
  await vi.advanceTimersByTimeAsync(CLIENT_UPDATE_INTERVAL * 2);
  expect(load).toHaveBeenCalledTimes(2);
  expect(checker.getSnapshot().release).toBeNull();
});
