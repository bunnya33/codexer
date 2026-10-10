// Node is used only to build the existing React/React Native frontend assets.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
function run(executable, args) {
  const r = spawnSync(executable, args, { stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`${executable} failed`);
}
const go =
  process.env.CODEXER_GO ??
  (existsSync(".local/go-tools/go/bin/go") ? resolve(".local/go-tools/go/bin/go") : "go");
run(process.execPath, ["scripts/build-protocol-schema.mjs"]);
run(process.execPath, [process.env.npm_execpath, "run", "build:web"]);
run(process.execPath, [process.env.npm_execpath, "run", "build:admin"]);
for (const [name, source] of [
  ["web", "apps/web/dist"],
  ["admin", "apps/admin/dist"],
]) {
  const target = `apps/relay/assets/${name}`;
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  await writeFile(
    `${target}/placeholder.txt`,
    "Run npm run build:server to embed the production frontend.\n",
  );
}
// Shared browser code is embedded as data, never executed by the server.
const runtime = await readFile("packages/client-shared/src/preview-runtime-source.ts", "utf8");
const script = JSON.parse(
  runtime
    .slice(runtime.indexOf(" = ") + 3)
    .trim()
    .replace(/;$/, ""),
);
await writeFile("apps/relay/protocol/preview-runtime.js", script);
const preview = await readFile("packages/client-shared/src/preview-runtime.ts", "utf8");
await writeFile(
  "apps/relay/protocol/preview.css",
  preview.split("export const previewStyles = `")[1].split("`;")[0],
);
const { version } = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("dist", { recursive: true });
run(go, [
  "build",
  "-trimpath",
  "-ldflags",
  `-s -w -X main.version=${version}`,
  "-o",
  process.platform === "win32" ? "dist/codexer.exe" : "dist/codexer",
  "./cmd/codexer",
]);
