import { themedStyles } from './theme';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Keyboard, Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { popoverLayout } from './popover-layout';


export function ComposerPopover({ anchor, open, onClose, onDismiss, width = 320, align = 'end', children }: {
  anchor: RefObject<View | null>; open: boolean; onClose: () => void; onDismiss?: () => void; width?: number; align?: 'start' | 'end'; children: ReactNode;
}) {
  const styles = useLocalStyles();
  const viewport = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const overlay = useRef<View>(null);
  const revision = useRef(0);
  const [bounds, setBounds] = useState(viewport);
  const [position, setPosition] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const measure = useCallback(() => {
    const current = ++revision.current;
    if (!open) return;
    anchor.current?.measureInWindow((x, y, width, height) => {
      overlay.current?.measureInWindow((originX, originY, overlayWidth, overlayHeight) => {
        if (current !== revision.current || !overlayWidth || !overlayHeight) return;
        setPosition({ x: x - originX, y: y - originY, width, height });
        setBounds({ width: overlayWidth, height: overlayHeight, scale: viewport.scale, fontScale: viewport.fontScale });
      });
    });
  }, [anchor, open, viewport]);
  useLayoutEffect(() => {
    if (!open) { setPosition(null); setPanelHeight(0); return; }
    let frame = 0;
    let settled: ReturnType<typeof setTimeout> | undefined;
    // KeyboardAvoidingView updates its layout from the same keyboard event.
    // Read the anchor after that render, then again after any keyboard animation.
    const afterLayout = (event?: { duration: number }) => {
      cancelAnimationFrame(frame);
      clearTimeout(settled);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(measure); });
      settled = setTimeout(measure, Math.max(0, event?.duration ?? 0) + 80);
    };
    afterLayout();
    const shown = Keyboard.addListener('keyboardDidShow', afterLayout), hidden = Keyboard.addListener('keyboardDidHide', afterLayout);
    return () => { revision.current++; cancelAnimationFrame(frame); clearTimeout(settled); shown.remove(); hidden.remove(); };
  }, [open, measure]);
  const layout = popoverLayout(position ?? { x: 12, y: bounds.height, width, height: 0 }, bounds, width, panelHeight, insets, align);
  return <Modal visible={open} transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onShow={measure} onRequestClose={onClose} onDismiss={onDismiss}>
    <View ref={overlay} collapsable={false} onLayout={measure} style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭菜单" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View {...(Platform.OS === 'web' ? { dataSet: { controlGlass: 'true' } } : {})} accessibilityViewIsModal onLayout={event => setPanelHeight(event.nativeEvent.layout.height)} style={[styles.panel, {
        ...layout, opacity: position && panelHeight ? 1 : 0,
      }]}>{children}</View>
    </View>
  </Modal>;
}

const useLocalStyles = themedStyles(c => StyleSheet.create({
  overlay: { flex: 1 },
  panel: { position: 'absolute', backgroundColor: Platform.OS === 'web' ? c.glass : c.surface, borderWidth: 1, borderColor: c.glassBorder, borderRadius: 20, padding: 10,
    shadowColor: c.shadow, shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.12, shadowRadius: 20, elevation: 10 },
}));
