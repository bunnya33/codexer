import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { ScrollDirection } from '../../../packages/client-shared/src/conversation-scroll';
import './conversation-viewport.web.css';

function nestedScroll(target: EventTarget | null, direction: ScrollDirection): boolean {
  const element = target as Element | null;
  const stream = element?.closest?.('[data-testid="conversation-stream"]');
  for (let node = element; stream && node && node !== stream; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (!style || !/auto|scroll/.test(style.overflowY)) continue;
    if (direction === 'up' ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight - 1) return true;
    if (/contain|none/.test(style.overscrollBehaviorY)) return true;
  }
  return false;
}

export function ConversationViewport({children, onScrollIntent}: {children: ReactNode; onScrollIntent: (direction: ScrollDirection) => void}) {
  const touchStart = useRef({ x: 0, y: 0, ignored: false });
  const scrollbar = useRef<{ id: number; y: number; node: HTMLElement; offset: number } | null>(null);
  // Drawer exclusions protect horizontal controls. Their vertical gestures can
  // still scroll the conversation and must cancel automatic following.
  const ignored = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
  const intent = (target: EventTarget | null, direction: ScrollDirection) => {
    if (!ignored(target) && !nestedScroll(target, direction)) onScrollIntent(direction);
  };
  return <div className="codexer-conversation-viewport" style={{display: 'flex', flex: 1, minHeight: 0, position: 'relative'}}
    onPointerDownCapture={event => {
      const stream = event.target as HTMLElement;
      if (event.button !== 0 || event.pointerType === 'touch' || stream?.getAttribute('data-testid') !== 'conversation-stream' || stream.scrollHeight <= stream.clientHeight) return;
      const rect = stream.getBoundingClientRect();
      if (event.clientX < rect.right - Math.max(14, stream.offsetWidth - stream.clientWidth)) return;
      scrollbar.current = { id: event.pointerId, y: event.clientY, node: stream, offset: stream.scrollTop };
      const y = event.clientY - rect.top, top = stream.clientHeight * stream.scrollTop / stream.scrollHeight;
      const bottom = stream.clientHeight * (stream.scrollTop + stream.clientHeight) / stream.scrollHeight;
      if (y < top) onScrollIntent('up');
      else if (y > bottom) onScrollIntent('down');
    }}
    onPointerMoveCapture={event => {
      const drag = scrollbar.current;
      if (!drag || drag.id !== event.pointerId || !event.buttons) { scrollbar.current = null; return; }
      if (Math.abs(event.clientY - drag.y) > 1) { onScrollIntent(event.clientY < drag.y ? 'up' : 'down'); drag.y = event.clientY; }
    }}
    onScrollCapture={event => {
      const drag = scrollbar.current;
      // Native scrollbar drags can suppress pointermove. Capture their scroll
      // before the list reads it, while a real scrollbar press is held.
      if (!drag || event.target !== drag.node) return;
      const offset = drag.node.scrollTop;
      if (Math.abs(offset - drag.offset) > 1) onScrollIntent(offset < drag.offset ? 'up' : 'down');
      drag.offset = offset;
    }}
    onPointerUpCapture={() => { scrollbar.current = null; }} onPointerCancelCapture={() => { scrollbar.current = null; }}
    onWheelCapture={event => { if (!event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) intent(event.target, event.deltaY < 0 ? 'up' : 'down'); }}
    onTouchStartCapture={event => { const touch = event.touches[0]; if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY, ignored: ignored(event.target) }; }}
    onTouchMoveCapture={event => { const touch = event.touches[0]; if (!touch || event.touches.length !== 1 || touchStart.current.ignored) return; const dx = Math.abs(touch.clientX - touchStart.current.x), dy = touch.clientY - touchStart.current.y; if (Math.abs(dy) > 6 && Math.abs(dy) > dx) { intent(event.target, dy > 0 ? 'up' : 'down'); touchStart.current = { x: touch.clientX, y: touch.clientY, ignored: false }; } }}
    onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) intent(event.target, ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey) ? 'up' : 'down'); }}>{children}</div>;
}
