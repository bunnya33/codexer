import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Animated, Easing, Keyboard, PanResponder, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { ChevronLeft, X } from 'lucide-react-native';
import { useTheme } from '../styles';
import { ChromeButton } from './primitives';
import { useInteractionMotion } from './motion';
import { useSurfaceAccessibility } from './surface-accessibility';

type Position = { left: number; top: number; width: number };
export function InteractionSurface({ open, onClose, onBack, onClosed, title, kind = 'sheet', host, anchor, aboveAnchor, origin, align = 'start', width = 270, children, variant = 'default' }: {
  open: boolean; onClose: () => void; onBack?: () => void; title: string; kind?: 'sheet' | 'reader' | 'popover' | 'drawer';
  host: RefObject<View | null>; anchor?: RefObject<View | null>; aboveAnchor?: RefObject<View | null>; origin?:RefObject<View|null>; align?: 'start' | 'end'; width?: number; children: ReactNode; variant?: 'default' | 'settings' | 'permissions' | 'menu'; onClosed?: () => void;
}) {
  const { c } = useTheme();
  const motion = useInteractionMotion();
  const viewport = useWindowDimensions();
  const [present, setPresent] = useState(open);
  const [bounds, setBounds] = useState({ width: viewport.width, height: viewport.height });
  const [position, setPosition] = useState<Position>();
  const [panelHeight, setPanelHeight] = useState(0);
  const [startRect,setStartRect]=useState<{left:number;top:number;width:number;height:number}>();
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const panel = useRef<View>(null);
  const previousKind = useRef(kind);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const closedRef = useRef(onClosed); closedRef.current = onClosed;
  const close = useMemo(() => () => closeRef.current(), []);
  const backRef = useRef(onBack ?? onClose); backRef.current = onBack ?? onClose;
  const back = useMemo(() => () => backRef.current(), []);
  useSurfaceAccessibility(open && present, panel, back, title);
  const menu = kind === 'popover' && variant === 'menu';
  const morph=kind==='reader'&&!!origin;
  const measured = (!menu || !anchor || !!position && panelHeight > 0) && (!morph||!!startRect);

  useEffect(() => {
    if (open) { setPresent(true); drag.setValue(0); if (previousKind.current !== kind) progress.setValue(0); }
    previousKind.current = kind;
    // Begin the menu's spring only once its anchor and size are known. Otherwise
    // the initial expansion runs invisibly while the native modal is measured.
    if (open && !measured) return;
    const animation = menu && open && motion
      ? Animated.spring(progress, { toValue: 1, stiffness: 420, damping: 33, mass: 1, restSpeedThreshold: .01, restDisplacementThreshold: .001, useNativeDriver: Platform.OS !== 'web' })
      : Animated.timing(progress, { toValue: open ? 1 : 0, duration: motion ? morph ? open ? 320 : 260 : open ? kind === 'popover' ? 200 : 240 : 170 : 0, easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic), useNativeDriver: Platform.OS !== 'web'&&!morph });
    animation.start(({ finished }) => { if (finished && !open) { setPresent(false); closedRef.current?.(); } });
    return () => animation.stop();
  }, [open, motion, progress, drag, kind, menu, measured,morph]);

  useLayoutEffect(() => {
    if (!open) return;
    let live = true, frame = 0;
    const measure = () => {
      frame = requestAnimationFrame(() => host.current?.measureInWindow((hx, hy, hw, hh) => {
        if (!live || !hw || !hh) return;
        setBounds({ width: hw, height: hh });
        origin?.current?.measureInWindow((x,y,w,h)=>{if(live)setStartRect({left:x-hx,top:y-hy,width:Math.max(1,w),height:Math.max(1,h)});});
        anchor?.current?.measureInWindow((ax, ay, aw, ah) => {
          if (!live) return;
          const place = (topEdge: number, forceAbove: boolean) => {
            if (!live) return;
            const pw = Math.min(width, hw - 24);
            const above = topEdge - hy - panelHeight - (forceAbove ? 12 : 8);
            const below = ay - hy + ah + 6;
            setPosition({ width: pw, left: Math.max(12, Math.min(hw - pw - 12, ax - hx + (align === 'end' ? aw - pw : 0))),
              top: Math.max(8, Math.min(hh - panelHeight - 8, forceAbove || above >= 8 && ay - hy > hh * 0.4 ? above : below)) });
          };
          if (aboveAnchor?.current) aboveAnchor.current.measureInWindow((_x, y) => place(y, true));
          else place(ay, false);
        });
      }));
    };
    measure();
    const show = Keyboard.addListener('keyboardDidShow', measure), hide = Keyboard.addListener('keyboardDidHide', measure);
    return () => { live = false; cancelAnimationFrame(frame); show.remove(); hide.remove(); };
  }, [open, host, anchor, aboveAnchor, origin, align, width, panelHeight, viewport.width, viewport.height]);

  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => kind === 'drawer' ? gesture.dx < -6 && Math.abs(gesture.dx) > Math.abs(gesture.dy) : (kind === 'sheet' || kind === 'reader') && gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderMove: (_event, gesture) => drag.setValue(kind === 'drawer' ? Math.min(0, gesture.dx) : Math.max(0, gesture.dy)),
    onPanResponderRelease: (_event, gesture) => {
      if (kind === 'drawer' ? gesture.dx < -65 || gesture.vx < -0.9 : gesture.dy > 75 || gesture.vy > 0.9) close();
      else Animated.spring(drag, { toValue: 0, damping: 26, stiffness: 280, useNativeDriver: Platform.OS !== 'web' }).start();
    },
    onPanResponderTerminate: () => drag.setValue(0),
  }), [kind, drag, close]);

  if (!present) return null;
  const reader = kind === 'reader', sheet = kind === 'sheet' || reader, drawer = kind === 'drawer';
  return <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'auto' : 'none'} accessibilityViewIsModal onAccessibilityEscape={back}>
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay, opacity: Animated.multiply(progress, sheet || drawer ? 1 : menu ? 0 : 0.18) }]}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="关闭面板" onPress={close} />
    </Animated.View>
    <Animated.View ref={panel} testID="interaction-surface" accessibilityLabel={title} onLayout={event => setPanelHeight(event.nativeEvent.layout.height)}
      style={[styles.panel, variant === 'settings' && { height: bounds.height * .52, overflow: 'visible' }, variant === 'menu' && { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'visible' }, { backgroundColor: morph?c.bg:variant === 'settings' ? c.sidebar : variant === 'permissions' ? c.surface : c.glass, borderColor: c.glassBorder,
        // RN Web compiles each shadow object to one box-shadow declaration.
        // Keep geometry and theme color together so the color cannot zero it out.
        shadowColor: c.shadow, shadowOffset: { width: 0, height: variant === 'menu' ? 12 : 7 }, shadowOpacity: variant === 'menu' ? .18 : .13, shadowRadius: variant === 'menu' ? 28 : 24,
        opacity: !measured||anchor && !position ? 0 : menu ? progress.interpolate({ inputRange: [0, .65, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }) : progress,
        ...(reader ? { height: bounds.height * .96 } : {}),
        maxHeight: bounds.height * (drawer ? 1 : reader ? .96 : sheet ? 0.86 : 0.8),
        ...(sheet ? { bottom: 0, left: Math.max(0, (bounds.width - 520) / 2), right: Math.max(0, (bounds.width - 520) / 2), borderBottomWidth: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
          transform: [{ translateY: Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [Math.min(bounds.height, 600), 0] }), drag) }] }
          : drawer ? { left: 0, top: 0, bottom: 0, width: Math.min(332, bounds.width * 0.88), borderTopLeftRadius: 0, borderBottomLeftRadius: 0, transform: [{ translateX: Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [-Math.min(332, bounds.width * 0.88), 0] }), drag) }] }
          : { ...position, transform: [...(variant === 'menu' ? [
            { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [motion ? (position?.width ?? width) * .28 : 0, 0] }) },
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [motion ? -panelHeight * .28 : 0, 0] }) },
          ] : []), { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [motion ? menu ? .44 : .96 : 1, 1] }) }] }),
      },morph&&startRect?{
        left:progress.interpolate({inputRange:[0,1],outputRange:[startRect.left,Math.max(0,(bounds.width-700)/2)]}),
        top:progress.interpolate({inputRange:[0,1],outputRange:[startRect.top,bounds.height*.04]}),
        width:progress.interpolate({inputRange:[0,1],outputRange:[startRect.width,Math.min(bounds.width,700)]}),
        height:progress.interpolate({inputRange:[0,1],outputRange:[startRect.height,bounds.height*.96]}),
        bottom:undefined,right:undefined,maxHeight:undefined,borderRadius:20,transform:[{translateY:drag}],
      }:undefined]}>
      {sheet || drawer ? <View {...pan.panHandlers} style={styles.sheetTop}>
        {sheet && <View style={[styles.handle, { backgroundColor: c.ring }]} />}
        {variant === 'default' ? <View style={styles.heading}>{onBack?<ChromeButton Icon={ChevronLeft} label="返回列表" onPress={back} size={19}/>:<View style={{ width: 44 }} />}<Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>{title}</Text><ChromeButton Icon={X} label="关闭" onPress={close} size={19} /></View>
          : variant === 'settings' ? <Text accessibilityRole="header" style={{ color: c.text, fontSize: 14, textAlign: 'center', paddingVertical: 7 }}>高级 ›</Text> : null}
      </View> : null}
      <View style={[styles.content, reader && { flex: 1, paddingHorizontal: 0, paddingBottom: 0 }, variant === 'permissions' && { paddingHorizontal: 24 }, variant === 'settings' && { paddingHorizontal: 20 }, !sheet && { padding: variant === 'menu' ? 0 : 6 }]}>{children}</View>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  panel: { position: 'absolute', borderRadius: 25, borderWidth: 1, overflow: 'hidden', elevation: 12 },
  sheetTop: { paddingTop: 8 }, handle: { width: 34, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 3 },
  heading: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 7 }, title: { flex: 1, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  content: { paddingHorizontal: 12, paddingBottom: 20, flexShrink: 1, minHeight: 0 },
});
