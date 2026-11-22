import type { ImagePreview } from '../../../packages/client-shared/src/images';
import { MAX_IMAGE_BYTES } from '../../../packages/protocol/src/index';
import { fileResponse } from './file-transfer';

export async function readConversationImage(image: ImagePreview, signal: AbortSignal) {
  const { uri, headers } = image.source;
  if (!headers) throw new Error('image-unavailable');
  const response = await fileResponse({ uri, headers }, signal);
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mimeType ?? ''];
  if (!extension || !mimeType) throw new Error('invalid-image-response');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (signal.aborted) throw new Error('file-cancelled');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('invalid-image-response');

  const stem = (image.name.split(/[/\\]/).pop() ?? '').replace(/\.[^.]+$/, '')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().replace(/^\.+|[. ]+$/g, '').slice(0, 90);
  return { name: `${stem || '图片'}.${extension}`, mimeType, bytes, source: { uri, headers } };
}

export function imageSaveError(error: unknown): string {
  if (error instanceof TypeError) return '连接服务器失败，请检查网络后重试。';
  switch (error instanceof Error ? error.message : '') {
    case 'unauthorized': case 'HTTP 401': return '登录已失效，请重新登录。';
    case 'device-offline': return '电脑已离线，请连接后再保存图片。';
    case 'image-timeout': return '获取图片超时，请检查电脑连接后重试。';
    case 'image-not-in-thread': case 'image-unavailable': return '这张图片已不可用，请刷新会话后重试。';
    case 'invalid-image-response': return '服务器返回的图片无效，请重试。';
    case 'image-sharing-unavailable': return '当前设备无法打开系统分享菜单。';
    case 'image-storage-unavailable': return '无法写入保存位置，请选择其他文件夹后重试。';
    default: return '保存图片失败，请重试。';
  }
}
