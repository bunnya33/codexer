import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** GUI apps do not inherit shell PATH on macOS. Also inspect the standard app bundles. */
export async function resolveCodexBinary(override = process.env.CODEX_REMOTE_CODEX_BIN): Promise<string> {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  else {
    if (process.platform === "win32") {
      const root = join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const binaries = await Promise.all(entries.filter(item => item.isDirectory()).map(async item => {
        const path = join(root, item.name, "codex.exe"), info = await stat(path).catch(() => null);
        return { path, time: info?.mtimeMs ?? 0 };
      }));
      candidates.push(...binaries.sort((a, b) => b.time - a.time).map(item => item.path));
    }
    if (process.platform === "darwin") candidates.push("/Applications/Codex.app/Contents/Resources/codex", join(homedir(), "Applications/Codex.app/Contents/Resources/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex");
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(join(directory, process.platform === "win32" ? "codex.exe" : "codex"));
  }
  for (const path of candidates) {
    try { if ((await stat(path)).isFile()) { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return path; } } catch { /* Try next installation. */ }
  }
  throw new Error("codex-binary-not-found");
}
