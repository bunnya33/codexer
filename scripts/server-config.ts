import type { AdminAccount } from "../packages/shared/src/admin-account.js";
import { validatePassword } from "../packages/shared/src/accounts.js";
import { parseEnv } from "node:util";

export function publicOrigin(value: string): { origin: string; port: number } {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.hostname === "0.0.0.0" || url.hostname === "192.0.2.10") {
    throw new Error("public-url-must-be-your-http-browser-address-without-path-or-credentials");
  }
  return { origin: url.origin, port: Number(url.port || "80") };
}
export function browserOrigin(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("browser-origin-must-use-http-or-https-without-path-or-credentials");
  return url.origin;
}

export function configureServerEnv(source: string, address: string, account: AdminAccount, keepOtherOrigins = false, allowedOrigins?: string): { content: string; values: Record<string, string | undefined>; origin: string; port: number } {
  const prior = parseEnv(source);
  const { origin, port } = publicOrigin(address);
  validatePassword(account.password);
  if (!account.username.trim() || account.username.length > 100) throw new Error("invalid-admin-account");
  const origins = allowedOrigins === undefined
    ? keepOtherOrigins && prior.RELAY_ALLOWED_ORIGINS?.split(",")[0]?.trim() === origin ? prior.RELAY_ALLOWED_ORIGINS : origin
    : [...new Set([origin, ...allowedOrigins.split(",").map(value => value.trim()).filter(Boolean).map(browserOrigin)])].join(",");
  const updates: Record<string, string> = { RELAY_HOST: "0.0.0.0", RELAY_PORT: String(port), RELAY_ALLOWED_ORIGINS: origins };
  updates.RELAY_ADMIN_USERNAME = account.username.trim();
  updates.RELAY_ADMIN_PASSWORD_B64 = Buffer.from(account.password).toString("base64");
  const seen = new Set<string>();
  const lines = source.replaceAll("\r\n", "\n").split("\n").filter((line, index, all) => line || index < all.length - 1).flatMap(line => {
    const key = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === "RELAY_ADMIN_TOKEN" || key === "RELAY_ADMIN_PASSWORD") return [];
    if (!key || !(key in updates)) return [line];
    if (seen.has(key)) return [];
    seen.add(key);
    return [`${key}=${JSON.stringify(updates[key])}`];
  });
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) lines.push(`${key}=${JSON.stringify(value)}`);
  return { content: `${lines.join("\n").trimEnd()}\n`, values: { ...Object.fromEntries(Object.entries(prior).filter(([key]) => !["RELAY_ADMIN_TOKEN", "RELAY_ADMIN_PASSWORD"].includes(key))), ...updates }, origin, port };
}

export function configureInstalledEnv(source: string, address: string, account: AdminAccount, allowedOrigins?: string): ReturnType<typeof configureServerEnv> {
  const configured = configureServerEnv(source, address, account, allowedOrigins === undefined, allowedOrigins);
  const updates = { RELAY_DATA_DIR: "/var/lib/codexer/relay", RELAY_WEB_DIR: "/opt/codexer/current/apps/web/dist", RELAY_ADMIN_DIR: "/opt/codexer/current/apps/admin/dist" };
  const prior = parseEnv(configured.content);
  const lines = configured.content.trimEnd().split("\n");
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex(line => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return { ...configured, content: `${lines.join("\n")}\n`, values: { ...prior, ...updates } };
}
