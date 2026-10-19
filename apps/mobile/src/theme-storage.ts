import * as FileSystem from 'expo-file-system/legacy';
import { themeId } from '../../../packages/client-shared/src/themes';
import type { ThemeId } from '../../../packages/client-shared/src/themes';

const uri = () => FileSystem.documentDirectory + 'control-theme.txt';
export async function readTheme(): Promise<ThemeId> {
  try { return themeId(await FileSystem.readAsStringAsync(uri())); } catch { return 'default'; }
}
export async function saveTheme(value: ThemeId): Promise<void> { await FileSystem.writeAsStringAsync(uri(), value); }
