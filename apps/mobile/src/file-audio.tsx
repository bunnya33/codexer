import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Music2 } from "lucide-react-native";
import type { FileInfo } from "../../../packages/protocol/src/files";
import { AudioPlayer } from "./audio-player";
import { relay } from "./relay";
import { fileError } from "./file-transfer";
import { c } from "./styles";

export function FileAudio({ deviceId, threadId, path, info }: {
  deviceId: string; threadId: string; path: string; info: FileInfo;
}) {
  const [attempt, setAttempt] = useState(0);
  const [player, setPlayer] = useState<{ uri?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    let release: (() => Promise<void>) | undefined;
    setPlayer({});
    void relay.openAudioSource(deviceId, threadId, path, info.version, controller.signal).then(source => {
      if (controller.signal.aborted) { void source.release().catch(() => {}); return; }
      release = source.release;
      setPlayer({ uri: source.uri });
    }).catch(error => {
      if (!controller.signal.aborted) setPlayer({ error: fileError(error) });
    });
    return () => { controller.abort(); void release?.().catch(() => {}); };
  }, [deviceId, threadId, path, info.version, attempt]);
  return <View style={as.body}>
    <View style={as.card}>
      <Music2 size={44} color={c.accent} />
      <Text style={as.title}>音频播放器</Text>
      {player.error ? <>
        <Text accessibilityRole="alert" style={as.error}>{player.error}</Text>
        <Text style={as.hint}>也可以使用右上角的下载按钮，保存后播放。</Text>
        <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={as.retry}>
          <Text style={as.retryText}>重新加载</Text>
        </Pressable>
      </> : player.uri ? <>
        <AudioPlayer key={player.uri} uri={player.uri} onError={() => setPlayer({ error: "音频暂时无法播放，请重新加载；格式不支持时可下载后播放。" })} />
        <Text style={as.hint}>点击播放，可拖动进度条跳转。</Text>
      </> : <ActivityIndicator color={c.accent} accessibilityLabel="正在准备音频" />}
    </View>
  </View>;
}

const as = StyleSheet.create({
  body: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20 },
  card: { width: "100%", maxWidth: 560, alignItems: "center", gap: 20, padding: 20, borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.surface },
  title: { color: c.text, fontSize: 19, fontWeight: "600" },
  hint: { color: c.muted, fontSize: 13, lineHeight: 21, textAlign: "center" },
  error: { color: c.danger, fontSize: 15, lineHeight: 23, textAlign: "center" },
  retry: { borderRadius: 6, paddingVertical: 10, paddingHorizontal: 18, backgroundColor: c.accent },
  retryText: { color: "#fff", fontSize: 15 },
});
