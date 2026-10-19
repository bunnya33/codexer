import { themeId } from '../../../../packages/client-shared/src/themes';
import type { ThemeId } from '../../../../packages/client-shared/src/themes';
import { request } from '../bridge';

export async function readTheme(): Promise<ThemeId> {
  try { return themeId(await request('storage.read', { key: 'control-theme' })); } catch { return 'default'; }
}
export async function saveTheme(value: ThemeId): Promise<void> {
  await request('storage.write', { key: 'control-theme', value });
}
