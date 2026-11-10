import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { MediaPickerOptions, MediaSelection } from './media-picker.types';

/** Photos keep the image upload path; videos keep their original bytes. */
export async function pickMedia({ imageSlots, videoSlots }: MediaPickerOptions): Promise<MediaSelection> {
  const mediaTypes: ImagePicker.MediaType[] = [...(imageSlots ? ['images' as const] : []), ...(videoSlots ? ['videos' as const] : [])];
  if (!mediaTypes.length) return { images: [], videos: [] };
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes, allowsMultipleSelection: true, selectionLimit: imageSlots + videoSlots, base64: true, quality: .85 });
  if (result.canceled) return { images: [], videos: [] };
  const images = result.assets.filter(asset => asset.type !== 'video');
  const videos = await Promise.all(result.assets.filter(asset => asset.type === 'video').map(async asset => {
    const info = asset.fileSize === undefined ? await FileSystem.getInfoAsync(asset.uri) : null;
    const size = asset.fileSize ?? (info?.exists && 'size' in info ? info.size : undefined);
    if (size === undefined) throw new Error('无法读取视频大小');
    return { name: asset.fileName ?? asset.uri.split('/').at(-1) ?? 'video.mp4', size, mimeType: asset.mimeType ?? 'application/octet-stream',
      readChunk: (position: number, length: number) => FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64, position, length }) };
  }));
  return { images, videos };
}
