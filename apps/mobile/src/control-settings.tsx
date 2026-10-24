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
import {ClientUpdatePanel} from './client-update-panel';
import {WindowClosePreference} from './client-platform-settings';
import type {SettingsSection} from './settings-shell';

export function ControlSettings({ url, device, onWeixin, onLogout,section='all' }: { url: string; device?: SelectedAgent; onWeixin: () => void; onLogout: () => void;section?:SettingsSection|'all' }) {
  const { c, s } = useTheme();
  const styles = useLocalStyles();
  const [version, setVersion] = useState(''), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if(!['all','connection','about'].includes(section))return;
    const abort = new AbortController();
    setLoading(true); setError(''); setVersion('');
    void relay.serverVersion(abort.signal).then(value => { if (!abort.signal.aborted) setVersion(value); })
      .catch(() => { if (!abort.signal.aborted) setError('读取失败，请重试'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [url, revision,section]);
  const show=(...sections:string[])=>section==='all'||sections.includes(section);
  return <>
    {show('appearance')&&<ThemePicker />}
    {show('general')&&<View style={styles.group}><WindowClosePreference/><Text style={{color:c.muted,lineHeight:22,paddingVertical:14}}>设置仅保存在当前设备。界面外观在“外观”中选择，客户端升级在“更新与下载”中管理。</Text></View>}
    {show('updates')&&<ClientUpdatePanel/>}
    {show('updates')&&<AgentDownload url={url}/>}
    {show('connection','about')&&<>
    <Text style={styles.label}>连接</Text>
    <View style={styles.group}><Text selectable style={styles.address}>{url}</Text></View>
    <View style={styles.sectionHeader}><Text style={styles.label}>版本信息</Text><Pressable accessibilityRole="button" accessibilityLabel="刷新版本信息" disabled={loading} onPress={() => setRevision(value => value + 1)} style={s.iconButton}><RefreshCw size={16} color={c.muted} /></Pressable></View>
    <View style={styles.group}>
      <View style={styles.row}><Text style={styles.name}>服务器版本</Text>{loading ? <ActivityIndicator size="small" color={c.muted} /> : <Text selectable style={styles.value}>{version || error}</Text>}</View>
      <View style={[styles.row, styles.divider]}><Text style={styles.name}>控制端版本 · {controlPlatform}</Text><Text selectable style={styles.value}>{controlVersion}</Text></View>
      <View style={[styles.agent, styles.divider]}><AgentVersion device={device} /></View>
    </View>
    </>}
    {show('overview','general')&&<View style={styles.group}>
      {section==='all'&&<Pressable accessibilityRole="button" accessibilityLabel="微信 ClawBot" onPress={onWeixin} style={styles.row}><MessageCircle size={19} color={c.text} /><Text style={[styles.name, styles.grow]}>微信 ClawBot</Text><ChevronRight size={18} color={c.muted} /></Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="退出登录" onPress={onLogout} style={[styles.row,section==='all'&&styles.divider]}><LogOut size={19} color={c.danger} /><Text style={s.dangerText}>退出登录</Text></Pressable>
    </View>}
  </>;
}
const useLocalStyles = themedStyles(c => StyleSheet.create({
  label: { fontSize: 12, color: c.muted }, sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: -8 },
  group: { borderRadius: 16, backgroundColor: c.surface, paddingHorizontal: 14, overflow: 'hidden' }, address: { color: c.muted, fontSize: 13, paddingVertical: 15 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 }, divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.settingsLine },
  name: { fontSize: 14, color: c.text, flexShrink: 1 }, value: { color: c.muted, fontSize: 13, flex: 1, textAlign: 'right' }, grow: { flex: 1 },
  agent: { paddingVertical: 14 },
}));
