import { useEffect, useState } from 'react';
import { Copy, Minus, Square, Waypoints, X } from 'lucide-react';
import type { WindowState } from '../types';

export function TitleBar() {
  const [state, setState] = useState<WindowState>({ maximized: false, focused: true });
  useEffect(() => {
    let active = true;
    const unsubscribe = window.codexer.window.subscribe(value => { if (active) setState(value); });
    void window.codexer.window.state().then(value => { if (active) setState(value); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const restoreLabel = state.maximized ? '还原窗口' : '最大化';
  return <div className={`window-titlebar${state.maximized ? ' maximized' : ''}${state.focused ? '' : ' inactive'}`}>
    <div className="window-title"><Waypoints size={16} strokeWidth={1.4} aria-hidden="true"/><span><strong>Codexer</strong><span className="window-title-separator"> · </span>桌面连接器</span></div>
    <div className="window-controls" aria-label="窗口操作">
      <button type="button" aria-label="最小化" title="最小化" onClick={() => void window.codexer.window.minimize()}><Minus size={14} strokeWidth={1.3}/></button>
      <button type="button" aria-label={restoreLabel} title={restoreLabel} onClick={() => void window.codexer.window.toggleMaximize()}>{state.maximized ? <Copy size={13} strokeWidth={1.3}/> : <Square size={13} strokeWidth={1.3}/>}</button>
      <button type="button" className="window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => void window.codexer.window.close()}><X size={15} strokeWidth={1.3}/></button>
    </div>
  </div>;
}
