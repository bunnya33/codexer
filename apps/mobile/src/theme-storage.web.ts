import { themeId } from '../../../packages/client-shared/src/themes';
import type { ThemeId } from '../../../packages/client-shared/src/themes';
import { appearancePreferences } from '../../../packages/client-shared/src/appearance';
import type { AppearancePreferences } from '../../../packages/client-shared/src/appearance';

export const themeStorageKey = 'codexer.control.theme.v1';
export function readTheme(): ThemeId {
  try { return themeId(localStorage.getItem(themeStorageKey)); } catch { return 'default'; }
}
export async function saveTheme(value: ThemeId): Promise<void> { localStorage.setItem(themeStorageKey, value); }
export function readAppearance(): AppearancePreferences {
  try { return appearancePreferences(JSON.parse(localStorage.getItem('codexer.control.appearance.v2') ?? 'null'),localStorage.getItem(themeStorageKey)); }
  catch { return appearancePreferences(null,readTheme()); }
}
export async function saveAppearance(value: AppearancePreferences): Promise<void> { localStorage.setItem('codexer.control.appearance.v2',JSON.stringify(value)); }
