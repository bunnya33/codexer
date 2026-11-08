import { useEffect } from 'react';
import type { RefObject } from 'react';
import { BackHandler } from 'react-native';
import type { View } from 'react-native';

export function useSurfaceAccessibility(open: boolean, _panel: RefObject<View | null>, close: () => void, _focusKey?: string) {
  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    return () => subscription.remove();
  }, [open, close]);
}
