import { useMemo } from "react";
import { WebView } from "react-native-webview";
import { nativeAudioDocument } from "../../../packages/client-shared/src/audio";
import type { AudioPlayerProps } from "./audio-player.types";

export function AudioPlayer({ uri, onError }: AudioPlayerProps) {
  const html = useMemo(() => nativeAudioDocument(uri), [uri]);
  return <WebView source={{ html }} style={{ height: 72, flex: 0, width: "100%", backgroundColor: "#fff" }}
    containerStyle={{ height: 72, flex: 0, width: "100%" }}
    originWhitelist={['*']} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
    scrollEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
    allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
    setSupportMultipleWindows={false}
    onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
    onMessage={event => { if (event.nativeEvent.data === 'audio-error') onError(); }}
    onError={onError} />;
}
