import { useContext } from 'react';
import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { DrawerSwipeBlockContext } from './drawer-context';

/** Nested controls own their horizontal gestures, including code/table scrolling. */
export function DrawerSwipeBlock({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const block = useContext(DrawerSwipeBlockContext);
  return <View {...(Platform.OS === 'web' ? { dataSet: { drawerSwipe: 'ignore' } } : {})} onTouchStart={() => block?.()} style={style}>{children}</View>;
}
