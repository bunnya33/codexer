import { useEffect, useRef } from "react";
import type { AudioPlayerProps } from "./audio-player.types";

export function AudioPlayer({ kind, uri, onError, onEnded }: AudioPlayerProps) {
  const player = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const media = player.current;
    return () => {
      if (!media) return;
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
  }, [kind, uri]);
  const props = {
    ref: (element: HTMLMediaElement | null) => { player.current = element; },
    src: uri, controls: true, preload: "metadata", onError, onEnded,
  };
  if (kind === "video") return <video {...props} playsInline aria-label="视频播放控件" data-drawer-swipe="ignore"
    style={{ display: "block", width: "100%", aspectRatio: "16 / 9", backgroundColor: "#000" }} />;
  return <audio {...props} aria-label="音频播放控件" style={{ display: "block", width: "100%", minWidth: 0 }} />;
}
