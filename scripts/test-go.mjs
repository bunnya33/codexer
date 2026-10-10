import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const go =
  process.env.CODEXER_GO ??
  (existsSync(".local/go-tools/go/bin/go") ? resolve(".local/go-tools/go/bin/go") : "go");
const schema = spawnSync(process.execPath, ["scripts/build-protocol-schema.mjs", "--check"], {
  stdio: "inherit",
});
if (schema.status !== 0) process.exit(schema.status ?? 1);
await mkdir(".local", { recursive: true });
for (const args of [
  ["test", "./..."],
  [
    "build",
    "-o",
    process.platform === "win32" ? ".local/go-test-driver.exe" : ".local/go-test-driver",
    "./tests/go-driver",
  ],
]) {
  const r = spawnSync(go, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
