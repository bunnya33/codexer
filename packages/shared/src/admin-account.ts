import { resolve } from "node:path";
import { readSecret } from "./secrets.js";

export type AdminAccount = { username: string; password: string };
export function accountFromEnv(env: Record<string, string | undefined>): AdminAccount | null {
  const password = env.RELAY_ADMIN_PASSWORD_B64 ? Buffer.from(env.RELAY_ADMIN_PASSWORD_B64, "base64").toString("utf8") : env.RELAY_ADMIN_PASSWORD;
  return env.RELAY_ADMIN_USERNAME && password ? { username: env.RELAY_ADMIN_USERNAME, password } : null;
}
export const adminAccountPath = () => resolve(process.env.RELAY_ADMIN_FILE ?? ".local/relay-admin-account.secret");
export async function readAdminAccount(path = adminAccountPath()): Promise<AdminAccount> {
  const configured = accountFromEnv(process.env);
  if (configured) return configured;
  return readSecret<AdminAccount>(path);
}
export async function loginAccount(relayUrl: string, account: AdminAccount, role: "user" | "admin" = "user"): Promise<string> {
  const response = await fetch(new URL(role === "admin" ? "/v1/admin/auth/login" : "/v1/auth/login", relayUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(account), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`account-login-failed: HTTP ${response.status}`);
  return (await response.json() as { session: string }).session;
}
