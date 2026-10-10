import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import type { WidgetState } from '../../../packages/client-shared/src/previews';
export type PreviewSnapshot = { state: WidgetState | null; tweaks: Record<string, string | number | boolean> };
async function uri(key: string) {
  const directory = FileSystem.documentDirectory + 'previews/';
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  return directory + await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key) + '.json';
}
export async function readPreviewState(key: string): Promise<PreviewSnapshot | null> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(await uri(key))) as PreviewSnapshot; } catch { return null; }
}
export async function savePreviewState(key: string, value: PreviewSnapshot): Promise<void> {
  const serialized = JSON.stringify(value); if (serialized.length > 24000) throw new Error('预览状态过大');
  await FileSystem.writeAsStringAsync(await uri(key), serialized);
}
