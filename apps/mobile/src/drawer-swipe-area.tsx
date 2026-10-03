import { useContext, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { PanResponder, View } from 'react-native';
import { DrawerMotionContext, DrawerSwipeBlockContext } from './drawer-context';

export function DrawerSwipeArea({ children }: { children: ReactNode }) {
  const motion = useContext(DrawerMotionContext);
  const blocked = useRef(false);
  const cancelled = useRef(false);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: () => { blocked.current = false; return false; },
    onMoveShouldSetPanResponderCapture: (_, gesture) => !blocked.current && gesture.numberActiveTouches === 1 && !!motion?.canStart(gesture.dx, gesture.dy),
    onPanResponderGrant: (_, gesture) => { cancelled.current = false; motion?.begin(); motion?.move(gesture.dx); },
    onPanResponderMove: (_, gesture) => {
      if (cancelled.current) return;
      if (gesture.numberActiveTouches !== 1) { cancelled.current = true; motion?.cancel(); }
      else motion?.move(gesture.dx);
    },
    onPanResponderRelease: (_, gesture) => { if (!cancelled.current) { motion?.move(gesture.dx); motion?.release(gesture.vx); } },
    onPanResponderTerminate: () => { cancelled.current = true; motion?.cancel(); },
    onPanResponderTerminationRequest: () => true,
    onShouldBlockNativeResponder: () => true,
  }), [motion]);
  const block = useMemo(() => () => { blocked.current = true; }, []);
  return <DrawerSwipeBlockContext.Provider value={block}><View style={{ flex: 1 }} {...responder.panHandlers}>{children}</View></DrawerSwipeBlockContext.Provider>;
}
