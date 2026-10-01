import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, expect, it } from "vitest";
import { prepareInstalledConfig } from "../scripts/install-config.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function paths() {
  const root = await mkdtemp(join(tmpdir(), "codexer-install-"));
  temporary.push(root);
  return { current: join(root, "relay.env"), legacy: join(root, "old.env") };
}

it("replaces legacy tokens with an admin account while retaining database and origins", async () => {
  const { current, legacy } = await paths();
  await writeFile(legacy, "RELAY_ADMIN_TOKEN=old-token\nDATABASE_URL=postgres://localhost/codexer\nRELAY_ALLOWED_ORIGINS=http://relay.example:8899,http://console.example:8899\n");
  const first = await prepareInstalledConfig(current, legacy, "http://relay.example:8899");
  const values = parseEnv(await readFile(current, "utf8"));
  expect(first).toMatchObject({ externalDatabase: true, port: 8899 });
  expect(values.RELAY_ADMIN_TOKEN).toBeUndefined();
  expect(values.RELAY_ADMIN_USERNAME).toBe("admin"); expect(Buffer.from(values.RELAY_ADMIN_PASSWORD_B64!, "base64").toString()).toBe(first.newAccount!.password);
  expect(values).toMatchObject({ DATABASE_URL: "postgres://localhost/codexer", RELAY_DATA_DIR: "/var/lib/codexer/relay", RELAY_ALLOWED_ORIGINS: "http://relay.example:8899,http://console.example:8899" });
  expect((await prepareInstalledConfig(current, legacy, "http://relay.example:8899")).newAccount).toBeNull();
});

it("generates a password only on the first clean install", async () => {
  const { current, legacy } = await paths();
  const first = await prepareInstalledConfig(current, legacy, "http://relay.example:8899");
  expect(first.newAccount?.password.length).toBeGreaterThanOrEqual(12);
  const second = await prepareInstalledConfig(current, legacy, "http://relay.example:8899");
  expect(second.newAccount).toBeNull();
  expect(Buffer.from(parseEnv(await readFile(current, "utf8")).RELAY_ADMIN_PASSWORD_B64!, "base64").toString()).toBe(first.newAccount!.password);
});
