import { useRef } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { ScrollDirection } from '../../../packages/client-shared/src/conversation-scroll';

export function ConversationViewport({children, onScrollIntent}: {children: ReactNode; onScrollIntent: (direction: ScrollDirection) => void}) {
  const touch = useRef({ x: 0, y: 0 });
  return <View style={{flex: 1}}
    onStartShouldSetResponderCapture={event => {
      touch.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
      return false;
    }}
    onMoveShouldSetResponderCapture={event => {
      const { pageX: x, pageY: y, touches } = event.nativeEvent;
      const dx = x - touch.current.x, dy = y - touch.current.y;
      if (touches.length === 1 && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) {
        onScrollIntent(dy > 0 ? 'up' : 'down');
        touch.current = { x, y };
      }
      // Observe direction before scroll callbacks without taking the gesture
      // away from the native list or its nested controls.
      return false;
    }}>{children}</View>;
}
