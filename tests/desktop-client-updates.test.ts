import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopClientUpdates } from "../apps/desktop/src/client-updates";

const bytes = Buffer.from("verified installer fixture");
const release = {
  id: "f659243b-2d6b-45b4-bc97-d121a2098385",
  target: "agent-windows-x64-setup",
  name: "Agent.exe",
  version: "0.2.12",
  buildNumber: 0,
  notes: "",
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  uploadedAt: 1,
};
let directory: string, updates: DesktopClientUpdates;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codexer-updates-test-"));
  updates = new DesktopClientUpdates("agent-windows-x64-setup", "0.2.11", directory, () => {});
});
afterEach(async () => {
  updates.dispose();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
function mockFetch(body: () => Response | Promise<Response> = () => new Response(bytes)) {
  const fetcher = vi.fn(async (url: string, options: RequestInit) =>
    url.endsWith("/download") ? body() : Response.json({ release }),
  );
  vi.stubGlobal("fetch", fetcher);
  updates.configure({ url: "https://relay.test", session: "agent-session", deviceId: "device-1" });
  return fetcher;
}
it("deduplicates downloads, sends device authentication and verifies the cached installer again before opening", async () => {
  const fetcher = mockFetch();
  await updates.check();
  const first = updates.download();
  expect(updates.download()).toBe(first);
  await first;
  const path = await updates.verifiedPackage();
  expect(await readFile(path)).toEqual(bytes);
  expect(updates.state()).toMatchObject({
    available: true,
    downloaded: true,
    downloading: false,
    progress: 1,
  });
  const downloads = fetcher.mock.calls.filter(([url]) => url.endsWith("/download"));
  expect(downloads).toHaveLength(1);
  expect(downloads[0]![1]).toMatchObject({
    redirect: "error",
    headers: { authorization: "Bearer agent-session", "x-device-id": "device-1" },
  });
  await writeFile(path, Buffer.alloc(bytes.length));
  await expect(updates.verifiedPackage()).rejects.toThrow("校验失败");
  expect(updates.state().downloaded).toBe(false);
});
it.each([Buffer.alloc(bytes.length), bytes.subarray(1), Buffer.concat([bytes, bytes])])(
  "rejects corrupt or incomplete packages and removes partial files",
  async (body) => {
    mockFetch(() => new Response(body));
    await expect(updates.download()).rejects.toThrow();
    expect(updates.state()).toMatchObject({ downloaded: false, downloading: false });
    expect(await readdir(directory)).toEqual([]);
  },
);
it("ignores a download that finishes after changing relay accounts", async () => {
  let finish!: (value: Response) => void, started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  mockFetch(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const task = updates.download(),
    rejected = expect(task).rejects.toThrow();
  await ready;
  updates.configure();
  finish(new Response(bytes));
  await rejected;
  expect(updates.state()).toMatchObject({
    release: null,
    available: false,
    downloading: false,
    downloaded: false,
    error: "",
  });
  expect(await readdir(directory)).toEqual([]);
});
it("cancels during preparation without starting a package request", async () => {
  const fetcher = mockFetch();
  const task = updates.download();
  updates.cancel();
  await expect(task).rejects.toThrow("取消");
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/download"))).toBe(false);
  expect(updates.state().downloading).toBe(false);
});
