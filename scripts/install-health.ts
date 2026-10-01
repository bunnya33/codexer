import { accountFromEnv } from "../packages/shared/src/admin-account.js";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const configPath = process.argv[2];
if (!configPath) throw new Error("usage: install-health <config-path>");
const config = parseEnv(await readFile(configPath, "utf8"));
const port = Number(config.RELAY_PORT);
const account = accountFromEnv(config);
if (!Number.isInteger(port) || !account) throw new Error("invalid-installed-config");
let lastError = "service-unavailable";
let verified = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(account),
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      const login = await response.json() as { role?: string; session: string };
      try {
        if (login.role !== "admin") throw new Error("admin-role-required");
        for (const path of ["/", "/admin/"]) {
          const page = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
          if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) throw new Error("web-assets-unavailable");
        }
      } finally {
        await fetch(`http://127.0.0.1:${port}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${login.session}` }, signal: AbortSignal.timeout(1500) });
      }
      console.log("Relay、控制端、管理后台与管理员认证检查通过。");
      verified = true;
      break;
    }
    lastError = `HTTP ${response.status}`;
  } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!verified) throw new Error(`Relay 管理员认证检查失败：${lastError}`);
