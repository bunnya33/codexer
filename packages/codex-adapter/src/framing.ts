export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > this.maxBytes) throw new Error("invalid-ipc-frame-length");
      if (this.buffer.length < length + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }
}
export function encodeFrame(message: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(bytes.length + 4);
  frame.writeUInt32LE(bytes.length);
  bytes.copy(frame, 4);
  return frame;
}
