import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeServerUrl } from "./policy.js";

/** 只保存服务器地址；账号登录状态由各服务器来源的 Chromium 存储维护。 */
export async function readServerUrl(directory: string): Promise<string | null> {
  try {
    const settings = JSON.parse(await readFile(join(directory, "server.json"), "utf8")) as {
      url?: unknown;
    };
    return normalizeServerUrl(settings.url);
  } catch {
    return null;
  }
}

export async function saveServerUrl(directory: string, value: string): Promise<void> {
  const url = normalizeServerUrl(value);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "server.json");
  await writeFile(path + ".tmp", JSON.stringify({ url }), { mode: 0o600 });
  await rename(path + ".tmp", path);
}
