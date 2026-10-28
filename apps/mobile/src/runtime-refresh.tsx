import {useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {RefreshCw} from 'lucide-react-native';
import {relay} from './relay';
import {confirmAction} from './runtime';
import {useTheme} from './styles';
import type {SelectedAgent} from './agent-version';

export type RuntimeRefreshDevice = SelectedAgent & {id?: string; runtimeRefresh?: boolean};

export function RuntimeRefresh({device}: {device?: RuntimeRefreshDevice}) {
  const {c, s} = useTheme();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<{id: string; text: string; error?: boolean}>();
  const enabled = !!device?.id && device.online && device.runtimeRefresh === true && !busy;
  const refresh = async () => {
    if (!enabled || pending.current || !device?.id) return;
    const target = {id: device.id, name: device.name};
    pending.current = true; setBusy(true); setNotice(undefined);
    try {
      if (!await confirmAction('刷新 Codex 运行时？', `将刷新“${target.name}”上的 Codex 后台运行时。有任务运行或等待回复时会延后，切换期间会话状态可能短暂重载。`)) return;
      const result = await relay.sendCommand(target.id, {type: 'runtime.refresh'});
      if (result.status !== 'succeeded') throw new Error('刷新未完成，请稍后查看 Agent 状态再重试。');
      const status = result.result?.runtimeRefresh;
      if (!['deferred', 'refreshed', 'unchanged'].includes(String(status))) throw new Error('刷新结果未确认，请查看 Agent 状态。');
      setNotice({id: target.id, text: status === 'deferred' ? '已安排，运行时空闲后自动刷新。' : status === 'refreshed' ? 'Codex 运行时已刷新。' : '已检查运行时，无需切换。'});
    } catch (error) { setNotice({id: target.id, text: error instanceof Error ? error.message : '刷新失败，请稍后重试。', error: true}); }
    finally { pending.current = false; setBusy(false); }
  };
  return <View style={{gap: 10, paddingVertical: 14}}>
    <Text style={{color: c.text, fontSize: 14}}>当前 PC Agent · {device?.name ?? '尚未选择设备'}</Text>
    <Text style={[s.sub, {lineHeight: 21}]}>{!device ? '选择一台电脑后可远程刷新 Codex 运行时。' : !device.online ? 'Agent 离线，暂时无法远程刷新。' : !device.runtimeRefresh ? '此设备暂不支持刷新，请更新 Agent 和服务器。' : '用于 Codex 更新或工具连接异常。任务运行中会等待空闲后切换，保留设备配置和登录。'}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="刷新 Codex 运行时" disabled={!enabled} onPress={() => void refresh()} style={[{flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: c.settingsLine, borderRadius: 10, minHeight: 42}, !enabled && s.disabled]}>
      {busy ? <ActivityIndicator size="small" color={c.muted}/> : <RefreshCw size={16} color={c.text}/>}<Text style={{color: c.text}}>刷新 Codex 运行时</Text>
    </Pressable>
    {notice?.id === device?.id && <Text accessibilityRole={notice?.error ? 'alert' : undefined} style={{color: notice?.error ? c.danger : c.muted, lineHeight: 21}}>{notice?.text}</Text>}
  </View>;
}
