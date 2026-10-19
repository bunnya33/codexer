import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { ScrollDirection } from '../../../packages/client-shared/src/conversation-scroll';

export function ConversationViewport({children}: {children: ReactNode; onScrollIntent: (direction: ScrollDirection) => void}) {
  return <View style={{flex: 1}}>{children}</View>;
}
