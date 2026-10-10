import { testAccount, testPassword } from "./account-helpers.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { loginAgent } from "../apps/pc-agent/src/auth.js";
import { createRelay } from "./go-relay.js";
import { RelayStore } from "./go-relay.js";
import { readSecret } from "../packages/shared/src/secrets.js";
import type { AgentCredentials } from "../apps/pc-agent/src/auth.js";

it("logs the PC into an account and stores only its session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexer-agent-login-"));
  const store = await RelayStore.open(undefined, join(directory, "relay"));
  const account = await testAccount(store);
  const app = await createRelay({ store });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const credentialFile = join(directory, "device.secret");
    const child = spawn(process.execPath, ["--import", "tsx", "apps/pc-agent/src/main.ts", "login", "--relay", url, "--credentials", credentialFile, "--username", account.name], { cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errorOutput = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += String(chunk); });
    child.stderr.setEncoding("utf8").on("data", chunk => { errorOutput += String(chunk); });
    const exit = new Promise<number | null>((done, reject) => { child.once("close", done); child.once("error", reject); });
    child.stdin.end(`${testPassword}\n`);
    expect(await exit, errorOutput).toBe(0);
    const credential = await readSecret<AgentCredentials>(credentialFile);
    expect(JSON.parse(output)).toMatchObject({ type: "account.login.completed", deviceId: credential.deviceId });
    expect(await readSecret<AgentCredentials>(credentialFile)).toEqual(credential);
    expect(credential).not.toHaveProperty("password");
    const again = await loginAgent(url, credentialFile, account.name, testPassword);
    expect(again.deviceId).toBe(credential.deviceId);
    expect(await store.authorizeDevice(credential.deviceId, credential.session)).toBe(false);
    expect(await store.authorizeDevice(again.deviceId, again.session)).toBe(true);
    expect(await readFile(credentialFile, "utf8")).not.toContain(testPassword);
    const response = await fetch(`${url}/v1/devices`, { headers: { authorization: `Bearer ${account.session}` } });
    expect((await response.json() as { devices: { id: string }[] }).devices).toEqual(expect.arrayContaining([{ id: credential.deviceId, name: expect.any(String), platform: process.platform, created_at: expect.any(Number), last_seen_at: null, online: false }]));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

it("does not save a device credential when the password is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexer-agent-login-denied-"));
  const app = await createRelay({ store: await RelayStore.open(undefined, join(directory, "relay")) });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const credentialFile = join(directory, "device.secret");
    await expect(loginAgent(url, credentialFile, "unknown", "wrong-password")).rejects.toThrow("account-login-failed: HTTP 401");
    await expect(readFile(credentialFile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
