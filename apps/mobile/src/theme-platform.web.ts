import type { ControlTheme } from '../../../packages/client-shared/src/themes';
import './theme.web.css';
export function applyTheme(theme: ControlTheme): void {
  const root = document.documentElement;
  root.dataset.controlTheme = theme.id;
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  for (const [name, value] of Object.entries(theme.colors)) root.style.setProperty('--control-' + name, value);
}
