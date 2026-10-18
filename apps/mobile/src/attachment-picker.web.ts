import * as DocumentPicker from 'expo-document-picker';
import type { AttachmentAsset } from './attachment-picker';

export async function pickAttachments(): Promise<AttachmentAsset[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, base64: false });
  if (result.canceled) return [];
  return result.assets.map(asset => {
    const file = asset.file;
    if (!file) throw new Error('无法读取文件');
    return { name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream',
      readChunk: (offset, length) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取文件'));
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(file.slice(offset, offset + length));
      }) };
  });
}
