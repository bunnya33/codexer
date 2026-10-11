import { useImperativeHandle, useMemo, useRef } from 'react';
import { WebView } from 'react-native-webview';
import { nativePreviewShell } from '../../../packages/client-shared/src/preview-runtime';
import type { PreviewSurfaceProps } from './preview-surface.types';
export function PreviewSurface({ document, url, channel, height, expanded = false, onMessage, surfaceRef }: PreviewSurfaceProps) {
  const view = useRef<WebView<Record<never, never>>>(null);
  const html = useMemo(() => nativePreviewShell(url ?? document ?? '', channel, !!url, expanded), [document, url, channel, expanded]);
  useImperativeHandle(surfaceRef, () => ({ send: message => view.current?.injectJavaScript(`window.codexerPreviewSend(${JSON.stringify(message).replaceAll('<', '\\u003c')});true;`) }), []);
  return <WebView<Record<never, never>> ref={view} source={{ html }} style={[expanded ? { flex: 1 } : { height, flex: 0 }, { backgroundColor: '#ffffff' }]} containerStyle={expanded ? { flex: 1, minHeight: 0 } : { height, flex: 0 }} originWhitelist={['*']}
    javaScriptEnabled scrollEnabled={expanded} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} setSupportMultipleWindows={false}
    onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url === 'about:srcdoc' || !!url && request.url.startsWith(url.split('?')[0]!.replace(/[^/]*$/, ''))}
    onMessage={event => { try { const message = JSON.parse(event.nativeEvent.data); if (message.channel === channel) onMessage(message); } catch { /* Malformed preview messages have no host effect. */ } }} />;
}
