import { randomBytes } from "node:crypto";
import { chmod, chown, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { accountFromEnv } from "../packages/shared/src/admin-account.js";
import { configureInstalledEnv } from "./server-config.js";

async function optional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

export async function prepareInstalledConfig(currentPath: string, legacyPath: string, address: string): Promise<{ origin: string; port: number; newAccount: { username: string; password: string } | null; externalDatabase: boolean }> {
  const current = await optional(currentPath);
  const legacy = current ? "" : await optional(legacyPath);
  const source = current || legacy;
  const prior = parseEnv(source);
  const existing = accountFromEnv(prior);
  const account = existing ?? { username: "admin", password: randomBytes(18).toString("base64url") };
  const configured = configureInstalledEnv(source, address, account);
  const temporary = `${currentPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, configured.content, { mode: 0o640, flag: "wx" });
    const previous = await stat(currentPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (previous) await chown(temporary, previous.uid, previous.gid);
    await chmod(temporary, 0o640);
    await rename(temporary, currentPath);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { origin: configured.origin, port: configured.port, newAccount: existing ? null : account, externalDatabase: Boolean(configured.values.DATABASE_URL) };
}

if (process.argv[1] && /(?:^|[/\\])install-config\.(?:js|ts)$/.test(process.argv[1])) {
  const [current, legacy, address] = process.argv.slice(2);
  if (!current || !legacy || !address) throw new Error("usage: install-config <current-env> <legacy-env> <public-url>");
  console.log(JSON.stringify(await prepareInstalledConfig(current, legacy, address)));
}
