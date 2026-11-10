import * as DocumentPicker from 'expo-document-picker';
import { attachmentFromFile } from './attachment-picker.web';
import { imageAsset } from './image-file.web';
import { isVideoAttachment } from '../../../packages/protocol/src/uploads';
import type { MediaPickerOptions, MediaSelection } from './media-picker.types';

export async function pickMedia({ imageSlots, videoSlots }: MediaPickerOptions): Promise<MediaSelection> {
  const type = [...(imageSlots ? ['image/*'] : []), ...(videoSlots ? ['video/*'] : [])];
  if (!type.length) return { images: [], videos: [] };
  // Read photos only. Videos remain Files and are uploaded in bounded chunks.
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, base64: false, type });
  if (result.canceled) return { images: [], videos: [] };
  const files = result.assets.map(asset => { if (!asset.file) throw new Error('无法读取所选附件'); return asset.file; });
  return { images: await Promise.all(files.filter(file => imageSlots > 0 && file.type.startsWith('image/')).map(imageAsset)),
    videos: files.filter(file => videoSlots > 0 && isVideoAttachment({ name: file.name, mimeType: file.type })).map(attachmentFromFile) };
}
