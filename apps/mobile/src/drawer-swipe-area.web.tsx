import { useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { DrawerMotionContext } from './drawer-context';
import './drawer-swipe-area.web.css';

type Drag = { id: number; x: number; y: number; lastX: number; lastTime: number; velocity: number; claimed: boolean; rejected: boolean };

export function DrawerSwipeArea({ children }: { children: ReactNode }) {
  const motion = useContext(DrawerMotionContext);
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Set<number>());
  const suppressClickUntil = useRef(0);
  const cancel = () => { if (drag.current?.claimed) { motionRef.current?.cancel(); suppressClickUntil.current = performance.now() + 350; } drag.current = null; };
  const start = (id: number, x: number, y: number, time: number, element: Element) => {
    const ignored = !!element.closest('input, textarea, select, button:not([data-drawer-swipe="handle"]), a, [role="button"]:not([data-drawer-swipe="handle"]), [contenteditable="true"], [data-drawer-swipe="ignore"], pre, table');
    drag.current = { id, x, y, lastX: x, lastTime: time, velocity: 0, claimed: false, rejected: ignored };
  };
  const move = (id: number, x: number, y: number, time: number) => {
    const current = drag.current;
    if (!current || current.id !== id || current.rejected) return false;
    const dx = x - current.x, dy = y - current.y;
    if (!current.claimed) {
      if (Math.abs(dy) >= 12 && Math.abs(dy) >= Math.abs(dx)) { current.rejected = true; return false; }
      if (!motionRef.current?.canStart(dx, dy)) return false;
      current.claimed = true;
      motionRef.current.begin();
    }
    const elapsed = time - current.lastTime;
    if (elapsed > 0) current.velocity = (x - current.lastX) / elapsed;
    current.lastX = x; current.lastTime = time;
    motionRef.current?.move(dx);
    return true;
  };
  const release = (id: number, x: number, time: number) => {
    const current = drag.current;
    if (!current || current.id !== id) return false;
    drag.current = null;
    if (!current.claimed) return false;
    suppressClickUntil.current = performance.now() + 350;
    motionRef.current?.move(x - current.x);
    motionRef.current?.release(time - current.lastTime > 100 ? 0 : current.velocity);
    return true;
  };
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const touchStart = (event: TouchEvent) => {
      if (!motionRef.current) return;
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0]!;
      start(touch.identifier, touch.clientX, touch.clientY, event.timeStamp, event.target as Element);
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0]!;
      if (move(touch.identifier, touch.clientX, touch.clientY, event.timeStamp)) { event.preventDefault(); event.stopPropagation(); }
    };
    const touchEnd = (event: TouchEvent) => {
      for (const touch of event.changedTouches) if (release(touch.identifier, touch.clientX, event.timeStamp)) { event.preventDefault(); event.stopPropagation(); }
    };
    element.addEventListener('touchstart', touchStart, { passive: true, capture: true });
    // Only claim horizontal drags. Native scrolling and nested horizontal regions stay enabled.
    element.addEventListener('touchmove', touchMove, { passive: false, capture: true });
    element.addEventListener('touchend', touchEnd, { passive: false, capture: true });
    element.addEventListener('touchcancel', cancel, { passive: true, capture: true });
    return () => {
      element.removeEventListener('touchstart', touchStart, true); element.removeEventListener('touchmove', touchMove, true);
      element.removeEventListener('touchend', touchEnd, true); element.removeEventListener('touchcancel', cancel, true);
    };
  }, []);
  return <div ref={surface} className="codexer-drawer-swipe-area"
    onPointerDownCapture={event => {
      if (event.pointerType === 'touch') return;
      if (event.button !== 0 || !motion) return;
      pointers.current.add(event.pointerId);
      if (pointers.current.size > 1) { cancel(); return; }
      start(event.pointerId, event.clientX, event.clientY, event.timeStamp, event.target as Element);
    }}
    onPointerMoveCapture={event => {
      if (event.pointerType === 'touch') return;
      if (move(event.pointerId, event.clientX, event.clientY, event.timeStamp)) {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault(); event.stopPropagation();
      }
    }}
    onPointerUpCapture={event => {
      if (event.pointerType === 'touch') return;
      pointers.current.delete(event.pointerId);
      if (release(event.pointerId, event.clientX, event.timeStamp)) { event.preventDefault(); event.stopPropagation(); }
    }}
    onPointerCancelCapture={event => { if (event.pointerType !== 'touch') { pointers.current.delete(event.pointerId); cancel(); } }}
    onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) { pointers.current.delete(event.pointerId); cancel(); } }}
    onClickCapture={event => { if (performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } }}>
    {children}
  </div>;
}
