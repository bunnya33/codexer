import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

/** Stop decorative motion when the app is hidden or the system requests it. */
export function useInteractionMotion() {
  const [reduced, setReduced] = useState(true);
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useEffect(() => {
    let mounted = true, changed = false;
    const preference = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { changed = true; setReduced(value); });
    const state = AppState.addEventListener('change', value => setActive(value === 'active'));
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted && !changed) setReduced(value); }).catch(() => {});
    return () => { mounted = false; preference.remove(); state.remove(); };
  }, []);
  return active && !reduced;
}
