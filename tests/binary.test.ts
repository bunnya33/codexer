import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, stat } from "node:fs/promises";
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
  const binary = bundledBinary.replace("/Applications/", "/Users/test/Applications/");
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
