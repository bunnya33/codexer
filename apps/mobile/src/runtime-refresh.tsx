import {useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {RefreshCw} from 'lucide-react-native';
import {relay} from './relay';
import {confirmAction} from './runtime';
import {useTheme} from './styles';
import type {SelectedAgent} from './agent-version';

export type RuntimeRefreshDevice = SelectedAgent & {id?: string; runtimeRefresh?: boolean; desktopRestart?: boolean};
type DeviceAction = 'runtime.refresh' | 'desktop.restart';

const restartFailures: Record<string, string> = {
  'desktop-restart-cooldown': '刚刚已发起重启，请稍等几秒再试。',
  'desktop-restart-unavailable': 'Agent 无法访问当前桌面会话中的 Codex。',
  'desktop-restart-launch-failed': '未能打开 Codex 桌面端，请检查这台设备上的 Codex 安装。',
  'desktop-restart-unsupported': '此设备暂不支持重启，请更新 Agent 和服务器。',
};

export function RuntimeRefresh({device}: {device?: RuntimeRefreshDevice}) {
  const {c, s} = useTheme();
  const pending = useRef(false);
  const [busy, setBusy] = useState<DeviceAction>(), [notice, setNotice] = useState<{id: string; text: string; error?: boolean}>();
  const available = !!device?.id && device.online && !busy;
  const refreshEnabled = available && device.runtimeRefresh === true;
  const restartEnabled = available && device.desktopRestart === true;
  const run = async (type: DeviceAction) => {
    const restarting = type === 'desktop.restart';
    if (!(restarting ? restartEnabled : refreshEnabled) || pending.current || !device?.id) return;
    const target = {id: device.id, name: device.name};
    pending.current = true; setBusy(type); setNotice(undefined);
    try {
      const confirmed = restarting
        ? await confirmAction('重启 Codex 桌面端？', `将退出并重新打开“${target.name}”上的 Codex 桌面端。重启可能中断桌面端正在运行的任务。`)
        : await confirmAction('刷新 Codex 运行时？', `将刷新“${target.name}”上的 Codex 后台运行时。有任务运行或等待回复时会延后，切换期间会话状态可能短暂重载。`);
      if (!confirmed) return;
      const result = await relay.sendCommand(target.id, {type});
      if (restarting) {
        if (result.status === 'failed') throw new Error(restartFailures[result.code] ?? '未能重启 Codex 桌面端，请稍后重试。');
        if (result.status !== 'succeeded' || result.result?.desktopRestart !== 'restarted') throw new Error('重启结果未确认，请查看设备状态。');
        setNotice({id: target.id, text: 'Codex 桌面端已重新打开。'});
        return;
      }
      if (result.status !== 'succeeded') throw new Error('刷新未完成，请稍后查看 Agent 状态再重试。');
      const status = result.result?.runtimeRefresh;
      if (!['deferred', 'refreshed', 'unchanged'].includes(String(status))) throw new Error('刷新结果未确认，请查看 Agent 状态。');
      setNotice({id: target.id, text: status === 'deferred' ? '已安排，运行时空闲后自动刷新。' : status === 'refreshed' ? 'Codex 运行时已刷新。' : '已检查运行时，无需切换。'});
    } catch (error) {
      const fallback = restarting ? '重启失败，请稍后重试。' : '刷新失败，请稍后重试。';
      const message = error instanceof Error ? error.message : fallback;
      setNotice({id: target.id, text: restarting ? restartFailures[message] ?? message : message, error: true});
    } finally { pending.current = false; setBusy(undefined); }
  };
  const buttonStyle = {flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 8, borderWidth: 1, borderColor: c.settingsLine, borderRadius: 10, minHeight: 42};
  return <View style={{gap: 10, paddingVertical: 14}}>
    <Text style={{color: c.text, fontSize: 14}}>当前 PC Agent · {device?.name ?? '尚未选择设备'}</Text>
    <Text style={[s.sub, {lineHeight: 21}]}>{!device ? '选择一台电脑后可远程刷新 Codex 运行时。' : !device.online ? 'Agent 离线，暂时无法远程刷新。' : !device.runtimeRefresh ? '此设备暂不支持刷新，请更新 Agent 和服务器。' : '用于 Codex 更新或工具连接异常。任务运行中会等待空闲后切换，保留设备配置和登录。'}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="刷新 Codex 运行时" disabled={!refreshEnabled} onPress={() => void run('runtime.refresh')} style={[buttonStyle, !refreshEnabled && s.disabled]}>
      {busy === 'runtime.refresh' ? <ActivityIndicator size="small" color={c.muted}/> : <RefreshCw size={16} color={c.text}/>}<Text style={{color: c.text}}>刷新 Codex 运行时</Text>
    </Pressable>
    {device?.desktopRestart && <Pressable accessibilityRole="button" accessibilityLabel="重启 Codex 桌面端" disabled={!restartEnabled} onPress={() => void run('desktop.restart')} style={[buttonStyle, !restartEnabled && s.disabled]}>
      {busy === 'desktop.restart' ? <ActivityIndicator size="small" color={c.muted}/> : <RefreshCw size={16} color={c.text}/>}<Text style={{color: c.text}}>重启 Codex 桌面端</Text>
    </Pressable>}
    {notice?.id === device?.id && <Text accessibilityRole={notice?.error ? 'alert' : undefined} style={{color: notice?.error ? c.danger : c.muted, lineHeight: 21}}>{notice?.text}</Text>}
  </View>;
}
