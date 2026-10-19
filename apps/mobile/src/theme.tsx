import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { controlTheme } from '../../../packages/client-shared/src/themes';
import type { ControlTheme, ThemeId } from '../../../packages/client-shared/src/themes';
import { readTheme, saveTheme } from './theme-storage';
import { applyTheme } from './theme-platform';

type ThemeState = { theme: ControlTheme; selectTheme: (id: ThemeId) => void; persistenceError: string };
const defaultState: ThemeState = { theme: controlTheme('default'), selectTheme: () => {}, persistenceError: '' };
const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(ThemeContext);
  return inherited ? children : <RootThemeProvider>{children}</RootThemeProvider>;
}

function RootThemeProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => readTheme());
  const [id, setId] = useState<ThemeId>(() => typeof initial === 'string' ? initial : 'default');
  const [persistenceError, setError] = useState('');
  const revision = useRef(0), writes = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    void Promise.resolve(initial).then(value => { if (active && !revision.current) setId(value); });
    return () => { active = false; };
  }, [initial]);
  const theme = controlTheme(id);
  useLayoutEffect(() => applyTheme(theme), [theme]);
  const value = useMemo<ThemeState>(() => ({ theme, persistenceError, selectTheme(next) {
    const current = ++revision.current;
    setId(next); setError('');
    // Serialize native writes so quick successive choices cannot persist an older skin last.
    writes.current = writes.current.catch(() => {}).then(() => saveTheme(next)).catch(() => {
      if (revision.current === current) setError('皮肤已切换，但偏好未能保存。请重试。');
    });
  } }), [theme, persistenceError]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useControlTheme() { return useContext(ThemeContext) ?? defaultState; }
export function themedStyles<T>(factory: (colors: ControlTheme['colors']) => T): () => T {
  const cache = new Map<ThemeId, T>();
  return function useThemedStyles() {
    const { theme } = useControlTheme();
    if (!cache.has(theme.id)) cache.set(theme.id, factory(theme.colors));
    return cache.get(theme.id)!;
  };
}
