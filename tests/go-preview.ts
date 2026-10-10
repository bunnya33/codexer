import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
export function rewritePreviewContent(
  text: string,
  kind: string,
  prefix: string,
  origin: string,
  path = "/",
): string {
  const child = spawnSync(
    resolve(process.platform === "win32" ? ".local/go-test-driver.exe" : ".local/go-test-driver"),
    [],
    {
      input:
        JSON.stringify({
          id: 1,
          method: "rewritePreviewContent",
          args: [text, kind, prefix, origin, path],
        }) + "\n",
      encoding: "utf8",
    },
  );
  if (child.status !== 0) throw new Error("Go preview contract failed");
  const result = JSON.parse(child.stdout);
  if (result.error) throw new Error(result.error);
  return result.value;
}
