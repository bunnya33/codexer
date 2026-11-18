import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DeployClient, DeployError } from "./server-deploy.js";

const catalogPath = "/v1/admin/mobile-ota";
const maxArchiveBytes = 128 * 1024 * 1024;
const archiveName = /^frogcoder-ota-(\d{1,10}\.\d{1,10}\.\d{1,10})-(android|ios)-([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.tar\.gz$/;

type OTARelease = {
  id: string;
  platform: string;
  runtimeVersion: string;
  createdAt: string;
  label?: string;
  relayUrl?: string;
};
type OTACatalog = { relayVersion: string; releases: OTARelease[] };

export async function publishMobileOTAPackage(
  client: DeployClient,
  path: string,
  options: { apply?: boolean; checksum?: string } = {},
) {
  path = resolve(path);
  const name = basename(path);
  const match = archiveName.exec(name);
  if (!match) throw new DeployError("invalid-ota-package-name");
  const [, relayVersion, platform, id] = match;
  const file = await stat(path);
  if (!file.isFile() || file.size < 128 || file.size > maxArchiveBytes)
    throw new DeployError("invalid-ota-package-size");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const sha256 = digest.digest("hex");
  if (options.checksum) {
    if ((await stat(options.checksum)).size > 4096) throw new DeployError("invalid-checksum-file");
    const [expected, filename, extra] = (await readFile(options.checksum, "utf8"))
      .trim()
      .split(/\s+/);
    if (expected?.toLowerCase() !== sha256 || filename?.replace(/^\*/, "") !== name || extra)
      throw new DeployError("checksum-mismatch");
  }

  const catalog = await client.request<OTACatalog>(catalogPath);
  if (!Array.isArray(catalog.releases)) throw new DeployError("invalid-ota-catalog");
  if (catalog.relayVersion !== relayVersion) throw new DeployError("ota-relay-version");
  const plan = { url: client.url, name, relayVersion, platform, id, size: file.size, sha256 };
  if (!options.apply) return { result: "dry-run", ...plan };

  const params = new URLSearchParams({ name, sha256 });
  const stream = createReadStream(path);
  let release: OTARelease;
  try {
    ({ release } = await client.request<{ release: OTARelease }>(
      catalogPath + "?" + params,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.size),
        },
        body: stream as unknown as BodyInit,
        duplex: "half",
      } as RequestInit,
      10 * 60 * 1000,
    ));
  } finally {
    stream.destroy();
  }
  if (release?.id !== id || release.platform !== platform || !/^[a-f\d]{40}$/.test(release.runtimeVersion))
    throw new DeployError("published-ota-package-mismatch");
  const active = await client.request<OTACatalog>(catalogPath);
  if (
    active.relayVersion !== relayVersion ||
    !active.releases?.some((item) => item.id === id && item.platform === platform && item.runtimeVersion === release.runtimeVersion)
  )
    throw new DeployError("ota-catalog-verification-failed");
  return { result: "published", ...plan, release };
}
