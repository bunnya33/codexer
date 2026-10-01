import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readSecret, writeSecret } from "../../../packages/shared/src/secrets.js";

export type AgentCredentials = { relayUrl: string; deviceId: string; session: string; expiresAt: number; username: string; installationId: string };
export function validateRelayUrl(value: string, allowHttp = process.env.CODEX_REMOTE_ALLOW_HTTP === "1"): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("relay-url-must-use-http-or-https-without-credentials-path-query-or-fragment");
  if (url.protocol === "http:" && !local && !allowHttp) throw new Error("relay-http-requires-CODEX_REMOTE_ALLOW_HTTP=1");
  return url;
}
export async function loginAgent(relayUrl: string, credentialFile: string, username: string, password: string): Promise<AgentCredentials> {
  validateRelayUrl(relayUrl);
  const previous = await readSecret<AgentCredentials>(credentialFile).catch(() => null);
  const installationId = previous?.installationId ?? randomUUID();
  const response = await fetch(new URL("/v1/agents/login", relayUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, installationId, name: hostname(), platform: process.platform }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("account-login-failed: HTTP " + response.status);
  const result = await response.json() as { session: string; expiresAt: number; deviceId: string };
  const credentials = { relayUrl, installationId, username: username.trim(), ...result };
  await writeSecret(credentialFile, credentials);
  return credentials;
}
export async function agentLoginValid(credentialFile: string): Promise<boolean> {
  const credentials = await readSecret<AgentCredentials>(credentialFile).catch(() => null);
  if (!credentials?.session || credentials.expiresAt <= Date.now()) return false;
  validateRelayUrl(credentials.relayUrl);
  const response = await fetch(new URL("/v1/agent/" + credentials.deviceId + "/session", credentials.relayUrl), { headers: { authorization: "Bearer " + credentials.session }, signal: AbortSignal.timeout(10000) });
  return response.ok;
}
