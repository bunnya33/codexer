import { useEffect, useRef, useState } from "react";
import { AudioPlaybackCoordinator } from "../../../packages/client-shared/src/audio-playback";
import type { FileInfo } from "../../../packages/protocol/src/files";
import { fileError } from "./file-transfer";
import { relay } from "./relay";

const playback = new AudioPlaybackCoordinator();
type PlayerState = { scope: string; phase: "idle" | "loading" | "ready" | "error"; uri?: string; info?: FileInfo; error?: string };

export function useAudioPlayback(deviceId: string, threadId: string, path: string, initialInfo?: FileInfo) {
  const scope = JSON.stringify([deviceId, threadId, path, initialInfo?.version]);
  const [stored, setPlayer] = useState<PlayerState>({ scope, phase: "idle", info: initialInfo });
  const operation = useRef<{ scope: string; stop: () => Promise<void> } | undefined>(undefined);
  const player = stored.scope === scope ? stored : { scope, phase: "idle" as const, info: initialInfo };
  useEffect(() => () => {
    if (operation.current?.scope === scope) {
      void operation.current.stop();
      operation.current = undefined;
    }
  }, [scope]);
  const start = () => {
    let info = initialInfo;
    const lease = playback.start(async signal => {
      info = initialInfo ?? await relay.fileInfo(deviceId, threadId, path, signal);
      return relay.openAudioSource(deviceId, threadId, path, info.version, signal);
    }, {
      ready: source => setPlayer({ scope, phase: "ready", uri: source.uri, info }),
      error: error => setPlayer({ scope, phase: "error", error: fileError(error), info }),
      stopped: () => setPlayer(value => value.scope === scope ? { scope, phase: "idle", info: value.info } : value),
    });
    operation.current = { scope, ...lease };
    setPlayer({ scope, phase: "loading", info: player.info });
  };
  const stop = () => { void operation.current?.stop(); };
  const fail = () => {
    stop();
    setPlayer({ scope, phase: "error", info: player.info, error: "音频暂时无法播放，请重新加载；格式不支持时可使用消息中的下载链接。" });
  };
  return { ...player, start, stop, fail };
}
