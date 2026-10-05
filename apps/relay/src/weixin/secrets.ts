import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export async function loadWeixinKey(directory: string, configured?: string): Promise<Buffer> {
  if (configured) {
    if (!/^[a-fA-F0-9]{64}$/.test(configured))
      throw new Error("RELAY_WEIXIN_KEY must be 64 hexadecimal characters");
    return Buffer.from(configured, "hex");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "weixin.key");
  try {
    await writeFile(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("invalid-weixin-encryption-key");
  return Buffer.from(value, "hex");
}
export class WeixinSecrets {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("invalid-weixin-encryption-key");
  }

  seal(value: string, scope: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  open(value: string, scope: string): string {
    const body = Buffer.from(value, "base64"),
      decipher = createDecipheriv("aes-256-gcm", this.key, body.subarray(0, 12));
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(body.subarray(12, 28));
    return Buffer.concat([decipher.update(body.subarray(28)), decipher.final()]).toString("utf8");
  }
}
