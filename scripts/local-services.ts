import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { loginAccount, readAdminAccount } from "../packages/shared/src/admin-account.js";
import type { AdminAccount } from "../packages/shared/src/admin-account.js";
import { z } from "zod";
import { loginAgent, agentLoginValid } from "../apps/pc-agent/src/auth.js";
import type { AgentCredentials } from "../apps/pc-agent/src/auth.js";
import { readSecret, writeSecret } from "../packages/shared/src/secrets.js";

const root = resolve(process.cwd()), local = join(root, ".local");
const recordPath = join(local, "services.json"), adminPath = join(local, "relay-admin-account.secret"), credentialPath = join(local, "agent-credentials.secret");
const relayEntry = join(root, process.platform === "win32" ? "dist/codexer.exe" : "dist/codexer"), agentEntry = join(root, "apps/pc-agent/src/main.ts");
const serviceSchema = z.object({ relayPid: z.number().int().positive(), agentPid: z.number().int().positive().nullable(), relayUrl: z.string().url(), deviceId: z.string().nullable(), startedAt: z.string() });
type Services = z.infer<typeof serviceSchema>;
async function readRecord(): Promise<Services | null> {
  try { return serviceSchema.parse(JSON.parse(await readFile(recordPath, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function saveRecord(record: Services): Promise<void> { await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`); }
async function ownedProcess(pid: number, entry: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object CommandLine,ExecutablePath | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 5000 });
      if (!stdout.trim()) return false;
      const value = JSON.parse(stdout) as { CommandLine?: string; ExecutablePath?: string };
      return value.ExecutablePath?.toLowerCase() === process.execPath.toLowerCase() && value.CommandLine?.toLowerCase().includes(entry.toLowerCase()) === true;
    }
    const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "command="], { timeout: 5000 });
    return stdout.includes(entry);
  } catch { return false; }
}
async function portAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise(resolvePort => {
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}
async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await response.json() as { ok?: boolean; protocolVersion?: number };
    return response.ok && body.ok === true && body.protocolVersion === 1;
  } catch { return false; }
}
async function until(test: () => Promise<boolean>, timeout: number): Promise<void> {
  const end = Date.now() + timeout;
  while (!await test()) {
    if (Date.now() >= end) throw new Error("local-service-start-timeout: inspect .local/*.err.log");
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  }
}
async function launch(entry: string, name: string, env: NodeJS.ProcessEnv): Promise<number> {
  const stdout = openSync(join(local, `${name}.log`), "a"), stderr = openSync(join(local, `${name}.err.log`), "a");
  try {
    const child = spawn(name === "relay" ? entry : process.execPath, name === "relay" ? ["serve"] : ["--import", "tsx", entry], { cwd: root, env: { ...process.env, ...env }, detached: true, windowsHide: true, stdio: ["ignore", stdout, stderr] });
    await new Promise<void>((resolveLaunch, reject) => { child.once("spawn", resolveLaunch); child.once("error", reject); });
    if (!child.pid) throw new Error("local-service-start-failed");
    child.unref(); return child.pid;
  } finally { closeSync(stdout); closeSync(stderr); }
}

const action = process.argv[2] ?? "status";
const runtimeOption = process.argv.indexOf("--runtime");
const runtime = runtimeOption < 0 ? process.env.CODEX_REMOTE_RUNTIME ?? "auto" : process.argv[runtimeOption + 1] ?? "";
if (!["auto", "desktop", "headless"].includes(runtime)) throw new Error("invalid-runtime: expected auto, desktop, or headless");
if (action === "start") {
  await mkdir(local, { recursive: true, mode: 0o700 });
  let services = await readRecord();
  if (!services || !await ownedProcess(services.relayPid, relayEntry)) {
    if (services?.agentPid && await ownedProcess(services.agentPid, agentEntry)) throw new Error("existing-agent-needs-stop: run npm run local:stop");
    let port = 8787;
    while (!await portAvailable(port)) { if (++port > 8807) throw new Error("no-free-relay-port"); }
    const relayUrl = `http://127.0.0.1:${port}`;
    const relayPid = await launch(relayEntry, "relay", { RELAY_HOST: "127.0.0.1", RELAY_PORT: String(port), RELAY_DATA_DIR: join(local, "relay"), RELAY_ADMIN_FILE: adminPath, RELAY_ALLOWED_ORIGINS: [relayUrl, "http://127.0.0.1:5173"].join(","), DATABASE_URL: "", NODE_ENV: "development" });
    services = { relayPid, agentPid: null, relayUrl, deviceId: null, startedAt: new Date().toISOString() };
    await saveRecord(services);
  }
  await until(() => healthy(services.relayUrl), 30000);
  const accountPath = join(local, "local-account.secret");
  let account = await readSecret<AdminAccount>(accountPath).catch(() => null);
  if (!account) {
    account = { username: "local-pc", password: randomBytes(18).toString("base64url") };
    const adminSession = await loginAccount(services.relayUrl, await readAdminAccount(adminPath), "admin");
    try {
      const created = await fetch(services.relayUrl + "/v1/users", { method: "POST", headers: { authorization: "Bearer " + adminSession, "content-type": "application/json" }, body: JSON.stringify(account) });
      if (!created.ok) throw new Error("local-account-create-failed");
      await writeSecret(accountPath, account);
    } finally { await fetch(services.relayUrl + "/v1/auth/logout", { method: "POST", headers: { authorization: "Bearer " + adminSession } }); }
  }
  const memberSession = await loginAccount(services.relayUrl, account);
  if (!services.agentPid || !await ownedProcess(services.agentPid, agentEntry)) {
    let credentials = await readSecret<AgentCredentials>(credentialPath).catch(() => null);
    if (!credentials || credentials.relayUrl !== services.relayUrl || !await agentLoginValid(credentialPath)) credentials = await loginAgent(services.relayUrl, credentialPath, account.username, account.password);
    services.deviceId = credentials.deviceId;
    services.agentPid = await launch(agentEntry, "agent", { AGENT_CREDENTIAL_FILE: credentialPath, AGENT_DATA_DIR: join(local, "agent"), CODEX_REMOTE_RUNTIME: runtime });
    await saveRecord(services);
  }
  await until(async () => {
    const status = await fetch(`${services.relayUrl}/v1/devices`, { headers: { authorization: `Bearer ${memberSession}` }, signal: AbortSignal.timeout(2000) }).catch(() => null);
    return status?.ok === true && (await status.json() as { devices: { id: string; online: boolean }[] }).devices.some(device => device.id === services.deviceId && device.online);
  }, 30000);
  console.log(JSON.stringify({ type: "local.started", ...services, healthUrl: `${services.relayUrl}/health` }));
} else if (action === "stop") {
  const services = await readRecord();
  if (services) {
    for (const [pid, entry] of [[services.agentPid, agentEntry], [services.relayPid, relayEntry]] as const) {
      if (pid !== null && await ownedProcess(pid, entry)) process.kill(pid, "SIGTERM");
    }
  }
  console.log(JSON.stringify({ type: "local.stopped" }));
} else if (action === "status") {
  const services = await readRecord();
  if (!services) console.log(JSON.stringify({ type: "local.status", running: false }));
  else {
    const relayRunning = await ownedProcess(services.relayPid, relayEntry), agentRunning = services.agentPid !== null && await ownedProcess(services.agentPid, agentEntry);
    const account = await readSecret<AdminAccount>(join(local, "local-account.secret")).catch(() => null);
    const memberSession = relayRunning && account ? await loginAccount(services.relayUrl, account).catch(() => "") : "";
    const response = relayRunning ? await fetch(`${services.relayUrl}/v1/devices`, { headers: { authorization: `Bearer ${memberSession}` }, signal: AbortSignal.timeout(2000) }).catch(() => null) : null;
    console.log(JSON.stringify({ type: "local.status", ...services, relayRunning, agentRunning, devices: response?.ok ? await response.json() : null }));
  }
} else throw new Error("expected start, stop, or status");
