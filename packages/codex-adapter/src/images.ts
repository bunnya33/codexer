import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { MAX_IMAGE_BYTES } from "../../protocol/src/index.js";
import type { ImagePayload, ImageRef } from "../../protocol/src/index.js";
import { decodeImage, imageMime } from "../../shared/src/images.js";
import { record } from "./normalize.js";

type Source = { threadId: string; value: string; data: boolean; name: string };
const markdown = new MarkdownIt({ html: false });
markdown.validateLink = () => true;
// Only sources observed in official message/image items can acquire an opaque ID.
export class ImageRegistry {
  private readonly sources = new Map<string, Source>();
  private sourceBytes = 0;
  references(threadId: string, value: unknown): ImageRef[] {
    const item = record(value);
    const parts = Array.isArray(item.content) ? item.content : Array.isArray(item.input) ? item.input : [];
    const candidates = parts.flatMap(value => {
      const part = record(value);
      return part.type === "localImage" && typeof part.path === "string" ? [part.path] : part.type === "image" && typeof part.url === "string" ? [part.url] : [];
    });
    const inline = new Set<string>();
    if (item.type === "agentMessage" && typeof item.text === "string") {
      for (const token of markdown.parse(item.text, {})) for (const child of token.children ?? []) {
        const src = child.type === "image" ? child.attrGet("src") : null;
        if (typeof src === "string" && src.length <= 4096) { candidates.push(src); inline.add(src); }
      }
    }
    if (item.type === "imageView" && typeof item.path === "string") candidates.push(item.path);
    if (item.type === "imageGeneration") {
      if (typeof item.savedPath === "string") candidates.push(item.savedPath);
      else if (typeof item.result === "string" && item.result.length) candidates.push(item.result.startsWith("data:") ? item.result : `data:image/png;base64,${item.result}`);
    }
    return [...new Set(candidates)].slice(0, 8).flatMap(value => {
      let path = value;
      if (path.startsWith("file://")) { try { path = fileURLToPath(path); } catch { return []; } }
      const data = /^data:image\/(png|jpeg|webp|gif);base64,/.test(path);
      if (!data && !isAbsolute(path)) return [];
      if (data && path.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) return [];
      const id = createHash("sha256").update(threadId).update("\0").update(path).digest("hex");
      const name = data ? "image" : basename(path).slice(0, 255);
      const previous = this.sources.get(id);
      if (previous) { this.sourceBytes -= previous.value.length * 2; this.sources.delete(id); }
      while (this.sources.size && (this.sources.size >= 10000 || this.sourceBytes + path.length * 2 > 64 * 1024 * 1024)) {
        const [oldId, oldSource] = this.sources.entries().next().value!;
        this.sources.delete(oldId); this.sourceBytes -= oldSource.value.length * 2;
      }
      this.sources.set(id, { threadId, value: path, data, name });
      this.sourceBytes += path.length * 2;
      return [{ id, name, ...(inline.has(value) ? { source: value } : {}) }];
    });
  }
  async read(threadId: string, id: string): Promise<ImagePayload> {
    const source = this.sources.get(id);
    if (!source || source.threadId !== threadId) throw new Error("image-not-in-thread");
    if (source.data) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/.exec(source.value)!;
      return decodeImage({ name: source.name, mimeType: match[1], base64: match[2] }).image;
    }
    const file = await open(source.value, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("image-too-large");
      const bytes = Buffer.alloc(info.size);
      const result = await file.read(bytes, 0, bytes.length, 0);
      const mimeType = imageMime(bytes);
      if (result.bytesRead !== bytes.length || !mimeType) throw new Error("invalid-image");
      return { name: source.name, mimeType, base64: bytes.toString("base64") };
    } finally { await file.close(); }
  }
}
