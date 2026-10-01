import { imagePayloadSchema, MAX_IMAGE_BYTES } from "../../protocol/src/index.js";
import type { ImagePayload } from "../../protocol/src/index.js";

export function imageMime(bytes: Uint8Array): ImagePayload["mimeType"] | null {
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b.length >= 12 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 10 && ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

export function decodeImage(value: unknown): { image: ImagePayload; bytes: Buffer } {
  const image = imagePayloadSchema.parse(value);
  const bytes = Buffer.from(image.base64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== image.base64 || imageMime(bytes) !== image.mimeType) throw new Error("invalid-image");
  return { image, bytes };
}
