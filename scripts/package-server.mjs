import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
await readFile("apps/relay/assets/web/index.html");
await readFile("apps/relay/assets/admin/index.html");
const go =
  process.env.CODEXER_GO ??
  (existsSync(".local/go-tools/go/bin/go") ? resolve(".local/go-tools/go/bin/go") : "go");
const targets = (process.env.CODEXER_TARGETS ?? `${process.platform}/${process.arch}`).split(",");
await mkdir("release", { recursive: true });
for (const target of targets) {
  const [os, arch] = target.split("/");
  if (!["linux", "darwin"].includes(os) || !["amd64", "arm64", "x64"].includes(arch))
    throw new Error("unsupported-target");
  const goArch = arch === "x64" ? "amd64" : arch;
  const staging = resolve(".local/server-package", os + "-" + goArch);
  await rm(staging, { recursive: true, force: true });
  await mkdir(resolve(staging, "codexer"), { recursive: true });
  const executable = resolve(staging, "codexer/codexer");
  const build = spawnSync(
    go,
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.version=${version}`,
      "-o",
      executable,
      "./cmd/codexer",
    ],
    { stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: goArch } },
  );
  if (build.status !== 0) throw new Error("go-build-failed");
  for (const path of [
    "install.sh",
    "bootstrap.sh",
    "README.md",
    "docs",
    "infra/compose.yaml",
    "infra/Caddyfile",
    "infra/.env.example",
  ])
    await cp(resolve(path), resolve(staging, "codexer", path), {
      recursive: true,
      filter: (source) => !source.includes("/docs/") || source.endsWith(".md"),
    });
  await writeFile(resolve(staging, "codexer/VERSION"), version + "\n");
  await writeFile(
    resolve(staging, "codexer/server-bundle.json"),
    JSON.stringify({
      version,
      kind: "codexer-server-bundle",
      runtime: "go",
      os,
      arch: goArch,
      builtAt: new Date().toISOString(),
    }),
  );
  const archive = resolve(`release/codexer-server-${version}-${os}-${goArch}.tar.gz`);
  const tar = spawnSync("tar", ["--format=pax", "-czf", archive, "-C", staging, "codexer"], {
    stdio: "inherit",
  });
  if (tar.status !== 0) throw new Error("archive-failed");
  const hash = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(archive + ".sha256", hash + "  " + archive.split(/[\\/]/).at(-1) + "\n");
  console.log(archive);
}
