import type { ReactNode } from 'react';
import { View } from 'react-native';

export function ConversationViewport({children}: {children: ReactNode; onScrollIntent: () => void}) {
  return <View style={{flex: 1}}>{children}</View>;
}
