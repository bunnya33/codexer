import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PcAgent } from "./agent.js";
import { loginAgent, agentLoginValid } from "./auth.js";
import type { AgentCredentials } from "./auth.js";
import { readSecret } from "../../../packages/shared/src/secrets.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { relay: { type: "string", default: process.env.RELAY_URL ?? "http://127.0.0.1:8787" }, username: { type: "string", default: process.env.RELAY_USERNAME }, credentials: { type: "string", default: process.env.AGENT_CREDENTIAL_FILE ?? ".local/agent-credentials.secret" }, data: { type: "string", default: process.env.AGENT_DATA_DIR ?? ".local/agent" }, thread: { type: "string", multiple: true }, pipe: { type: "string" }, runtime: { type: "string", default: process.env.CODEX_REMOTE_RUNTIME ?? "auto" } } });
if (!["auto", "desktop", "headless"].includes(values.runtime)) throw new Error("invalid-runtime: expected auto, desktop, or headless");
const credentialFile = resolve(values.credentials);
const action = positionals[0] ?? "run";
if (action === "login") {
  if (!values.username) throw new Error("account-name-required: use --username");
  let password = "";
  for await (const chunk of process.stdin) { password += String(chunk); if (password.length > 1024) throw new Error("password-too-long"); }
  const credentials = await loginAgent(values.relay, credentialFile, values.username, password.replace(/\r?\n$/, ""));
  console.log(JSON.stringify({ type: "account.login.completed", deviceId: credentials.deviceId, credentialFile }));
} else if (action === "check-login") {
  process.exitCode = await agentLoginValid(credentialFile) ? 0 : 1;
} else if (action === "status") {
  console.log(await readFile(resolve(values.data, "status.json"), "utf8"));
} else if (action === "run") {
  const credentials = await readSecret<AgentCredentials>(credentialFile).catch(() => { throw new Error("agent-not-logged-in: run npm run dev:agent -- login --username <account>"); });
  if (!credentials.session || credentials.expiresAt <= Date.now()) throw new Error("account-session-expired: login again");
  const agent = new PcAgent(credentials, resolve(values.data), values.thread ?? (process.env.CODEX_THREAD_ID ? [process.env.CODEX_THREAD_ID] : []), values.pipe, undefined, values.runtime as "auto" | "desktop" | "headless");
  await agent.start();
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { if (!stopping) { stopping = true; void agent.stop(); } });
} else throw new Error("unknown-action: expected run, login, check-login, or status");
