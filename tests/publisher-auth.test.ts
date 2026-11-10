import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  beginPublishingLogin,
  waitPublishingLogin,
  loadPublishingClient,
  lockPublishingProfile,
  savePublishingCredential,
} from "../packages/shared/src/publisher-auth.js";
import { writeSecret } from "../packages/shared/src/secrets.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  let url = "",
    challenge = "",
    polls = 0,
    refreshes = 0,
    approved = false;
  const access = "cdxp_a_" + "A".repeat(43),
    refresh = "cdxp_r_" + "B".repeat(43),
    calls: string[] = [];
  const reply = () => ({
    accessToken: access,
    refreshToken: "cdxp_r_" + "C".repeat(43),
    expiresAt: Date.now() + 600000,
    refreshExpiresAt: Date.now() + 86400000,
    grantExpiresAt: Date.now() + 2 * 86400000,
    grantId: "test-grant",
    scopes: ["server:read"],
    username: "管理员·兔子🐰",
  });
  const server = createServer(async (req, res) => {
    calls.push(req.url!);
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/v1/publish/authorize") {
      challenge = body.challenge;
      return json(200, {
        deviceCode: "D".repeat(43),
        userCode: "ABCD-1234",
        verificationUri: url + "/admin/?publish=ABCD-1234",
        expiresIn: 600,
        interval: 5,
      });
    }
    if (req.url === "/v1/publish/token") {
      if (body.grantType === "refresh_token") {
        refreshes++;
        return body.refreshToken === refresh
          ? json(200, reply())
          : json(400, { error: "invalid-publishing-credential" });
      }
      polls++;
      expect(createHash("sha256").update(body.verifier).digest("base64url")).toBe(challenge);
      return approved ? json(200, reply()) : json(400, { error: "authorization-pending" });
    }
    if (req.url === "/v1/publish/me")
      return req.headers.authorization === "Bearer " + access
        ? json(200, { grantId: "test-grant", scopes: ["server:read"] })
        : json(401, { error: "unauthorized" });
    json(404, { error: "not-found" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("listen");
  url = "http://127.0.0.1:" + addr.port;
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  );
  return {
    url,
    calls,
    reply,
    refresh,
    approve: () => {
      approved = true;
    },
    counts: () => ({ polls, refreshes }),
  };
}
it("authorizes on the real server website and exchanges only the bound device proof", async () => {
  const remote = await fixture(),
    login = await beginPublishingLogin(remote.url, "My PC", ["server:read"]);
  expect(login.verificationUri).toBe(remote.url + "/admin/?publish=ABCD-1234");
  setTimeout(remote.approve, 15);
  const credential = await waitPublishingLogin(login, { pollMs: 5 });
  expect(credential).toMatchObject({
    url: remote.url,
    grantId: "test-grant",
    format: "publishing-v1",
  });
  expect(remote.counts().polls).toBeGreaterThan(0);
  expect(remote.calls).not.toContain("/v1/admin/auth/login");
  await expect(beginPublishingLogin("http://47.109.21.89:8899", "PC")).rejects.toThrow(
    "allow-http",
  );
});
it("cancels authorization without requesting an administrator password", async () => {
  const remote = await fixture(),
    login = await beginPublishingLogin(remote.url, "PC"),
    controller = new AbortController();
  controller.abort();
  await expect(waitPublishingLogin(login, { signal: controller.signal })).rejects.toThrow(
    "authorization-cancelled",
  );
  expect(remote.counts().polls).toBe(0);
});
it.skipIf(process.platform !== "win32")(
  "rotates refresh credentials into DPAPI storage before using the access token",
  async () => {
    const remote = await fixture(),
      dir = await mkdtemp(join(tmpdir(), "codexer-publish-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "default.secret");
    await savePublishingCredential(path, {
      ...remote.reply(),
      format: "publishing-v1",
      url: remote.url,
      accessToken: "cdxp_a_" + "E".repeat(43),
      refreshToken: remote.refresh,
      expiresAt: Date.now() - 1,
    });
    const { client } = await loadPublishingClient(path);
    await client.assertAdmin();
    await client.assertAdmin();
    expect(remote.counts().refreshes).toBe(1);
    const disk = await readFile(path, "utf8");
    expect(disk).toContain("windows-dpapi-v1");
    expect(disk).not.toContain(remote.reply().accessToken);
    expect(disk).not.toContain(remote.refresh);
    const loaded = await loadPublishingClient(path);
  expect(loaded.identity().username).toBe(remote.reply().username);
    await loaded.client.assertAdmin();
    expect(remote.counts().refreshes).toBe(1);
  },
);
it("refuses legacy full administrator sessions and prevents concurrent profile use", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codexer-publish-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "default.secret");
  await writeSecret(path, { url: "https://server.test", session: "old-admin-session" });
  await expect(loadPublishingClient(path)).rejects.toThrow("legacy-admin-login");
  const unlock = await lockPublishingProfile(path);
  try {
    await expect(lockPublishingProfile(path)).rejects.toThrow("profile-in-use");
  } finally {
    await unlock();
  }
  await (
    await lockPublishingProfile(path)
  )();
});
