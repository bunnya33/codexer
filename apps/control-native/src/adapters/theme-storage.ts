import { themeId } from '../../../../packages/client-shared/src/themes';
import type { ThemeId } from '../../../../packages/client-shared/src/themes';
import { request } from '../bridge';
import { appearancePreferences } from '../../../../packages/client-shared/src/appearance';
import type { AppearancePreferences } from '../../../../packages/client-shared/src/appearance';

export async function readTheme(): Promise<ThemeId> {
  try { return themeId(await request('storage.read', { key: 'control-theme' })); } catch { return 'default'; }
}
export async function saveTheme(value: ThemeId): Promise<void> {
  await request('storage.write', { key: 'control-theme', value });
}
export async function readAppearance(): Promise<AppearancePreferences> {
  try {
    const value = await request('storage.read', { key: 'control-appearance-v2' });
    if (value) return appearancePreferences(JSON.parse(String(value)));
  } catch { /* Fall back to the existing local preference. */ }
  return appearancePreferences(null,await readTheme());
}
export async function saveAppearance(value: AppearancePreferences): Promise<void> {
  await request('storage.write',{key:'control-appearance-v2',value:JSON.stringify(value)});
}
