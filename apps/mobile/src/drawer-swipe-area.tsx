import { useContext, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { PanResponder, View } from 'react-native';
import { DrawerMotionContext, DrawerSelectionContext, DrawerSwipeBlockContext } from './drawer-context';

export function DrawerSwipeArea({ children }: { children: ReactNode }) {
  const motion = useContext(DrawerMotionContext);
  const blocked = useRef(false);
  const cancelled = useRef(false);
  const dragging = useRef(false);
  const selections = useRef(new Set<symbol>());
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: () => { blocked.current = selections.current.size > 0; return false; },
    onMoveShouldSetPanResponderCapture: (_, gesture) => !blocked.current && !selections.current.size && gesture.numberActiveTouches === 1 && !!motion?.canStart(gesture.dx, gesture.dy),
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
  const block = useMemo(() => () => { blocked.current = true; }, []);
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
