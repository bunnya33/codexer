import type { ControlTheme } from '../../../../packages/client-shared/src/themes';
import { boot, request } from '../bridge';
export function applyTheme(theme: ControlTheme): void {
  if (boot.mode === 'control') void request('window.theme', { id: theme.id }).catch(() => {});
}
