import { beforeEach, expect, it, vi } from "vitest";
import type { ClientRelease } from "../packages/shared/src/client-release";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  remove: vi.fn(),
  mkdir: vi.fn(),
  create: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  content: vi.fn(),
  verify: vi.fn(),
  open: vi.fn(),
}));
vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  getInfoAsync: mocks.info,
  deleteAsync: mocks.remove,
  makeDirectoryAsync: mocks.mkdir,
  createDownloadResumable: mocks.create,
  getContentUriAsync: mocks.content,
}));
vi.mock("expo", () => ({
  requireNativeModule: () => ({ verifyApk: mocks.verify, openInstaller: mocks.open }),
}));
// Keep Expo's global native declarations out of the Node test project's types.
// The mobile tsconfig checks the actual module and its platform dependencies.
const modulePath: string = "../apps/mobile/src/client-update-download";
const downloadClientUpdate: (
  source: { uri: string; headers: Record<string, string> },
  release: ClientRelease,
  signal: AbortSignal,
  progress: (value: number) => void,
  phase?: (value: string) => void,
) => Promise<string> = (await import(modulePath)).downloadClientUpdate;

const release: ClientRelease = {
  id: "f659243b-2d6b-45b4-bc97-d121a2098385",
  target: "control-android",
  name: "Control.apk",
  version: "0.1.6",
  buildNumber: 7,
  notes: "",
  size: 1024,
  sha256: "a".repeat(64),
  uploadedAt: 1,
};
const uri = `file:///cache/codexer-updates/${release.id}.apk`;
const source = { uri: "https://relay.test/download", headers: { Authorization: "Bearer fixture" } };
const complete = { exists: true, isDirectory: false, size: release.size };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.info.mockResolvedValue(complete).mockResolvedValueOnce({ exists: false });
  mocks.remove.mockResolvedValue(undefined);
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.create.mockReturnValue({ downloadAsync: mocks.download, cancelAsync: mocks.cancel });
  mocks.download.mockImplementation(async () => {
    mocks.create.mock.calls.at(-1)![3]({ totalBytesWritten: release.size });
    return { status: 200 };
  });
  mocks.cancel.mockResolvedValue(undefined);
  mocks.content.mockResolvedValue("content://installer/apk");
  mocks.verify.mockResolvedValue(true);
  mocks.open.mockResolvedValue("opened");
});
it("leaves downloading at 100%, verifies natively, then completes on installer launch", async () => {
  const states: string[] = [];
  mocks.verify.mockImplementation(async () => {
    expect(states.at(-1)).toBe("verifying");
    return true;
  });
  const result = await downloadClientUpdate(
    source,
    release,
    new AbortController().signal,
    (value) => states.push(`progress:${value}`),
    (value) => states.push(value),
  );
  expect(states).toEqual(["downloading", "progress:1", "verifying", "installing"]);
  expect(mocks.verify).toHaveBeenCalledWith(uri, release.size, release.sha256);
  expect(result).toBe("opened");
  expect(mocks.open).toHaveBeenCalledWith("content://installer/apk");
  // Only removes a stale/partial cache before download, never after handing it to Android.
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it("reuses and rechecks the APK after installation-source approval without another download", async () => {
  mocks.open.mockResolvedValueOnce("permission-required");
  const signal = new AbortController().signal;
  expect(await downloadClientUpdate(source, release, signal, () => {})).toBe("permission-required");
  expect(await downloadClientUpdate(source, release, signal, () => {})).toBe("opened");
  expect(mocks.download).toHaveBeenCalledTimes(1);
  expect(mocks.verify).toHaveBeenCalledTimes(2);
  expect(mocks.open).toHaveBeenCalledTimes(2);
});
it("redownloads a corrupt cached APK and checks its replacement", async () => {
  mocks.info.mockReset().mockResolvedValue(complete);
  mocks.verify.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await downloadClientUpdate(source, release, new AbortController().signal, () => {});
  expect(mocks.download).toHaveBeenCalledOnce();
  expect(mocks.verify).toHaveBeenCalledTimes(2);
  expect(mocks.open).toHaveBeenCalledOnce();
});
it("deletes a newly downloaded APK with a bad digest and never launches it", async () => {
  mocks.verify.mockResolvedValue(false);
  await expect(
    downloadClientUpdate(source, release, new AbortController().signal, () => {}),
  ).rejects.toThrow("校验失败");
  expect(mocks.remove).toHaveBeenLastCalledWith(uri, { idempotent: true });
  expect(mocks.open).not.toHaveBeenCalled();
});
it.each([404, 206])("rejects HTTP %s before verifying or opening the APK", async (status) => {
  mocks.download.mockResolvedValue({ status });
  await expect(
    downloadClientUpdate(source, release, new AbortController().signal, () => {}),
  ).rejects.toThrow("不完整");
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});
it("rejects a truncated download before verification", async () => {
  mocks.info.mockResolvedValue({ ...complete, size: 512 });
  await expect(
    downloadClientUpdate(source, release, new AbortController().signal, () => {}),
  ).rejects.toThrow("不完整");
  expect(mocks.verify).not.toHaveBeenCalled();
});
it("cancels the native download and removes its partial file", async () => {
  const abort = new AbortController();
  mocks.download.mockImplementation(async () => {
    abort.abort();
    return { status: 200 };
  });
  await expect(downloadClientUpdate(source, release, abort.signal, () => {})).rejects.toThrow(
    "取消",
  );
  expect(mocks.cancel).toHaveBeenCalledOnce();
  expect(mocks.remove).toHaveBeenLastCalledWith(uri, { idempotent: true });
  expect(mocks.open).not.toHaveBeenCalled();
});
it("does not open the installer if cancelled during native verification", async () => {
  const abort = new AbortController();
  mocks.verify.mockImplementation(async () => {
    abort.abort();
    return true;
  });
  await expect(downloadClientUpdate(source, release, abort.signal, () => {})).rejects.toThrow(
    "取消",
  );
  expect(mocks.open).not.toHaveBeenCalled();
});
it("keeps a verified APK when opening Android settings fails, so retry avoids downloading", async () => {
  mocks.open.mockRejectedValueOnce(new Error("activity unavailable"));
  const signal = new AbortController().signal;
  await expect(downloadClientUpdate(source, release, signal, () => {})).rejects.toThrow(
    "activity unavailable",
  );
  expect(await downloadClientUpdate(source, release, signal, () => {})).toBe("opened");
  expect(mocks.download).toHaveBeenCalledOnce();
});
