import { themeId } from '../../../packages/client-shared/src/themes';
import type { ThemeId } from '../../../packages/client-shared/src/themes';

export const themeStorageKey = 'codexer.control.theme.v1';
export function readTheme(): ThemeId {
  try { return themeId(localStorage.getItem(themeStorageKey)); } catch { return 'default'; }
}
export async function saveTheme(value: ThemeId): Promise<void> { localStorage.setItem(themeStorageKey, value); }
