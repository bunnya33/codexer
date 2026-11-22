import type { ImagePreview } from '../../../packages/client-shared/src/images';
import { readConversationImage } from './image-download-source';
import { saveBrowserFile } from './file-download.web';

export async function saveConversationImage(image: ImagePreview, signal: AbortSignal): Promise<string> {
  const { name, mimeType, bytes } = await readConversationImage(image, signal);
  saveBrowserFile(new Blob([bytes], { type: mimeType }), name);
  return '图片已交给浏览器保存。';
}
