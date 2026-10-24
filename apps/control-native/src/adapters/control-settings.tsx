import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Switch, Text, View } from 'react-native';
import { relay } from '../../../mobile/src/relay';
import { useTheme } from '../../../mobile/src/styles';
import { ThemePicker } from '../../../mobile/src/theme-picker';
import { controlVersion, controlPlatform } from './build-info';
import { request, subscribe } from '../bridge';
import { AgentDownload } from '../../../mobile/src/agent-download';
import { AgentVersion } from '../../../mobile/src/agent-version';
import type { SelectedAgent } from '../../../mobile/src/agent-version';

export function WindowClosePreference() {
  const { c } = useTheme();
  const [closeExits, setCloseExits] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<{closeExits: boolean}>('preferences.read').then(value => { if (active) setCloseExits(value.closeExits); }).catch(() => { if (active) setError('设置读取失败，请重试'); });
    const off = subscribe('preferences', value => setCloseExits(value.closeExits));
    return () => { active = false; off(); };
  }, []);
  return <View style={{ gap: 8 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
    <View style={{ flex: 1, gap: 6 }}><Text style={{ color: c.text }}>关闭窗口时退出进程</Text>
      <Text style={{ fontSize: 12, color: c.muted }}>默认缩小到托盘。启用后，每次退出均需确认。</Text></View>
    <Switch accessibilityLabel="关闭窗口时退出进程" value={closeExits} trackColor={{ true: c.accent }} onValueChange={value => {
      void request('preferences.save', { closeExits: value }).then(() => { setCloseExits(value); setError(''); }).catch(() => setError('设置保存失败，请重试'));
    }} /></View>{!!error && <Text accessibilityRole="alert" style={{ color: c.danger }}>{error}</Text>}</View>;
}

export function ControlSettings({ url, device, onWeixin, onLogout }: {url: string; device?: SelectedAgent; onWeixin: () => void; onLogout: () => void}) {
  const { c } = useTheme();
  const [version, setVersion] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    void relay.serverVersion(abort.signal).then(value => { if (!abort.signal.aborted) setVersion(value); })
      .catch(() => { if (!abort.signal.aborted) setVersion('读取失败'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [url]);
  return <View style={{ gap: 20 }}><ThemePicker /><Text selectable style={{ color: c.muted }}>{url}</Text>
    <View style={{ gap: 12, padding: 16, backgroundColor: c.settingsGroup, borderRadius: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Text style={{ color: c.text }}>服务器版本：{loading ? '正在读取…' : version}</Text>{loading && <ActivityIndicator color={c.muted} />}</View>
      <Text style={{ color: c.text }}>Codexer Control {controlPlatform} · {controlVersion}</Text>
      <AgentVersion device={device} /></View>
    <WindowClosePreference />
    <AgentDownload url={url}/>
    <Pressable accessibilityRole="button" onPress={onWeixin} style={{ padding: 14 }}><Text style={{ color: c.text }}>微信 ClawBot</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={onLogout} style={{ padding: 14 }}><Text style={{ color: c.danger }}>退出登录</Text></Pressable>
  </View>;
}
