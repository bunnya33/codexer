import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';
import type { NativeTouchEvent } from 'react-native';

type Dismiss = () => void;
const SelectionArea = createContext<{
  register: (owner: symbol, dismiss: Dismiss | null) => void;
  markTouch: (owner: symbol) => void;
} | null>(null);

export function useSelectionDismissal(dismiss: Dismiss) {
  const area = useContext(SelectionArea);
  const [owner] = useState(() => Symbol());
  useLayoutEffect(() => () => area?.register(owner, null), [area, owner]);
  return {
    setActive: (active: boolean) => area?.register(owner, active ? dismiss : null),
    markTouch: () => area?.markTouch(owner),
  };
}

type Tap = { start: NativeTouchEvent; selections: [symbol, Dismiss][] };
const moved = (start: NativeTouchEvent, touch: NativeTouchEvent) =>
  Math.hypot(touch.pageX - start.pageX, touch.pageY - start.pageY) > 8;

export function MessageSelectionArea({ children }: { children: ReactNode }) {
  const active = useRef(new Map<symbol, Dismiss>());
  const touched = useRef<symbol | null>(null);
  const tap = useRef<Tap | null>(null);
  const area = useMemo(() => ({
    register: (owner: symbol, dismiss: Dismiss | null) => {
      if (dismiss) active.current.set(owner, dismiss);
      else active.current.delete(owner);
    },
    markTouch: (owner: symbol) => { touched.current = owner; },
  }), []);
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return <>{children}</>;
  // Observe outside taps without taking the responder from scrolling or selection handles.
  return <SelectionArea.Provider value={area}><View style={{ flex: 1 }}
    onTouchStart={({ nativeEvent }) => {
      const owner = touched.current;
      touched.current = null;
      tap.current = active.current.size && nativeEvent.touches.length === 1
        ? { start: nativeEvent, selections: [...active.current].filter(([key]) => key !== owner) } : null;
    }}
    onTouchMove={({ nativeEvent }) => {
      if (tap.current && (nativeEvent.touches.length !== 1 || moved(tap.current.start, nativeEvent))) tap.current = null;
    }}
    onTouchCancel={() => { tap.current = null; touched.current = null; }}
    onTouchEnd={({ nativeEvent }) => {
      const candidate = tap.current;
      tap.current = null;
      if (!candidate || nativeEvent.identifier !== candidate.start.identifier || nativeEvent.touches.length
        || nativeEvent.timestamp - candidate.start.timestamp > 400 || moved(candidate.start, nativeEvent)) return;
      for (const [owner, dismiss] of candidate.selections) {
        if (active.current.get(owner) === dismiss) dismiss();
      }
    }}>{children}</View></SelectionArea.Provider>;
}
