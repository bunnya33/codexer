import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

export type AttachmentAsset = { name: string; size: number; mimeType: string; readChunk: (offset: number, length: number) => Promise<string> };
export async function pickAttachments(): Promise<AttachmentAsset[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return Promise.all(result.assets.map(async asset => {
    const info = asset.size === undefined ? await FileSystem.getInfoAsync(asset.uri) : null;
    const size = asset.size ?? (info?.exists && 'size' in info ? info.size : undefined);
    if (size === undefined) throw new Error('无法读取文件大小');
    return { name: asset.name, size, mimeType: asset.mimeType ?? 'application/octet-stream',
      readChunk: (position: number, length: number) => FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64, position, length }) };
  }));
}
