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
export function DrawerSwipeBlock({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const block = useContext(DrawerSwipeBlockContext);
  return <View {...(Platform.OS === 'web' ? { dataSet: { drawerSwipe: 'ignore' } } : {})} onTouchStart={() => block?.()} style={style}>{children}</View>;
}
