import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ImageRegistry } from "../packages/codex-adapter/src/images.js";
import { normalizeHistoryTurn } from "../packages/codex-adapter/src/normalize.js";
import { commandSchema, jsonBytes, MAX_IMAGE_BYTES } from "../packages/protocol/src/index.js";
import { decodeImage } from "../packages/shared/src/images.js";
import { command } from "./helpers.js";

export const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
it("checks image signatures, canonical base64, type and byte limit", () => {
  expect(decodeImage({ name: "one.png", mimeType: "image/png", base64: pngBase64 }).bytes.length).toBeGreaterThan(20);
  expect(() => decodeImage({ name: "bad.png", mimeType: "image/png", base64: Buffer.from("private text file").toString("base64") })).toThrow();
  expect(() => decodeImage({ name: "bad.jpg", mimeType: "image/jpeg", base64: pngBase64 })).toThrow();
  expect(() => decodeImage({ name: "large.png", mimeType: "image/png", base64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") })).toThrow();
});
it("normalizes images to stable scoped references and never puts image bytes in history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-remote-image-"));
  try {
    const path = join(directory, "one.png"); await writeFile(path, Buffer.from(pngBase64, "base64"));
    const images = new ImageRegistry();
    const raw = { id: "turn", items: [{ id: "user", type: "userMessage", content: [{ type: "localImage", path }, { type: "image", url: `data:image/png;base64,${pngBase64}` }] }, { id: "answer", type: "agentMessage", text: `![Screenshot](${path.replaceAll("\\", "/")})` }] };
    const turn = normalizeHistoryTurn(raw, images, "thread-a");
    expect(jsonBytes(turn)).toBeLessThan(2000);
    expect(JSON.stringify(turn)).not.toContain(pngBase64);
    const refs = turn.items[0]!.images!;
    expect(refs).toHaveLength(2);
    expect(await images.read("thread-a", refs[0]!.id)).toMatchObject({ base64: pngBase64, mimeType: "image/png" });
    await expect(images.read("thread-b", refs[0]!.id)).rejects.toThrow("image-not-in-thread");
    await expect(images.read("thread-a", "a".repeat(64))).rejects.toThrow("image-not-in-thread");
    expect(normalizeHistoryTurn(raw, images, "thread-a").items[0]?.images).toEqual(refs);
    expect(turn.items[1]?.images?.[0]?.source).toBe(path.replaceAll("\\", "/"));
    expect(images.references("thread-a", { content: [{ type: "image", url: "http://169.254.169.254/secrets.png" }] })).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("supports image-only turns while retaining empty input and attachment limit validation", () => {
  expect(commandSchema.safeParse(command({ type: "turn.start", threadId: "thread", text: "", images: ["a".repeat(64)] })).success).toBe(true);
  expect(commandSchema.safeParse(command({ type: "turn.start", threadId: "thread", text: " " })).success).toBe(false);
  expect(commandSchema.safeParse(command({ type: "turn.start", threadId: "thread", text: "", images: Array(5).fill("a".repeat(64)) })).success).toBe(false);
});
