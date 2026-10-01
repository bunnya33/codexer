import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";

export function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 128) throw new Error("password-must-be-12-to-128-characters");
}
async function key(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => derive(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, result) => error ? reject(error) : resolve(result)));
}
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await key(password, salt)).toString("hex")}`;
}
const dummyHash = `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`;
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const [, salt, digest] = (encoded ?? dummyHash).split(":");
  if (!salt || !digest) return false;
  const actual = await key(password, salt), expected = Buffer.from(digest, "hex");
  return encoded !== null && expected.length === actual.length && timingSafeEqual(actual, expected);
}
