import * as FileSystem from 'expo-file-system/legacy';
import { themeId } from '../../../packages/client-shared/src/themes';
import type { ThemeId } from '../../../packages/client-shared/src/themes';
import { appearancePreferences } from '../../../packages/client-shared/src/appearance';
import type { AppearancePreferences } from '../../../packages/client-shared/src/appearance';

const uri = () => FileSystem.documentDirectory + 'control-theme.txt';
export async function readTheme(): Promise<ThemeId> {
  try { return themeId(await FileSystem.readAsStringAsync(uri())); } catch { return 'default'; }
}
export async function saveTheme(value: ThemeId): Promise<void> { await FileSystem.writeAsStringAsync(uri(), value); }
export async function readAppearance(): Promise<AppearancePreferences> {
  try { return appearancePreferences(JSON.parse(await FileSystem.readAsStringAsync(FileSystem.documentDirectory+'control-appearance-v2.json'))); }
  catch { try { return appearancePreferences(null,await FileSystem.readAsStringAsync(uri())); } catch { return appearancePreferences(null); } }
}
export async function saveAppearance(value: AppearancePreferences): Promise<void> { await FileSystem.writeAsStringAsync(FileSystem.documentDirectory+'control-appearance-v2.json',JSON.stringify(value)); }
