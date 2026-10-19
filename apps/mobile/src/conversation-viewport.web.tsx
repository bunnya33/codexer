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
  const ignored = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('[data-drawer-swipe="ignore"], input, textarea, [contenteditable="true"]');
  const intent = (target: EventTarget | null, direction: ScrollDirection) => {
    if (!ignored(target) && !nestedScroll(target, direction)) onScrollIntent(direction);
  };
  return <div className="codexer-conversation-viewport" style={{display: 'flex', flex: 1, minHeight: 0, position: 'relative'}}
    onWheelCapture={event => { if (!event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) intent(event.target, event.deltaY < 0 ? 'up' : 'down'); }}
    onTouchStartCapture={event => { const touch = event.touches[0]; if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY, ignored: ignored(event.target) }; }}
    onTouchMoveCapture={event => { const touch = event.touches[0]; if (!touch || event.touches.length !== 1 || touchStart.current.ignored) return; const dx = Math.abs(touch.clientX - touchStart.current.x), dy = touch.clientY - touchStart.current.y; if (Math.abs(dy) > 6 && Math.abs(dy) > dx) { intent(event.target, dy > 0 ? 'up' : 'down'); touchStart.current = { x: touch.clientX, y: touch.clientY, ignored: false }; } }}
    onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) intent(event.target, ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey) ? 'up' : 'down'); }}>{children}</div>;
}
