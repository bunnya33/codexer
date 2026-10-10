import { useImperativeHandle, useMemo, useRef } from 'react';
import { WebView } from 'react-native-webview';
import { nativePreviewShell } from '../../../packages/client-shared/src/preview-runtime';
import type { PreviewSurfaceProps } from './preview-surface.types';
export function PreviewSurface({ document, url, channel, height, onMessage, surfaceRef }: PreviewSurfaceProps) {
  const view = useRef<WebView<Record<never, never>>>(null);
  const html = useMemo(() => nativePreviewShell(url ?? document ?? '', channel, !!url), [document, url, channel]);
  useImperativeHandle(surfaceRef, () => ({ send: message => view.current?.injectJavaScript(`window.codexerPreviewSend(${JSON.stringify(message).replaceAll('<', '\\u003c')});true;`) }), []);
  return <WebView<Record<never, never>> ref={view} source={{ html }} style={{ height, flex: 0, backgroundColor: '#ffffff' }} originWhitelist={['*']}
    javaScriptEnabled scrollEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} setSupportMultipleWindows={false}
    onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url === 'about:srcdoc' || !!url && request.url.startsWith(url.split('?')[0]!.replace(/[^/]*$/, ''))}
    onMessage={event => { try { const message = JSON.parse(event.nativeEvent.data); if (message.channel === channel) onMessage(message); } catch { /* Malformed preview messages have no host effect. */ } }} />;
}
