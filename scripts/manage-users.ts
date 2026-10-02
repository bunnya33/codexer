import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { loginAccount, readAdminAccount, accountFromEnv } from "../packages/shared/src/admin-account.js";
import { promptPassword } from "../packages/shared/src/password-prompt.js";
const [action, ...args] = process.argv.slice(2);
if (!action || !["create", "list", "password", "revoke"].includes(action)) throw new Error("usage: npm run users -- create <name> | list | password <id> | revoke <id>");
let env: Record<string, string | undefined> = {};
try { env = parseEnv(await readFile(resolve("infra/.env"), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const account = accountFromEnv(env) ?? await readAdminAccount();
const base = "http://127.0.0.1:" + (env.RELAY_PORT ?? process.env.RELAY_PORT ?? "8787");
const session = await loginAccount(base, account, "admin");
let path = "/v1/users", method = "GET", body: unknown;
if (action === "create") { path = "/v1/users"; method = "POST"; body = { username: args.join(" "), password: await promptPassword() }; }
if (action === "password") { path += "/" + encodeURIComponent(args[0] ?? "") + "/password"; method = "PUT"; body = { password: await promptPassword("新密码：") }; }
if (action === "revoke") { path += "/" + encodeURIComponent(args[0] ?? ""); method = "DELETE"; }
try {
  const response = await fetch(base + path, { method, headers: { authorization: "Bearer " + session, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("account-command-failed: HTTP " + response.status);
  console.log(JSON.stringify(await response.json(), null, 2));
} finally { await fetch(base + "/v1/auth/logout", { method: "POST", headers: { authorization: "Bearer " + session } }); }
