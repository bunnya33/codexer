import { randomId } from './runtime';
export function previewClientId() {
  try {
    const key = 'codexer.preview.tab.v1';
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const previous = sessionStorage.getItem(key);
    // Reloads recover the same tab's abandoned preview; a new/duplicated tab
    // receives its own owner and cannot replace another tab's active preview.
    const id = previous && navigation?.type !== 'navigate' ? previous : randomId();
    sessionStorage.setItem(key, id);
    return id;
  } catch { return randomId(); }
}
