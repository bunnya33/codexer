import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { DeployError } from "./server-deploy.js";

/** Read a pasted code without echoing it or accepting secrets in argv. */
export async function readPublishingCode() {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 256) throw new DeployError("invalid-publishing-code");
    }
    return value.trim();
  }
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  reader.once("SIGINT", cancel);
  process.stderr.write("粘贴后台生成的发布授权码（输入不显示）：");
  try {
    return await reader.question("", { signal: abort.signal });
  } catch {
    throw new DeployError("authorization-cancelled");
  } finally {
    reader.close();
    muted.end();
    process.stderr.write("\n");
  }
}
