import { useContext, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { PanResponder, View } from 'react-native';
import { drawerCanStartFromText } from '../../../packages/client-shared/src/drawer';
import { DrawerMotionContext, DrawerSelectionContext, DrawerSwipeBlockContext } from './drawer-context';

export function DrawerSwipeArea({ children }: { children: ReactNode }) {
  const motion = useContext(DrawerMotionContext);
  const blocked = useRef(false);
  const cancelled = useRef(false);
  const dragging = useRef(false);
  const selections = useRef(new Set<symbol>());
  const text = useRef(false);
  const startedAt = useRef(0);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: ({ nativeEvent }) => {
      blocked.current = selections.current.size > 0;
      text.current = false;
      startedAt.current = nativeEvent.timestamp;
      return false;
    },
    onMoveShouldSetPanResponderCapture: ({ nativeEvent }, gesture) => {
      if (blocked.current || gesture.numberActiveTouches !== 1) return false;
      const selected = selections.current.size > 0;
      const allowed = text.current ? drawerCanStartFromText(nativeEvent.timestamp - startedAt.current, selected) : !selected;
      return allowed && !!motion?.canStart(gesture.dx, gesture.dy);
    },
    onPanResponderGrant: (_, gesture) => {
      cancelled.current = blocked.current || selections.current.size > 0;
      if (!cancelled.current) { dragging.current = true; motion?.begin(); motion?.move(gesture.dx); }
    },
    onPanResponderMove: (_, gesture) => {
      if (cancelled.current) return;
      if (gesture.numberActiveTouches !== 1) { cancelled.current = true; motion?.cancel(); }
      else motion?.move(gesture.dx);
    },
    onPanResponderRelease: (_, gesture) => { dragging.current = false; if (!cancelled.current) { motion?.move(gesture.dx); motion?.release(gesture.vx); } },
    onPanResponderTerminate: () => { dragging.current = false; cancelled.current = true; motion?.cancel(); },
    onPanResponderTerminationRequest: () => true,
    onShouldBlockNativeResponder: () => true,
  }), [motion]);
  const block = useMemo(() => (selectableText?: boolean) => {
    if (selectableText) text.current = true;
    else blocked.current = true;
  }, []);
  const select = useMemo(() => (owner: symbol, active: boolean) => {
    if (!active) { selections.current.delete(owner); return; }
    selections.current.add(owner);
    // A handle can be outside the text view, including during selection dismissal.
    blocked.current = true;
    if (dragging.current && !cancelled.current) {
      cancelled.current = true;
      motion?.cancel();
    }
  }, [motion]);
  return <DrawerSelectionContext.Provider value={select}><DrawerSwipeBlockContext.Provider value={block}>
    <View style={{ flex: 1 }} {...responder.panHandlers}>{children}</View>
  </DrawerSwipeBlockContext.Provider></DrawerSelectionContext.Provider>;
}
