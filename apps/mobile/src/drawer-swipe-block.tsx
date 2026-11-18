import { useCallback, useContext, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { DrawerSelectionContext, DrawerSwipeBlockContext } from './drawer-context';

export function useDrawerSelection() {
  const select = useContext(DrawerSelectionContext);
  const [owner] = useState(() => Symbol());
  useLayoutEffect(() => () => select?.(owner, false), [select, owner]);
  return useCallback((active: boolean) => select?.(owner, active), [select, owner]);
}

/** Nested controls own their horizontal gestures, including code/table scrolling. */
export function DrawerSwipeBlock({ children, style, onTouchStart, selectableText }: { children: ReactNode; style?: StyleProp<ViewStyle>; onTouchStart?: () => void; selectableText?: boolean }) {
  const block = useContext(DrawerSwipeBlockContext);
  return <View {...(Platform.OS === 'web' ? { dataSet: { drawerSwipe: 'ignore' } } : {})} onTouchStart={() => { block?.(selectableText); onTouchStart?.(); }} style={style}>{children}</View>;
}
