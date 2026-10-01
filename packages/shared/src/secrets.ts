import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function dpapi(value: string, operation: "protect" | "unprotect"): Promise<string> {
  const protect = operation === "protect";
  const script = `Add-Type -AssemblyName System.Security\n$secretText = [Console]::In.ReadToEnd()\n$secretBytes = ${protect ? "[System.Text.Encoding]::UTF8.GetBytes($secretText)" : "[Convert]::FromBase64String($secretText)"}\n$secretResult = [System.Security.Cryptography.ProtectedData]::${protect ? "Protect" : "Unprotect"}($secretBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)\n[Console]::Out.Write(${protect ? "[Convert]::ToBase64String($secretResult)" : "[System.Text.Encoding]::UTF8.GetString($secretResult)"})`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += String(chunk); });
    child.stderr.resume();
    child.on("error", () => reject(new Error("secret-store-unavailable")));
    child.on("close", code => { code === 0 ? resolve(output.trim()) : reject(new Error("secret-store-unavailable")); });
    child.stdin.end(value);
  });
}
export async function writeSecret(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const content = JSON.stringify(value);
  const stored = process.platform === "win32" ? { format: "windows-dpapi-v1", value: await dpapi(content, "protect") } : { format: "file-v1", value: content };
  await writeFile(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}
export async function readSecret<T>(path: string): Promise<T> {
  const stored = JSON.parse(await readFile(path, "utf8")) as { format: string; value: string };
  const content = stored.format === "windows-dpapi-v1" ? await dpapi(stored.value, "unprotect") : stored.format === "file-v1" && process.platform !== "win32" ? stored.value : null;
  if (content === null) throw new Error("unsupported-secret-store");
  return JSON.parse(content) as T;
}
