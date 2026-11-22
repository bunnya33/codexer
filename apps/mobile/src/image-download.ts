import { File } from 'expo-file-system';
import { cacheDirectory, deleteAsync, EncodingType, makeDirectoryAsync, StorageAccessFramework } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import type { ImagePreview } from '../../../packages/client-shared/src/images';
import { readConversationImage } from './image-download-source';
import { randomId } from './runtime';

export async function saveConversationImage(image: ImagePreview, signal: AbortSignal): Promise<string | undefined> {
  const { name, mimeType, bytes } = await readConversationImage(image, signal);
  const folder = Platform.OS === 'android' ? await StorageAccessFramework.requestDirectoryPermissionsAsync() : undefined;
  if (signal.aborted) return;
  if (folder && !folder.granted) return;
  if (!cacheDirectory) throw new Error('image-storage-unavailable');
  const temporary = `${cacheDirectory}image-export-${randomId()}/`;
  await makeDirectoryAsync(temporary, { intermediates: true });
  try {
    const file = new File(temporary, name);
    file.create();
    file.write(bytes);
    if (!folder) {
      if (!(await Sharing.isAvailableAsync())) throw new Error('image-sharing-unavailable');
      if (signal.aborted) return;
      await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: '保存图片' });
      return;
    }

    const base64 = await file.base64();
    if (signal.aborted) return;
    let target: string | undefined;
    try {
      target = await StorageAccessFramework.createFileAsync(folder.directoryUri, name.slice(0, name.lastIndexOf('.')), mimeType);
      if (signal.aborted) throw new Error('file-cancelled');
      await StorageAccessFramework.writeAsStringAsync(target, base64, { encoding: EncodingType.Base64 });
      return '图片已保存到所选文件夹。';
    } catch {
      if (target) await StorageAccessFramework.deleteAsync(target, { idempotent: true }).catch(() => {});
      throw new Error('image-storage-unavailable');
    }
  } finally {
    await deleteAsync(temporary, { idempotent: true }).catch(() => {});
  }
}
