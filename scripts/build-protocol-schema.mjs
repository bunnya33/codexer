// Build-time bridge from the shared frontend protocol to the Go validator.
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
await mkdir(".local", { recursive: true });
const folder = await mkdtemp(resolve(".local/protocol-build-"));
const output = resolve(folder, "protocol.mjs");
await build({
  stdin: {
    contents:
      "export * from './packages/protocol/src/index.ts'; export {fileResponseSchema} from './packages/protocol/src/files.ts'; export {previewResponseSchema} from './packages/protocol/src/previews.ts';",
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: output,
});
const protocol = await import(pathToFileURL(output).href);
const { z } = await import("zod");
const schemas = {
  command: protocol.commandSchema,
  device: protocol.deviceMessageSchema,
  client: protocol.clientMessageSchema,
  image: protocol.imagePayloadSchema,
  file: protocol.fileResponseSchema,
  preview: protocol.previewResponseSchema,
};
const content =
  JSON.stringify(
    Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }),
      ]),
    ),
    null,
    2,
  ) + "\n";
const target = "apps/relay/protocol/schemas.json";
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== content)
    throw new Error("Protocol changed: run npm run build:protocol");
} else await writeFile(target, content);
await rm(folder, { recursive: true, force: true });
