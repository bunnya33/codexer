import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveCodexBinary } from "../packages/codex-adapter/src/binary.js";

vi.mock("node:fs/promises", () => ({ access: vi.fn(), stat: vi.fn(), readdir: vi.fn() }));
vi.mock("node:os", () => ({ homedir: () => "/Users/test" }));

const bundledBinary = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "darwin", env: { PATH: "/usr/bin:/bin" } });
  vi.mocked(stat).mockImplementation(async () => { throw new Error("not found"); });
  vi.mocked(access).mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

function installed(paths: string[]) {
  vi.mocked(stat).mockImplementation(async path => {
    if (!paths.includes(String(path))) throw new Error("not found");
    return { isFile: () => true } as Awaited<ReturnType<typeof stat>>;
  });
}

it("finds the ChatGPT bundled Codex when the GUI PATH has no Codex", async () => {
  installed([bundledBinary]);
  await expect(resolveCodexBinary()).resolves.toBe(bundledBinary);
});

it("finds ChatGPT installed in the user's Applications directory", async () => {
  // Stubbing process.platform does not change node:path's host path separator.
  const binary = join("/Users/test", "Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  installed([binary]);
  await expect(resolveCodexBinary()).resolves.toBe(binary);
});

it("keeps the standalone Codex installation ahead of ChatGPT", async () => {
  const binary = "/Applications/Codex.app/Contents/Resources/codex";
  installed([binary, bundledBinary]);
  await expect(resolveCodexBinary()).resolves.toBe(binary);
});

it("uses an explicit program path and rejects an invalid override", async () => {
  installed(["/custom/codex", bundledBinary]);
  await expect(resolveCodexBinary("/custom/codex")).resolves.toBe("/custom/codex");
  await expect(resolveCodexBinary("/missing/codex")).rejects.toThrow("codex-binary-not-found");
});

it("skips a bundled binary without execute permission and falls back to Homebrew", async () => {
  installed([bundledBinary, "/opt/homebrew/bin/codex"]);
  vi.mocked(access).mockImplementation(async path => {
    if (path === bundledBinary) throw new Error("not executable");
  });
  await expect(resolveCodexBinary()).resolves.toBe("/opt/homebrew/bin/codex");
});

it('prefers a complete Windows runtime over a newer leftover codex.exe', async () => {
  vi.stubGlobal('process', {...process, platform: 'win32', env: {LOCALAPPDATA: '/local', PATH: ''}});
  vi.mocked(readdir).mockResolvedValue(['complete', 'leftover'].map(name => ({name, isDirectory: () => true})) as never);
  const root = join('/local', 'OpenAI', 'Codex', 'bin');
  const complete = join(root, 'complete', 'codex.exe'), leftover = join(root, 'leftover', 'codex.exe');
  vi.mocked(stat).mockImplementation(async path => {
    if (![complete, leftover, join(root, 'complete', 'codex-code-mode-host.exe')].includes(String(path))) throw new Error('missing');
    return {isFile: () => true, mtimeMs: String(path) === leftover ? 200 : 100} as Awaited<ReturnType<typeof stat>>;
  });
  await expect(resolveCodexBinary()).resolves.toBe(complete);
  // An explicit selection stays authoritative.
  await expect(resolveCodexBinary(leftover)).resolves.toBe(leftover);
});
