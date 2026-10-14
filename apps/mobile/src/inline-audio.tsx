import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Music2 } from "lucide-react-native";
import type { AudioReference } from "../../../packages/client-shared/src/audio";
import { fileName, fileSize } from "../../../packages/client-shared/src/file-links";
import { AudioPlayer } from "./audio-player";
import { useAudioPlayback } from "./audio-playback";
import { c } from "./styles";

export function InlineAudio({ reference, deviceId, threadId }: {
  reference: AudioReference; deviceId: string; threadId: string;
}) {
  const player = useAudioPlayback(deviceId, threadId, reference.source);
  const name = player.info?.name ?? fileName(reference.source);
  const format = name.split(".").at(-1)?.toUpperCase();
  return <View style={as.card} accessibilityLabel={`音频 ${reference.title}`}>
    <View style={as.header}>
      <View style={as.icon}><Music2 size={24} color={c.accent} /></View>
      <View style={as.heading}>
        <Text style={as.name} numberOfLines={2}>{name}</Text>
        <Text style={as.meta}>{format} 音频{player.info ? ` · ${fileSize(player.info.size)}` : ""}</Text>
      </View>
    </View>
    <View style={as.controls}>
      {player.error ? <>
        <Text accessibilityRole="alert" style={as.error}>{player.error}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="重新加载音频" onPress={player.start}>
          <Text style={as.retry}>重新加载</Text>
        </Pressable>
      </> : player.uri ? <AudioPlayer key={player.uri} uri={player.uri} onError={player.fail} onEnded={player.stop} />
        : player.phase === "loading" ? <ActivityIndicator color={c.accent} accessibilityLabel="正在准备音频" />
        : <Pressable accessibilityRole="button" accessibilityLabel={`加载音频 ${name}`} onPress={player.start}>
          <Text style={as.retry}>加载音频</Text>
        </Pressable>}
    </View>
  </View>;
}

const as = StyleSheet.create({
  card: { width: "100%", maxWidth: 736, minWidth: 0, borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.surface, marginVertical: 10, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderBottomWidth: 1, borderColor: c.line },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: c.soft },
  heading: { flex: 1, minWidth: 0, gap: 4 },
  name: { color: c.text, fontSize: 16, fontWeight: "600" },
  meta: { color: c.muted, fontSize: 13 },
  controls: { padding: 10, gap: 10, minHeight: 64 },
  error: { color: c.danger, fontSize: 13, lineHeight: 20 },
  retry: { color: c.accent, fontSize: 13, paddingVertical: 6 },
});
