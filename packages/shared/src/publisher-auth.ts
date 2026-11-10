import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { readSecret, writeSecret } from "./secrets.js";
import { DeployClient, DeployError, deployUrl } from "./server-deploy.js";

export const PUBLISH_SCOPES = [
  "server:read",
  "server:write",
  "clients:read",
  "clients:write",
] as const;
export type PublishingCredential = {
  format: "publishing-v1";
  url: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  grantExpiresAt: number;
  grantId: string;
  username: string;
  scopes: string[];
};
type TokenReply = Omit<PublishingCredential, "format" | "url">;
export function validPublishingCredential(value: unknown): value is PublishingCredential {
  const v = value as PublishingCredential;
  return (
    !!v &&
    v.format === "publishing-v1" &&
    /^cdxp_a_[A-Za-z0-9_-]{43}$/.test(v.accessToken) &&
    /^cdxp_r_[A-Za-z0-9_-]{43}$/.test(v.refreshToken) &&
    typeof v.url === "string" &&
    typeof v.username === "string" &&
    typeof v.grantId === "string" &&
    [v.expiresAt, v.refreshExpiresAt, v.grantExpiresAt].every(Number.isSafeInteger) &&
    Array.isArray(v.scopes) &&
    v.scopes.length > 0 &&
    v.scopes.every((s) => PUBLISH_SCOPES.includes(s as (typeof PUBLISH_SCOPES)[number]))
  );
}
function tokenCredential(url: string, value: TokenReply) {
  const credential: PublishingCredential = { ...value, format: "publishing-v1", url };
  if (!validPublishingCredential(credential))
    throw new DeployError("invalid-publishing-token-response");
  return credential;
}
export async function beginPublishingLogin(
  url: string,
  name: string,
  scopes: readonly string[] = PUBLISH_SCOPES,
) {
  url = deployUrl(url); // Remote plaintext is deliberately unsupported.
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const client = new DeployClient({ url, session: "", allowHttp: false });
  let response: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  };
  try {
    response = await client.json("/v1/publish/authorize", { name, scopes, challenge });
  } catch (e) {
    if (e instanceof DeployError && e.status === 404)
      throw new DeployError("server-upgrade-required-for-publishing");
    throw e;
  }
  const uri = new URL(response.verificationUri);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(response.deviceCode) ||
    !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(response.userCode) ||
    uri.origin !== url ||
    uri.pathname !== "/admin/" ||
    uri.searchParams.get("publish") !== response.userCode ||
    response.expiresIn !== 600 ||
    response.interval !== 5
  )
    throw new DeployError("invalid-authorization-response");
  return { url, verifier, ...response };
}
export async function waitPublishingLogin(
  login: Awaited<ReturnType<typeof beginPublishingLogin>>,
  options: { signal?: AbortSignal; pollMs?: number } = {},
) {
  const client = new DeployClient({ url: login.url, session: "", allowHttp: false }),
    deadline = Date.now() + login.expiresIn * 1000;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new DeployError("authorization-cancelled");
    await new Promise<void>((resolve) =>
      setTimeout(resolve, options.pollMs ?? login.interval * 1000),
    );
    if (options.signal?.aborted) throw new DeployError("authorization-cancelled");
    try {
      return tokenCredential(
        login.url,
        await client.json<TokenReply>("/v1/publish/token", {
          grantType: "device_code",
          deviceCode: login.deviceCode,
          verifier: login.verifier,
        }),
      );
    } catch (e) {
      if (e instanceof DeployError && ["authorization-pending", "slow-down"].includes(e.code))
        continue;
      throw e;
    }
  }
  throw new DeployError("authorization-expired-run-login-again");
}

export async function savePublishingCredential(path: string, value: PublishingCredential) {
  // Publishing is privileged. Do not silently fall back to a plaintext file store.
  if (process.platform !== "win32")
    throw new DeployError("publishing-encrypted-store-requires-windows");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomBytes(12).toString("hex") + ".tmp";
  try {
    await writeSecret(temp, value);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** A whole command holds the profile lock, so refresh rotation and deployment
 * receipts cannot race between two local AI/CLI invocations. No stale takeover. */
export async function lockPublishingProfile(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path + ".lock", "wx", 0o600);
  } catch {
    throw new DeployError("profile-in-use-check-running-command-or-stale-lock");
  }
  await handle.writeFile(String(process.pid));
  return async () => {
    await handle.close();
    await rm(path + ".lock", { force: true });
  };
}
export async function loadPublishingClient(path: string, expectedUrl?: string) {
  let value: unknown;
  try {
    value = await readSecret(path);
  } catch {
    throw new DeployError("login-required-run-server-deploy-login");
  }
  if (!validPublishingCredential(value))
    throw new DeployError("legacy-admin-login-requires-new-web-authorization");
  if (process.platform !== "win32")
    throw new DeployError("publishing-encrypted-store-requires-windows");
  let credential = value;
  deployUrl(credential.url);
  if (expectedUrl && deployUrl(expectedUrl) !== credential.url)
    throw new DeployError("saved-profile-server-mismatch");
  const authorize = async () => {
    if (credential.expiresAt > Date.now() + 60000) return credential.accessToken;
    if (credential.refreshExpiresAt <= Date.now() || credential.grantExpiresAt <= Date.now())
      throw new DeployError("publishing-authorization-expired-run-login");
    const anon = new DeployClient({ url: credential.url, session: "", allowHttp: false });
    const next = tokenCredential(
      credential.url,
      await anon.json<TokenReply>("/v1/publish/token", {
        grantType: "refresh_token",
        refreshToken: credential.refreshToken,
      }),
    );
    if (
      next.grantId !== credential.grantId ||
      JSON.stringify(next.scopes) !== JSON.stringify(credential.scopes)
    )
      throw new DeployError("publishing-authorization-changed");
    // Save before any authorized operation. An uncertain refresh is never retried automatically.
    await savePublishingCredential(path, next);
    credential = next;
    return next.accessToken;
  };
  const client = new DeployClient(
    { url: credential.url, session: "", allowHttp: false, publishing: true },
    authorize,
  );
  return {
    client,
    identity: () => ({
      url: credential.url,
      username: credential.username,
      grantId: credential.grantId,
      scopes: credential.scopes,
      expiresAt: credential.expiresAt,
      grantExpiresAt: credential.grantExpiresAt,
    }),
  };
}
