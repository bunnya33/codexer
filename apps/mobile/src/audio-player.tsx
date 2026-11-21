import { useMemo } from "react";
import { WebView } from "react-native-webview";
import { nativeMediaDocument } from "../../../packages/client-shared/src/audio";
import { DrawerSwipeBlock } from "./drawer-swipe-block";
import type { AudioPlayerProps } from "./audio-player.types";

export function AudioPlayer({ kind, uri, onError, onEnded }: AudioPlayerProps) {
  const html = useMemo(() => nativeMediaDocument(uri, kind), [kind, uri]);
  const video = kind === "video";
  return <DrawerSwipeBlock style={{ width: "100%", ...(video ? { aspectRatio: 16 / 9 } : { height: 72 }) }}>
    <WebView source={{ html }} style={{ backgroundColor: video ? "#000" : "#fff" }}
      originWhitelist={['*']} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
      scrollEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
      onMessage={event => {
        if (event.nativeEvent.data === `${kind}-error`) onError();
        if (event.nativeEvent.data === `${kind}-ended`) onEnded?.();
      }}
      onError={onError} />
  </DrawerSwipeBlock>;
}
