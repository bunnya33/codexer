import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const directory = resolve("apps/control-desktop");
const output = join(directory, "dist");
await readFile(join(directory, "package.json"));
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "setup"), { recursive: true });
await mkdir(join(output, "shell"), { recursive: true });
await mkdir(join(output, "titlebar"), { recursive: true });

for (const entry of ["main", "preload"]) {
  await build({
    entryPoints: [join(directory, "src", entry + ".ts")],
    outfile: join(output, entry + ".cjs"),
    platform: "node",
    target: "node24",
    format: "cjs",
    bundle: true,
    external: ["electron"],
    sourcemap: false,
  });
}
await build({
  entryPoints: [join(directory, "src/setup/setup.ts")],
  outfile: join(output, "setup/setup.js"),
  platform: "browser",
  target: "chrome142",
  bundle: true,
  minify: true,
});
await build({
  entryPoints: [join(directory, "src/titlebar/titlebar.ts")],
  outfile: join(output, "titlebar/titlebar.js"),
  platform: "browser",
  target: "chrome142",
  bundle: true,
  minify: true,
});
for (const file of ["index.html", "styles.css"]) {
  await copyFile(join(directory, "src/setup", file), join(output, "setup", file));
}
await copyFile(join(directory, "src/shell/index.html"), join(output, "shell/index.html"));
await copyFile(join(directory, "src/titlebar/styles.css"), join(output, "titlebar/styles.css"));
await copyFile(join(directory, "assets/icon.png"), join(output, "icon.png"));
console.log("Windows control client shell and server setup bundled.");
