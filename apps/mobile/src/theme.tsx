import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { controlTheme } from '../../../packages/client-shared/src/themes';
import type { ControlTheme, ThemeId } from '../../../packages/client-shared/src/themes';
import { readAppearance, saveAppearance } from './theme-storage';
import { Appearance } from 'react-native';
import { defaultAppearance, appearanceForSkin, resolveAppearance } from '../../../packages/client-shared/src/appearance';
import type { AppearancePreferences } from '../../../packages/client-shared/src/appearance';
import { applyTheme } from './theme-platform';

type ThemeState = { theme: ControlTheme; selectTheme: (id: ThemeId) => void; preferences: AppearancePreferences; setPreferences: (value: AppearancePreferences) => void; persistenceError: string };
const defaultState: ThemeState = { theme: controlTheme('default'), selectTheme: () => {}, preferences: defaultAppearance, setPreferences: () => {}, persistenceError: '' };
const ThemeContext = createContext<ThemeState | null>(null);

/** An ephemeral theme for component previews; never writes the user's preferences. */
export function ThemeScope({ theme, children }: { theme: ControlTheme; children: ReactNode }) {
  const value = useMemo<ThemeState>(() => ({ theme, selectTheme: () => {}, preferences: defaultAppearance, setPreferences: () => {}, persistenceError: '' }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(ThemeContext);
  return inherited ? children : <RootThemeProvider>{children}</RootThemeProvider>;
}

function RootThemeProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => readAppearance());
  const [preferences, setValue] = useState<AppearancePreferences>(() => initial instanceof Promise ? defaultAppearance : initial);
  const [system, setSystem] = useState(() => Appearance?.getColorScheme?.() ?? null);
  const [persistenceError, setError] = useState('');
  const revision = useRef(0), writes = useRef(Promise.resolve());
  useEffect(() => {
    const listener = Appearance?.addChangeListener?.(event => setSystem(event.colorScheme));
    return () => listener?.remove();
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve(initial).then(value => { if (active && !revision.current) setValue(value); });
    return () => { active = false; };
  }, [initial]);
  const theme = useMemo(() => resolveAppearance(preferences,system),[preferences,system]);
  useLayoutEffect(() => applyTheme(theme), [theme]);
  const value = useMemo<ThemeState>(() => {
    const setPreferences = (next: AppearancePreferences) => {
      const current = ++revision.current;
      setValue(next); setError('');
      writes.current = writes.current.catch(() => {}).then(() => saveAppearance(next)).catch(() => {
        if (revision.current === current) setError('外观已切换，但偏好未能保存。请重试。');
      });
    };
    return { theme, preferences, persistenceError, setPreferences, selectTheme: next => setPreferences(appearanceForSkin(next)) };
  }, [theme, preferences, persistenceError]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useControlTheme() { return useContext(ThemeContext) ?? defaultState; }
export function themedStyles<T>(factory: (colors: ControlTheme['colors']) => T): () => T {
  const cache = new WeakMap<ControlTheme, T>();
  return function useThemedStyles() {
    const { theme } = useControlTheme();
    if (!cache.has(theme)) cache.set(theme, factory(theme.colors));
    return cache.get(theme)!;
  };
}
