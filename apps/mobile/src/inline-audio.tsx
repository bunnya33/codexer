import { useState } from 'react';
import { PreviewShareDialog } from './preview-share-dialog';
import { themedStyles } from './theme';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Music2, Video } from "lucide-react-native";
import type { MediaKind, MediaReference } from "../../../packages/client-shared/src/audio";
import { fileName, fileSize } from "../../../packages/client-shared/src/file-links";
import { AudioPlayer } from "./audio-player";
import { useFileLink } from "./file-link-context";
import { useMediaPlayback } from "./audio-playback";
import { useTheme } from "./styles";

export function InlineMedia({ kind, reference, deviceId, threadId }: {
  kind: MediaKind; reference: MediaReference; deviceId: string; threadId: string;
}) {
  const { c } = useTheme();
  const as = useAsStyles();
  const scope = JSON.stringify([deviceId, threadId, reference.source]);
  const [sharing, setSharing] = useState<string | null>(null);
  const openFile = useFileLink();
  const player = useMediaPlayback(kind, deviceId, threadId, reference.source);
  const label = kind === "video" ? "视频" : "音频";
  const Icon = kind === "video" ? Video : Music2;
  const name = player.info?.name ?? fileName(reference.source);
  const format = name.split(".").at(-1)?.toUpperCase();
  return <View style={as.card} accessibilityLabel={`${label} ${reference.title}`}>
    <View style={as.header}>
      <View style={as.icon}><Icon size={24} color={c.accent} /></View>
      <View style={as.heading}>
        <Text style={as.name} numberOfLines={2}>{name}</Text>
        <Text style={as.meta}>{format} {label}{player.info ? ` · ${fileSize(player.info.size)}` : ""}</Text>
      </View>
      {kind === "audio"
        ? <Pressable accessibilityRole="button" accessibilityLabel="分享音频" onPress={() => setSharing(scope)} style={as.share}><Text style={as.retry}>分享</Text></Pressable>
        : openFile && <Pressable accessibilityRole="button" onPress={() => { player.stop(); openFile(reference.source); }} style={as.share}><Text style={as.retry}>打开文件</Text></Pressable>}
    </View>
    <View style={as.controls}>
      {player.error ? <>
        <Text accessibilityRole="alert" style={as.error}>{player.error}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`重新加载${label}`} onPress={player.start}>
          <Text style={as.retry}>重新加载</Text>
        </Pressable>
      </> : player.uri ? <AudioPlayer kind={kind} key={player.uri} uri={player.uri} onError={player.fail} onEnded={player.stop} />
        : player.phase === "loading" ? <ActivityIndicator color={c.accent} accessibilityLabel={`正在准备${label}`} />
        : <Pressable accessibilityRole="button" accessibilityLabel={`加载${label} ${name}`} onPress={player.start}>
          <Text style={as.retry}>加载{label}</Text>
        </Pressable>}
    </View>
    {kind === "audio" && sharing===scope&&<PreviewShareDialog reference={{kind:'audio',source:reference.source,title:name}} deviceId={deviceId} threadId={threadId} onClose={()=>setSharing(null)}/>}
  </View>;
}

const useAsStyles = themedStyles(c => StyleSheet.create({
  card: { width: "100%", maxWidth: 736, minWidth: 0, borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.surface, marginVertical: 10, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderBottomWidth: 1, borderColor: c.line },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: c.soft },
  heading: { flex: 1, minWidth: 0, gap: 4 },
  name: { color: c.text, fontSize: 16, fontWeight: "600" },
  meta: { color: c.muted, fontSize: 13 },
  share: { padding: 6 },
  controls: { padding: 10, gap: 10, minHeight: 64 },
  error: { color: c.danger, fontSize: 13, lineHeight: 20 },
  retry: { color: c.accent, fontSize: 13, paddingVertical: 6 },
}));
