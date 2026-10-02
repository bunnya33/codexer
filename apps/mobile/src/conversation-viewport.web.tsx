import type { ReactNode } from 'react';
import './conversation-viewport.web.css';

export function ConversationViewport({children, onScrollIntent}: {children: ReactNode; onScrollIntent: () => void}) {
  return <div className="codexer-conversation-viewport" style={{display: 'flex', flex: 1, minHeight: 0, position: 'relative'}} onWheelCapture={onScrollIntent} onTouchMoveCapture={onScrollIntent} onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) onScrollIntent(); }}>{children}</div>;
}
