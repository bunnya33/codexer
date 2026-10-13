import { useEffect, useRef } from "react";
import type { AudioPlayerProps } from "./audio-player.types";

export function AudioPlayer({ uri, onError }: AudioPlayerProps) {
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = player.current;
    return () => {
      if (!audio) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [uri]);
  return <audio ref={player} src={uri} controls preload="metadata" aria-label="音频播放控件" onError={onError} style={{ display: "block", width: "100%", minWidth: 0 }} />;
}
