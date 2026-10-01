import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CatalogThread = { id: string; path: string; cwd: string | null; updatedAt: number; originator: string | null };
export async function readRecentCatalog(limit = 20, home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<CatalogThread[]> {
  const files: { path: string; updatedAt: number }[] = [];
  async function walk(directory: string, depth = 0): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await stat(path).catch(() => null);
        if (info) files.push({ path, updatedAt: info.mtimeMs });
      }
    }
  }
  await walk(join(home, "sessions"));
  const result = new Map<string, CatalogThread>();
  for (const file of files.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit * 3)) {
    const handle = await open(file.path, "r").catch(() => null);
    if (!handle) continue;
    try {
      const buffer = Buffer.alloc(65536);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, read.bytesRead).toString("utf8").split("\n")[0];
      if (!firstLine) continue;
      const meta = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string; originator?: string } };
      if (meta.type !== "session_meta" || typeof meta.payload?.id !== "string") continue;
      if (!result.has(meta.payload.id)) result.set(meta.payload.id, { id: meta.payload.id, path: file.path, cwd: meta.payload.cwd ?? null, originator: meta.payload.originator ?? null, updatedAt: file.updatedAt });
      if (result.size >= limit) break;
    } catch { /* A session file can be created before its first line is complete. */ }
    finally { await handle.close(); }
  }
  return [...result.values()];
}
