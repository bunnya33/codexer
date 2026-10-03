import { useRef } from 'react';
import type { ReactNode } from 'react';
import './conversation-viewport.web.css';

export function ConversationViewport({children, onScrollIntent}: {children: ReactNode; onScrollIntent: () => void}) {
  const touchStart = useRef({ x: 0, y: 0 });
  return <div className="codexer-conversation-viewport" style={{display: 'flex', flex: 1, minHeight: 0, position: 'relative'}} onWheelCapture={onScrollIntent}
    onTouchStartCapture={event => { const touch = event.touches[0]; if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY }; }}
    onTouchMoveCapture={event => { const touch = event.touches[0]; if (!touch) return; const dx = Math.abs(touch.clientX - touchStart.current.x), dy = Math.abs(touch.clientY - touchStart.current.y); if (dy > 6 && dy > dx) onScrollIntent(); }}
    onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) onScrollIntent(); }}>{children}</div>;
}
