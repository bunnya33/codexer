import { request } from '../bridge';
import type { PickedFile } from './attachment-picker';
import type { MediaPickerOptions, MediaSelection } from '../../../mobile/src/media-picker.types';
import { isVideoAttachment } from '../../../../packages/protocol/src/uploads';

export async function pickMedia({ imageSlots, videoSlots }: MediaPickerOptions): Promise<MediaSelection> {
  if (!imageSlots && !videoSlots) return { images: [], videos: [] };
  const files = await request<PickedFile[]>('pick', { kind: imageSlots && !videoSlots ? 'images' : 'files' });
  const images = await Promise.all(files.filter(file => imageSlots > 0 && (file.mimeType.startsWith('image/') || /\.(heic|heif|avif|bmp|tiff?)$/i.test(file.name))).map(async file => {
    const converted = await request<{ base64: string; width: number; height: number }>('image.convert', { path: file.path, edge: 1600, quality: .85 });
    return { ...converted, uri: file.uri, fileName: file.name.replace(/\.[^.]+$/, '.jpg'), mimeType: 'image/jpeg' };
  }));
  const videos = files.filter(file => videoSlots > 0 && isVideoAttachment({ name: file.name, mimeType: file.mimeType })).map(file => ({ ...file,
    readChunk: (position: number, length: number) => request<string>('readChunk', { path: file.path, position, length }) }));
  if (files.length && !images.length && !videos.length) throw new Error('请选择图片或视频，其他附件请使用“文件”');
  return { images, videos };
}
