import { useLayoutEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { themedStyles } from '../../../mobile/src/theme';
import { useModalDimensions } from './modal';

export function ComposerPopover({ anchor, open, onClose, onDismiss, width = 320, align = 'end', children }: {
  anchor: RefObject<View | null>; open: boolean; onClose: () => void; onDismiss?: () => void; width?: number; align?: 'start' | 'end'; children: ReactNode;
}) {
  const styles = useLocalStyles();
  const viewport = useModalDimensions();
  const [position, setPosition] = useState<{ x: number; y: number; width: number } | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    anchor.current?.measureInWindow((x, y, measuredWidth) => setPosition({ x, y, width: measuredWidth }));
  }, [anchor, open, viewport.width, viewport.height]);
  const panelWidth = Math.min(width, viewport.width - 24);
  const left = Math.max(12, Math.min(viewport.width - panelWidth - 12, (position?.x ?? 12) + (align === 'end' ? (position?.width ?? panelWidth) - panelWidth : 0)));
  return <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} onDismiss={onDismiss}>
    <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭菜单" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View accessibilityViewIsModal onLayout={event => setPanelHeight(event.nativeEvent.layout.height)} style={[styles.panel, {
        width: panelWidth, maxHeight: Math.max(120, (position?.y ?? viewport.height) - 24), left,
        top: Math.max(12, Math.min(viewport.height - panelHeight - 12, (position?.y ?? viewport.height) - panelHeight - 8)), opacity: position && panelHeight ? 1 : 0,
      }]}>{children}</View>
    </View>
  </Modal>;
}

const useLocalStyles = themedStyles(c => StyleSheet.create({
  overlay: { flex: 1 },
  panel: { position: 'absolute', backgroundColor: c.surface, borderWidth: 1, borderColor: c.glassBorder, borderRadius: 20, padding: 10,
    shadowColor: c.shadow, shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.12, shadowRadius: 20, elevation: 10, overflow: 'hidden' },
}));
