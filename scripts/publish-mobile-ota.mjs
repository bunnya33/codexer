import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, randomUUID, sign, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const project = resolve(import.meta.dirname, "../apps/mobile");
const require = createRequire(join(project, "package.json"));
const { getConfig } = require("expo/config");
const { values } = parseArgs({
  options: {
    "output-dir": { type: "string" },
    "relay-url": { type: "string" },
    platform: { type: "string", default: "all" },
  },
});
if (
  !values["output-dir"] ||
  !values["relay-url"] ||
  !["ios", "android", "all"].includes(values.platform)
) {
  throw new Error(
    "Usage: node scripts/publish-mobile-ota.mjs --relay-url <http(s)://relay> --output-dir <mobile-ota> [--platform ios|android|all]",
  );
}
const { updates } = getConfig(project).exp;
if (!updates?.enabled || !process.env.FROGCODER_UPDATE_PRIVATE_KEY) {
  throw new Error("Set FROGCODER_UPDATE_CERT and FROGCODER_UPDATE_PRIVATE_KEY");
}
const certificate = new X509Certificate(
  await readFile(resolve(project, updates.codeSigningCertificate)),
);
const privateKey = createPrivateKey(
  await readFile(resolve(process.env.FROGCODER_UPDATE_PRIVATE_KEY)),
);
if (!certificate.checkPrivateKey(privateKey))
  throw new Error("The private key does not match the update certificate");

const output = resolve(values["output-dir"]);
const relay = new URL(values["relay-url"]);
if (
  !["http:", "https:"].includes(relay.protocol) ||
  relay.username ||
  relay.password ||
  relay.pathname !== "/" ||
  relay.search ||
  relay.hash
) {
  throw new Error("--relay-url must be an HTTP(S) Relay origin");
}
const { version: relayVersion } = JSON.parse(
  await readFile(join(import.meta.dirname, "../package.json"), "utf8"),
);
if (!/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(relayVersion))
  throw new Error("Unsupported Relay version");
const manifestUrl = new URL("/v1/mobile-ota/manifest", relay.origin);
manifestUrl.searchParams.set("relayVersion", relayVersion);
const assetBase = new URL("assets/", manifestUrl);
const expo = join(dirname(require.resolve("expo/package.json")), "bin/cli");
const updatesCli = join(dirname(require.resolve("expo-updates/package.json")), "bin/cli.js");
const staging = await mkdtemp(join(tmpdir(), "frogcoder-ota-"));

async function writeAtomic(destination, bytes) {
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function publish(platform) {
  const { runtimeVersion } = JSON.parse(
    execFileSync(
      process.execPath,
      [updatesCli, "runtimeversion:resolve", "--platform", platform, "--workflow", "managed"],
      { cwd: project, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  if (!/^[a-f0-9]{40}$/.test(runtimeVersion)) throw new Error("Missing native runtime fingerprint");

  const exported = join(staging, platform);
  execFileSync(
    process.execPath,
    [expo, "export", "--platform", platform, "--output-dir", exported],
    {
      cwd: project,
      stdio: "inherit",
      env: { ...process.env, CI: "1" },
    },
  );
  const { fileMetadata } = JSON.parse(await readFile(join(exported, "metadata.json"), "utf8"));
  const { bundle, assets } = fileMetadata[platform];
  if (!bundle.endsWith(".hbc")) throw new Error("Expected a Hermes bytecode bundle");

  const store = async (path, extension) => {
    const bytes = await readFile(join(exported, path));
    const digest = createHash("sha256").update(bytes).digest();
    const hex = digest.toString("hex");
    await writeAtomic(join(output, "assets", hex), bytes);
    return {
      key: basename(path, extension === "js" ? ".hbc" : "." + extension),
      hash: digest.toString("base64url"),
      fileExtension: "." + extension,
      contentType: extension === "js" ? "application/javascript" : "application/octet-stream",
      url: new URL(hex, assetBase).href,
    };
  };
  const manifest = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion,
    launchAsset: await store(bundle, "js"),
    assets: [],
    metadata: { relayUpdateUrl: manifestUrl.href },
    extra: {},
  };
  for (const { path, ext } of assets) manifest.assets.push(await store(path, ext));
  const body = JSON.stringify(manifest);
  if (Buffer.byteLength(body) > 512 * 1024) throw new Error("Update manifest is too large");
  const signature = sign("sha256", Buffer.from(body), privateKey).toString("base64");
  await mkdir(join(output, relayVersion, platform), { recursive: true });
  await writeAtomic(
    join(output, relayVersion, platform, runtimeVersion + ".json"),
    JSON.stringify({ manifest, signature }),
  );
  console.log(`Published ${platform} ${runtimeVersion} ${manifest.id}`);
}

try {
  await mkdir(join(output, "assets"), { recursive: true });
  for (const platform of values.platform === "all" ? ["ios", "android"] : [values.platform]) {
    await publish(platform);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
