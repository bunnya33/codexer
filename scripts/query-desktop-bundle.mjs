import { closeSync, openSync, readSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string" },
    context: { type: "string", default: "500" },
    limit: { type: "string", default: "4" },
  },
});
const [archive, ...needles] = positionals;
if (!archive) {
  throw new Error("Usage: npm run inspect:bundle -- <app.asar> <needle> [--file path]");
}

const fd = openSync(archive, "r");
try {
  const prefix = Buffer.alloc(16);
  readSync(fd, prefix, 0, prefix.length, 0);
  const indexLength = prefix.readUInt32LE(12);
  if (indexLength > 16 * 1024 * 1024) throw new Error("Unexpected ASAR header size");
  const bytes = Buffer.alloc(indexLength);
  readSync(fd, bytes, 0, bytes.length, 16);
  const index = JSON.parse(bytes.toString("utf8"));
  const files = [];
  function walk(entries, parent = "") {
    for (const [name, entry] of Object.entries(entries)) {
      const path = `${parent}${name}`;
      if (entry.files) walk(entry.files, `${path}/`);
      else if (!entry.unpacked && (values.file ? path === values.file : /^\.vite\/build\/.+\.js$/.test(path))) {
        files.push({ path, entry });
      }
    }
  }
  walk(index.files);
  const context = Number(values.context);
  const limit = Number(values.limit);
  for (const { path, entry } of files) {
    const buffer = Buffer.alloc(entry.size);
    readSync(fd, buffer, 0, buffer.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    const source = buffer.toString("utf8");
    if (needles.length === 0) {
      console.log(JSON.stringify({ file: path, size: entry.size, prefix: source.slice(0, context) }));
      continue;
    }
    for (const needle of needles) {
      let position = -1;
      for (let count = 0; count < limit; count++) {
        position = source.indexOf(needle, position + 1);
        if (position === -1) break;
        console.log(JSON.stringify({ file: path, needle, position, context: source.slice(Math.max(0, position - context), position + needle.length + context) }));
      }
    }
  }
} finally {
  closeSync(fd);
}
