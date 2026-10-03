import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Animated, BackHandler, Easing, Keyboard, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { drawerCanStart, drawerOffset, drawerReleaseOpen, drawerWidth } from '../../../packages/client-shared/src/drawer';
import { DrawerMotionContext } from './drawer-context';
import { DrawerSwipeArea } from './drawer-swipe-area';
import { DrawerAccessibility } from './drawer-accessibility';

export function ConversationDrawer({ wide, open, onOpenChange, directory, children }: {
  wide: boolean; open: boolean; onOpenChange: (open: boolean) => void; directory: ReactNode; children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const travel = drawerWidth(width);
  const progress = useRef(new Animated.Value(0)).current;
  const offset = useRef(0);
  const drag = useRef<{ origin: number; dx: number; wasOpen: boolean } | null>(null);
  const reducedMotion = useRef(false);
  const generation = useRef(0);
  const [present, setPresent] = useState(open && !wide);
  const settings = useRef({ wide, open, travel, onOpenChange });
  settings.current = { wide, open, travel, onOpenChange };
  useEffect(() => {
    const listener = progress.addListener(({ value }) => { offset.current = value; });
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) reducedMotion.current = value; });
    const preference = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { reducedMotion.current = value; });
    return () => { active = false; generation.current++; progress.stopAnimation(); progress.removeListener(listener); preference?.remove(); };
  }, [progress]);

  const animate = useCallback((nextOpen: boolean) => {
    const sequence = ++generation.current;
    progress.stopAnimation();
    if (nextOpen) { setPresent(true); Keyboard.dismiss(); }
    Animated.timing(progress, {
      toValue: nextOpen ? 1 : 0, duration: reducedMotion.current ? 0 : 260,
      easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web',
    }).start(({ finished }) => { if (finished && sequence === generation.current && !nextOpen) setPresent(false); });
  }, [progress]);
  useEffect(() => {
    drag.current = null;
    if (wide) { generation.current++; progress.stopAnimation(); progress.setValue(0); offset.current = 0; setPresent(false); if (open) settings.current.onOpenChange(false); }
    else animate(open);
  }, [wide, open, travel, animate, progress]);

  const motion = useMemo(() => ({
    canStart: (dx: number, dy: number) => !settings.current.wide && drawerCanStart(dx, dy, offset.current * settings.current.travel),
    begin: () => {
      generation.current++;
      const current = { origin: offset.current, dx: 0, wasOpen: settings.current.open };
      drag.current = current;
      setPresent(true); Keyboard.dismiss();
      progress.stopAnimation(value => { if (drag.current === current) { current.origin = value; const next = drawerOffset(value * settings.current.travel + current.dx, settings.current.travel) / settings.current.travel; offset.current = next; progress.setValue(next); } });
    },
    move: (dx: number) => {
      const current = drag.current;
      if (!current) return;
      current.dx = dx;
      const next = drawerOffset(current.origin * settings.current.travel + dx, settings.current.travel) / settings.current.travel;
      offset.current = next; progress.setValue(next);
    },
    release: (velocity: number) => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      const nextOpen = drawerReleaseOpen(offset.current * settings.current.travel, settings.current.travel, velocity, current.wasOpen, current.origin * settings.current.travel);
      settings.current.onOpenChange(nextOpen);
      animate(nextOpen);
    },
    cancel: () => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      animate(current.wasOpen);
    },
  }), [animate, progress]);
  useEffect(() => {
    if (wide || !present) return;
    const close = () => { settings.current.onOpenChange(false); animate(false); return true; };
    if (Platform.OS === 'web') {
      const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } };
      window.addEventListener('keydown', escape);
      return () => window.removeEventListener('keydown', escape);
    }
    const back = BackHandler.addEventListener('hardwareBackPress', close);
    return () => back.remove();
  }, [wide, present, animate]);
  const interactive = open && !wide;
  return <DrawerMotionContext.Provider value={motion}><View testID="conversation-drawer" style={[styles.root, wide && styles.wide]}>
    <Animated.View testID="conversation-directory" pointerEvents={wide || interactive ? 'auto' : 'none'} aria-hidden={!wide && !interactive}
      accessibilityElementsHidden={!wide && !interactive} importantForAccessibility={wide || interactive ? 'auto' : 'no-hide-descendants'}
      style={wide ? styles.desktopDirectory : [styles.directory, { width: travel, opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }), transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) }] }]}>
      <DrawerAccessibility active={wide || interactive}><DrawerSwipeArea>{directory}</DrawerSwipeArea></DrawerAccessibility>
    </Animated.View>
    <Animated.View testID="conversation-card" style={[styles.card, !wide && {
      width: '100%', transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }) }],
      borderTopLeftRadius: present ? 28 : 0, borderBottomLeftRadius: present ? 28 : 0,
      shadowColor: '#000', shadowOffset: { width: -8, height: 0 }, shadowRadius: 24,
      shadowOpacity: present ? 0.12 : 0, elevation: present ? 12 : 0,
    }]}>
      <View style={[styles.content, !wide && { borderTopLeftRadius: present ? 28 : 0, borderBottomLeftRadius: present ? 28 : 0 }]}>
      <DrawerAccessibility active={!interactive}>{children}</DrawerAccessibility>
      {!wide && present && <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 0.35] }) }]}>
        <DrawerSwipeArea><Pressable accessibilityRole="button" accessibilityLabel="返回会话" {...(Platform.OS === 'web' ? { dataSet: { drawerSwipe: 'handle' } } : {})} style={styles.cover}
          onPress={() => { onOpenChange(false); animate(false); }} /></DrawerSwipeArea>
      </Animated.View>}
      </View>
    </Animated.View>
  </View></DrawerMotionContext.Provider>;
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden', backgroundColor: '#fff' }, wide: { flexDirection: 'row' },
  directory: { position: 'absolute', top: 0, bottom: 0, left: 0 }, desktopDirectory: { width: 300 },
  card: { flex: 1, minWidth: 0, backgroundColor: '#fff' },
  content: { flex: 1, overflow: 'hidden' }, cover: { flex: 1, backgroundColor: '#fff' },
});
