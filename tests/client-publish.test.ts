import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectClientPackage,
  publishClientPackage,
} from "../packages/shared/src/client-publish.js";
import { DeployClient } from "../packages/shared/src/server-deploy.js";
import type { ClientRelease } from "../packages/shared/src/client-release.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "codexer-client-publish-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.alloc(512, 9),
    path = join(dir, "Codexer-Agent-0.2.34.exe");
  await writeFile(path, bytes);
  const file = await inspectClientPackage(path, "agent-windows-x64-setup");
  const releases: Record<string, ClientRelease> = {},
    requests: string[] = [],
    uploads: Buffer[] = [];
  let legacy: unknown = null,
    legacyFailure = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push(req.method + " " + url.pathname);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/v1/publish/me")
      return json(200, { grantId: "test", scopes: ["clients:read", "clients:write"] });
    if (req.method === "GET")
      return json(200, url.pathname.includes("pc-agent") ? { release: legacy } : { releases });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const data = Buffer.concat(chunks);
    uploads.push(data);
    const q = url.searchParams,
      sha256 = createHash("sha256").update(data).digest("hex");
    expect(q.get("sha256")).toBe(sha256);
    const release = {
      id: "12345678-1234-4234-8234-123456789012",
      target: file.target,
      name: q.get("name")!,
      version: q.get("version")!,
      buildNumber: Number(q.get("buildNumber") || 0),
      notes: q.get("notes") ?? "",
      sha256,
      size: data.length,
      uploadedAt: Date.now(),
    };
    if (url.pathname.includes("pc-agent")) {
      if (legacyFailure) return json(500, { error: "agent-release-storage-error" });
      legacy = release;
    } else releases[file.target] = release;
    json(200, { release });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("listen");
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  );
  const client = new DeployClient({
    url: "http://127.0.0.1:" + addr.port,
    session: "test",
    allowHttp: false,
    publishing: true,
  });
  return {
    client,
    file,
    path,
    bytes,
    requests,
    uploads,
    releases,
    setLegacyFailure: (v: boolean) => {
      legacyFailure = v;
    },
  };
}
it("preflights without publishing, uploads original bytes to both Windows Agent channels and verifies the catalog", async () => {
  const f = await fixture();
  expect(await publishClientPackage(f.client, f.file)).toMatchObject({
    result: "dry-run",
    legacyChannel: true,
  });
  expect(f.requests.every((r) => r.startsWith("GET"))).toBe(true);
  expect(await publishClientPackage(f.client, f.file, true)).toMatchObject({
    result: "published",
    installedOnDevices: false,
  });
  expect(f.uploads).toEqual([f.bytes, f.bytes]);
  expect(await publishClientPackage(f.client, f.file, true)).toMatchObject({
    result: "already-published",
  });
  expect(f.uploads).toHaveLength(2);
  await expect(
    publishClientPackage(f.client, { ...f.file, version: "0.2.33" }, true),
  ).rejects.toThrow("client-version-not-newer");
  expect(f.uploads).toHaveLength(2);
});
it("reports a partial legacy-channel failure and resumes without publishing a duplicate modern package", async () => {
  const f = await fixture();
  f.setLegacyFailure(true);
  await expect(publishClientPackage(f.client, f.file, true)).rejects.toThrow(
    "agent-release-storage-error",
  );
  expect(f.releases[f.file.target]?.sha256).toBe(f.file.sha256);
  f.setLegacyFailure(false);
  expect(await publishClientPackage(f.client, f.file, true)).toMatchObject({ result: "published" });
  expect(
    f.requests.filter((r) => r === "PUT /v1/admin/client-releases/" + f.file.target),
  ).toHaveLength(1);
});
it("validates target, package name and checksum before upload", async () => {
  const f = await fixture();
  await expect(inspectClientPackage(f.path, "unknown")).rejects.toThrow("invalid-client-target");
  await expect(inspectClientPackage(f.path, "control-android")).rejects.toThrow(
    "invalid-client-package",
  );
  const checksum = f.path + ".sha256";
  await writeFile(checksum, "0".repeat(64) + "  " + f.file.name);
  await expect(inspectClientPackage(f.path, f.file.target, { checksum })).rejects.toThrow(
    "checksum-mismatch",
  );
});
