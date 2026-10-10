import { useLayoutEffect, useImperativeHandle, useRef } from 'react';
import type { PreviewSurfaceProps } from './preview-surface.types';
export function PreviewSurface({ document, url, channel, height, title, onMessage, surfaceRef }: PreviewSurfaceProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  useImperativeHandle(surfaceRef, () => ({ send: message => frame.current?.contentWindow?.postMessage({ ...message, channel }, '*') }), [channel]);
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.channel === channel) onMessage(event.data);
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, [channel, onMessage]);
  return <iframe ref={frame} title={title} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" srcDoc={document} src={url} onLoad={()=>frame.current?.contentWindow?.postMessage({type:'initialize',channel},'*')} style={{ width: '100%', height, display: 'block', border: 0, background: '#ffffff' }} />;
}
