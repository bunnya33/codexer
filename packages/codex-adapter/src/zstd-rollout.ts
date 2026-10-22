import type { FileHandle } from 'node:fs/promises';

// Node's Zstandard decoder can end successfully on a truncated final frame.
// Check frame/block boundaries before accepting persisted permission settings;
// the native decoder still validates the compressed data and any checksums.
export async function validateZstdRollout(file: FileHandle): Promise<void> {
  const { size } = await file.stat();
  let offset = 0;
  const bytes = Buffer.alloc(4);
  const read = async (length: number) => {
    const result = await file.read(bytes, 0, length, offset);
    if (result.bytesRead !== length) throw new Error('incomplete-zstd-rollout');
    offset += length;
    return bytes.readUIntLE(0, length);
  };
  const skip = (length: number) => {
    offset += length;
    if (offset > size) throw new Error('incomplete-zstd-rollout');
  };
  if (!size) throw new Error('empty-zstd-rollout');
  while (offset < size) {
    const magic = await read(4);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      skip(await read(4));
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error('invalid-zstd-rollout');
    const descriptor = await read(1);
    if (descriptor & 8) throw new Error('invalid-zstd-rollout');
    const singleSegment = !!(descriptor & 32);
    const sizeFlag = descriptor >>> 6;
    skip((singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]! + (sizeFlag ? [0, 2, 4, 8][sizeFlag]! : singleSegment ? 1 : 0));
    let last = false;
    while (!last) {
      const block = await read(3);
      last = !!(block & 1);
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error('invalid-zstd-rollout');
      skip(type === 1 ? 1 : block >>> 3);
    }
    if (descriptor & 4) skip(4);
  }
}
