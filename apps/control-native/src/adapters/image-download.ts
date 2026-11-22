import type { ImagePreview } from '../../../../packages/client-shared/src/images';
import { readConversationImage } from '../../../mobile/src/image-download-source';
import { request } from '../bridge';
import { randomId } from './runtime';

export async function saveConversationImage(image: ImagePreview, signal: AbortSignal): Promise<string | undefined> {
  const { name, bytes, source } = await readConversationImage(image, signal);
  const id = randomId();
  const abort = () => { void request('download.cancel', { id }).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const saved = await request<boolean>('download', { id, ...source, name, size: bytes.length });
    if (saved) return '图片已保存。';
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
