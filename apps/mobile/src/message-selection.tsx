import { useCallback, useState } from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { MessageTextRun } from '../../../packages/client-shared/src/message-text';
import { DrawerSwipeBlock, useDrawerSelection } from './drawer-swipe-block';
import { NativeMessageText } from './message-native';
import type { NativeMessageProps } from './message-native-types';
import { useTheme } from './styles';
import { useSelectionDismissal } from './message-selection-area';

export function SelectableNativeMessage({ onSelection, ...props }: NativeMessageProps) {
  const protectSelection = useDrawerSelection();
  const [dismissSelectionRequest, setDismissSelectionRequest] = useState(0);
  const dismiss = useCallback(() => setDismissSelectionRequest(value => value + 1), []);
  const dismissal = useSelectionDismissal(dismiss);
  if (!NativeMessageText) return null;
  return <DrawerSwipeBlock selectableText onTouchStart={dismissal.markTouch}><NativeMessageText {...props} dismissSelectionRequest={dismissSelectionRequest} onSelection={event => {
    dismissal.setActive(event.nativeEvent.active);
    protectSelection(event.nativeEvent.active);
    onSelection?.(event);
  }} /></DrawerSwipeBlock>;
}

/** Rich replies keep their existing blocks; each text block selects in place. */
export function ReplyTextBlock({ runs, style, onLink, onCopied, onSelection, minWidth, onNaturalWidth, code }: {
  runs: MessageTextRun[]; style?: StyleProp<ViewStyle>; onLink?: (href: string) => void;
  onCopied?: () => void; onSelection?: (active: boolean) => void;
  minWidth?: number; onNaturalWidth?: (width: number) => void; code?: boolean;
}) {
  const { c } = useTheme();
  const [size, setSize] = useState({ height: code ? 18 : 26, naturalWidth: 0 });
  return <View style={[style, minWidth !== undefined && {
    width: Math.max(minWidth, size.naturalWidth),
  }]}>
    <SelectableNativeMessage runs={runs} textColor={c.text} linkColor={c.accent} codeBlock={code}
      onContentHeight={event => {
        setSize(event.nativeEvent);
        onNaturalWidth?.(event.nativeEvent.naturalWidth);
      }} style={{ height: size.height, alignSelf: 'stretch' }}
      onSelection={event => onSelection?.(event.nativeEvent.active)}
      onAction={event => {
        const { action, href } = event.nativeEvent;
        if (action === 'link' && href) onLink?.(href);
        else if (action === 'copied') onCopied?.();
      }} />
  </View>;
}
