import { useRef } from 'react';
import type { ReactNode } from 'react';
import './conversation-viewport.web.css';

export function ConversationViewport({children, onScrollIntent}: {children: ReactNode; onScrollIntent: () => void}) {
  const touchStart = useRef({ x: 0, y: 0, ignored: false });
  const ignored = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('[data-drawer-swipe="ignore"], input, textarea, [contenteditable="true"]');
  return <div className="codexer-conversation-viewport" style={{display: 'flex', flex: 1, minHeight: 0, position: 'relative'}}
    onWheelCapture={event => { if (!ignored(event.target) && Math.abs(event.deltaY) > Math.abs(event.deltaX)) onScrollIntent(); }}
    onTouchStartCapture={event => { const touch = event.touches[0]; if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY, ignored: ignored(event.target) }; }}
    onTouchMoveCapture={event => { const touch = event.touches[0]; if (!touch || event.touches.length !== 1 || touchStart.current.ignored) return; const dx = Math.abs(touch.clientX - touchStart.current.x), dy = Math.abs(touch.clientY - touchStart.current.y); if (dy > 6 && dy > dx) onScrollIntent(); }}
    onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && !ignored(event.target)) onScrollIntent(); }}>{children}</div>;
}
