import { useState } from 'react';
import { PreviewShareDialog } from './preview-share-dialog';
import { themedStyles } from './theme';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Music2 } from "lucide-react-native";
import type { FileInfo } from "../../../packages/protocol/src/files";
import { AudioPlayer } from "./audio-player";
import { useAudioPlayback } from "./audio-playback";
import { useTheme } from "./styles";

export function FileAudio({ deviceId, threadId, path, info }: {
  deviceId: string; threadId: string; path: string; info: FileInfo;
}) {
  const { c } = useTheme();
  const as = useAsStyles();
  const scope = JSON.stringify([deviceId, threadId, path]);
  const [sharing, setSharing] = useState<string | null>(null);
  const player = useAudioPlayback(deviceId, threadId, path, info);
  return <View style={as.body}>
    <View style={as.card}>
      <Music2 size={44} color={c.accent} />
      <Text style={as.title}>音频播放器</Text>
      {player.error ? <>
        <Text accessibilityRole="alert" style={as.error}>{player.error}</Text>
        <Text style={as.hint}>也可以使用右上角的下载按钮，保存后播放。</Text>
        <Pressable accessibilityRole="button" onPress={player.start} style={as.retry}>
          <Text style={as.retryText}>重新加载</Text>
        </Pressable>
      </> : player.uri ? <>
        <AudioPlayer key={player.uri} uri={player.uri} onError={player.fail} onEnded={player.stop} />
        <Text style={as.hint}>点击播放，可拖动进度条跳转。</Text>
      </> : player.phase === "loading" ? <ActivityIndicator color={c.accent} accessibilityLabel="正在准备音频" />
        : <Pressable accessibilityRole="button" accessibilityLabel={`加载音频 ${info.name}`} onPress={player.start} style={as.retry}>
          <Text style={as.retryText}>加载音频</Text>
        </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="分享音频" onPress={()=>setSharing(scope)} style={as.share}><Text style={as.shareText}>分享音频</Text></Pressable>
    </View>
    {sharing===scope&&<PreviewShareDialog reference={{kind:'audio',source:path,title:info.name}} deviceId={deviceId} threadId={threadId} onClose={()=>setSharing(null)}/>}
  </View>;
}

const useAsStyles = themedStyles(c => StyleSheet.create({
  body: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20 },
  card: { width: "100%", maxWidth: 560, alignItems: "center", gap: 20, padding: 20, borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.surface },
  title: { color: c.text, fontSize: 19, fontWeight: "600" },
  share: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 6, borderWidth: 1, borderColor: c.line },
  shareText: { color: c.accent, fontSize: 15 },
  hint: { color: c.muted, fontSize: 13, lineHeight: 21, textAlign: "center" },
  error: { color: c.danger, fontSize: 15, lineHeight: 23, textAlign: "center" },
  retry: { borderRadius: 6, paddingVertical: 10, paddingHorizontal: 18, backgroundColor: c.accent },
  retryText: { color: c.onAccent, fontSize: 15 },
}));
