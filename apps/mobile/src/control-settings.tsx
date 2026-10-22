import { themedStyles } from './theme';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, LogOut, MessageCircle, RefreshCw } from 'lucide-react-native';
import { controlPlatform, controlVersion } from './build-info';
import { relay } from './relay';
import { useTheme } from './styles';
import { ThemePicker } from './theme-picker';
import { AgentDownload } from './agent-download';
import { AgentVersion } from './agent-version';
import type { SelectedAgent } from './agent-version';

export function ControlSettings({ url, device, onWeixin, onLogout }: { url: string; device?: SelectedAgent; onWeixin: () => void; onLogout: () => void }) {
  const { c, s } = useTheme();
  const styles = useLocalStyles();
  const [version, setVersion] = useState(''), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(''); setVersion('');
    void relay.serverVersion(abort.signal).then(value => { if (!abort.signal.aborted) setVersion(value); })
      .catch(() => { if (!abort.signal.aborted) setError('读取失败，请重试'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [url, revision]);
  return <>
    <ThemePicker />
    <AgentDownload url={url}/>
    <Text style={styles.label}>连接</Text>
    <View style={styles.group}><Text selectable style={styles.address}>{url}</Text></View>
    <View style={styles.sectionHeader}><Text style={styles.label}>版本信息</Text><Pressable accessibilityRole="button" accessibilityLabel="刷新版本信息" disabled={loading} onPress={() => setRevision(value => value + 1)} style={s.iconButton}><RefreshCw size={16} color={c.muted} /></Pressable></View>
    <View style={styles.group}>
      <View style={styles.row}><Text style={styles.name}>服务器版本</Text>{loading ? <ActivityIndicator size="small" color={c.muted} /> : <Text selectable style={styles.value}>{version || error}</Text>}</View>
      <View style={[styles.row, styles.divider]}><Text style={styles.name}>控制端版本 · {controlPlatform}</Text><Text selectable style={styles.value}>{controlVersion}</Text></View>
      <View style={[styles.agent, styles.divider]}><AgentVersion device={device} /></View>
    </View>
    <View style={styles.group}>
      <Pressable accessibilityRole="button" accessibilityLabel="微信 ClawBot" onPress={onWeixin} style={styles.row}><MessageCircle size={19} color={c.text} /><Text style={[styles.name, styles.grow]}>微信 ClawBot</Text><ChevronRight size={18} color={c.muted} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="退出登录" onPress={onLogout} style={[styles.row, styles.divider]}><LogOut size={19} color={c.danger} /><Text style={s.dangerText}>退出登录</Text></Pressable>
    </View>
  </>;
}
const useLocalStyles = themedStyles(c => StyleSheet.create({
  label: { fontSize: 12, color: c.muted }, sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: -8 },
  group: { borderRadius: 16, backgroundColor: c.settingsGroup, paddingHorizontal: 14, overflow: 'hidden' }, address: { color: c.muted, fontSize: 13, paddingVertical: 15 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 }, divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.settingsLine },
  name: { fontSize: 14, color: c.text, flexShrink: 1 }, value: { color: c.muted, fontSize: 13, flex: 1, textAlign: 'right' }, grow: { flex: 1 },
  agent: { paddingVertical: 14 },
}));
