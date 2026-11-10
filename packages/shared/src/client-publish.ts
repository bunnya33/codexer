import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CLIENT_TARGETS, clientReleaseSchema, newerClientVersion } from "./client-release.js";
import type { ClientRelease, ClientTarget } from "./client-release.js";
import { agentReleaseSchema } from "./agent-release.js";
import { DeployClient, DeployError } from "./server-deploy.js";

export type ClientPackage = {
  path: string;
  name: string;
  target: ClientTarget;
  version: string;
  buildNumber: number;
  notes: string;
  sha256: string;
  size: number;
};
const officialAndroidCertificate =
  "5e8f351666c250682effb88a1ebec7ca4d13196e9f272e054f5881eaa393a211";
export async function inspectAndroidPackage(path: string) {
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
  let versions: string[];
  try {
    versions = (await readdir(join(sdk, "build-tools")))
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    throw new DeployError("android-build-tools-required");
  }
  if (!versions.length) throw new DeployError("android-build-tools-required");
  const tools = join(sdk, "build-tools", versions[0]!),
    run = promisify(execFile);
  try {
    const { stdout: manifest } = await run(
      join(tools, process.platform === "win32" ? "aapt2.exe" : "aapt2"),
      ["dump", "badging", path],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const match = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(
      manifest,
    );
    if (
      !match ||
      match[1] !== "com.bunnya33.codexer.remote" ||
      manifest.includes("application-debuggable")
    )
      throw new DeployError("invalid-android-release-manifest");
    const java = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
      : process.platform === "win32"
        ? "C:/Program Files/Android/Android Studio/jbr/bin/java.exe"
        : "java";
    const { stdout: signature } = await run(
      java,
      ["-jar", join(tools, "lib", "apksigner.jar"), "verify", "--print-certs", path],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const certificates = [
      ...signature.matchAll(/Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)/gi),
    ].map((m) => m[1]!.toLowerCase());
    if (certificates.length !== 1 || certificates[0] !== officialAndroidCertificate)
      throw new DeployError("android-release-certificate-mismatch");
    return { version: match[3]!, buildNumber: Number(match[2]), certificate: certificates[0] };
  } catch (e) {
    if (e instanceof DeployError) throw e;
    throw new DeployError("android-package-verification-failed");
  }
}
export async function inspectClientPackage(
  path: string,
  target: string,
  options: { version?: string; buildNumber?: number; notes?: string; checksum?: string } = {},
): Promise<ClientPackage> {
  if (!Object.hasOwn(CLIENT_TARGETS, target)) throw new DeployError("invalid-client-target");
  path = resolve(path);
  const name = basename(path),
    file = await stat(path),
    extension = target === "control-android" ? ".apk" : target.includes("macos") ? ".dmg" : ".exe";
  if (
    !file.isFile() ||
    file.size < 128 ||
    file.size > 512 * 1024 * 1024 ||
    extname(name).toLowerCase() !== extension ||
    name.length > 180 ||
    /[\x00-\x1f\x7f]/.test(name)
  )
    throw new DeployError("invalid-client-package");
  const matches = [
    ...name.slice(0, -extension.length).matchAll(/(?<![\d.])(\d+\.\d+\.\d+)(?![\d.])/g),
  ].map((m) => m[1]!);
  const metadata = target === "control-android" ? await inspectAndroidPackage(path) : null;
  const version =
      metadata?.version ??
      options.version ??
      (new Set(matches).size === 1 ? matches[0] : undefined),
    buildNumber = metadata?.buildNumber ?? options.buildNumber ?? 0;
  if (
    !version ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !Number.isSafeInteger(buildNumber) ||
    buildNumber < 0 ||
    buildNumber > 2147483647 ||
    (metadata && options.version && metadata.version !== options.version) ||
    (metadata &&
      options.buildNumber !== undefined &&
      metadata.buildNumber !== options.buildNumber) ||
    (options.notes?.length ?? 0) > 2000
  )
    throw new DeployError("client-package-version-mismatch-or-required");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const sha256 = digest.digest("hex");
  if (options.checksum) {
    if ((await stat(options.checksum)).size > 4096) throw new DeployError("invalid-checksum-file");
    const parts = (await readFile(options.checksum, "utf8")).trim().split(/\s+/);
    if (
      parts.length !== 2 ||
      parts[0]?.toLowerCase() !== sha256 ||
      parts[1]?.replace(/^\*/, "") !== name
    )
      throw new DeployError("checksum-mismatch");
  }
  return {
    path,
    name,
    target: target as ClientTarget,
    version,
    buildNumber,
    notes: options.notes ?? "",
    sha256,
    size: file.size,
  };
}
export async function publishClientPackage(
  client: DeployClient,
  file: ClientPackage,
  apply = false,
) {
  await client.assertAdmin();
  const catalog = await client.request<{ releases: Partial<Record<ClientTarget, ClientRelease>> }>(
    "/v1/admin/client-releases",
  );
  if (!catalog.releases || typeof catalog.releases !== "object")
    throw new DeployError("invalid-client-catalog");
  const current = catalog.releases[file.target];
  const same =
    !!current &&
    current.sha256 === file.sha256 &&
    current.size === file.size &&
    current.version === file.version &&
    current.buildNumber === file.buildNumber;
  if (
    current &&
    !same &&
    ((!newerClientVersion(file.version, current.version) &&
      !(
        file.target === "control-android" &&
        file.version === current.version &&
        file.buildNumber > current.buildNumber
      )) ||
      (file.target === "control-android" && file.buildNumber <= current.buildNumber))
  )
    throw new DeployError("client-version-not-newer");
  const plan = {
    url: client.url,
    target: file.target,
    name: file.name,
    from: current?.version ?? null,
    to: file.version,
    buildNumber: file.buildNumber,
    size: file.size,
    sha256: file.sha256,
  };
  // The Windows Agent's original update channel remains in use by installed versions.
  const legacy =
    file.target === "agent-windows-x64-setup"
      ? await client.request<{ release: unknown }>("/v1/admin/pc-agent/release")
      : null;
  const previous = legacy?.release ? agentReleaseSchema.parse(legacy.release) : null;
  const legacySame =
    previous?.sha256 === file.sha256 &&
    previous.size === file.size &&
    previous.version === file.version;
  if (previous && !legacySame && !newerClientVersion(file.version, previous.version))
    throw new DeployError("legacy-agent-version-not-newer");
  if (!apply)
    return { result: "dry-run", ...plan, alreadyPublished: same, legacyChannel: !!legacy };
  const send = async (path: string) =>
    client.request<{ release: unknown }>(
      path,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.size),
        },
        body: createReadStream(file.path) as unknown as BodyInit,
        duplex: "half",
      } as RequestInit,
      10 * 60000,
    );
  if (!same) {
    const query = new URLSearchParams({
      name: file.name,
      version: file.version,
      buildNumber: String(file.buildNumber),
      notes: file.notes,
      sha256: file.sha256,
    });
    const release = clientReleaseSchema.parse(
      (await send("/v1/admin/client-releases/" + file.target + "?" + query)).release,
    );
    if (
      release.sha256 !== file.sha256 ||
      release.size !== file.size ||
      release.version !== file.version ||
      release.buildNumber !== file.buildNumber ||
      release.target !== file.target
    )
      throw new DeployError("published-client-package-mismatch");
  }
  if (legacy && !legacySame) {
    const query = new URLSearchParams({
      name: file.name,
      version: file.version,
      sha256: file.sha256,
    });
    const release = agentReleaseSchema.parse(
      (await send("/v1/admin/pc-agent/release?" + query)).release,
    );
    if (
      release.sha256 !== file.sha256 ||
      release.size !== file.size ||
      release.version !== file.version
    )
      throw new DeployError("published-agent-package-mismatch");
  }
  const verified = await client.request<{ releases: Partial<Record<ClientTarget, ClientRelease>> }>(
    "/v1/admin/client-releases",
  );
  if (
    verified.releases[file.target]?.sha256 !== file.sha256 ||
    verified.releases[file.target]?.version !== file.version
  )
    throw new DeployError("client-catalog-verification-failed");
  return {
    result: same && (!legacy || legacySame) ? "already-published" : "published",
    ...plan,
    legacyChannel: !!legacy,
    installedOnDevices: false,
  };
}
