import { useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { MessageTextRun } from '../../../packages/client-shared/src/message-text';
import { DrawerSwipeBlock, useDrawerSelection } from './drawer-swipe-block';
import { NativeMessageText } from './message-native';
import type { NativeMessageProps } from './message-native-types';
import { useTheme } from './styles';

export function SelectableNativeMessage({ onSelection, ...props }: NativeMessageProps) {
  const protectSelection = useDrawerSelection();
  if (!NativeMessageText) return null;
  return <DrawerSwipeBlock><NativeMessageText {...props} onSelection={event => {
    protectSelection(event.nativeEvent.active);
    onSelection?.(event);
  }} /></DrawerSwipeBlock>;
}

/** Rich replies keep their existing blocks; each text block selects in place. */
export function ReplyTextBlock({ runs, style, onLink, onCopied, onSelection, minWidth, maxWidth, code }: {
  runs: MessageTextRun[]; style?: StyleProp<ViewStyle>; onLink?: (href: string) => void;
  onCopied?: () => void; onSelection?: (active: boolean) => void;
  minWidth?: number; maxWidth?: number; code?: boolean;
}) {
  const { c } = useTheme();
  const [size, setSize] = useState({ height: code ? 18 : 26, naturalWidth: 0 });
  return <DrawerSwipeBlock style={[style, minWidth !== undefined && {
    width: Math.max(minWidth, Math.min(maxWidth ?? Infinity, size.naturalWidth)),
  }]}>
    <SelectableNativeMessage runs={runs} textColor={c.text} linkColor={c.accent} codeBlock={code}
      onContentHeight={event => setSize(event.nativeEvent)} style={{ height: size.height, alignSelf: 'stretch' }}
      onSelection={event => onSelection?.(event.nativeEvent.active)}
      onAction={event => {
        const { action, href } = event.nativeEvent;
        if (action === 'link' && href) onLink?.(href);
        else if (action === 'copied') onCopied?.();
      }} />
  </DrawerSwipeBlock>;
}
