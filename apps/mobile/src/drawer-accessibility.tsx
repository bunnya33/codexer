import type { ReactNode } from 'react';
import { View } from 'react-native';

export function DrawerAccessibility({ active, children }: { active: boolean; children: ReactNode }) {
  return <View style={{ flex: 1 }} pointerEvents={active ? 'auto' : 'none'} accessibilityElementsHidden={!active}
    importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}>{children}</View>;
}
