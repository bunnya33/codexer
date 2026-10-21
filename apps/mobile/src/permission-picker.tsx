import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Check } from 'lucide-react-native';
import type { PermissionMode, PermissionSettings } from '../../../packages/protocol/src/index';
import { useTheme } from './styles';

export const permissionLabels = {'read-only': '只读', ask: '请求批准', 'auto-review': '帮我批准', 'full-access': '完全访问', custom: '自定义权限'};
const choices: {mode: PermissionMode; description: string}[] = [
  {mode: 'read-only', description: '仅查看文件，需要修改时请求批准'},
  {mode: 'ask', description: '自动处理工作区内操作，超出范围时请求批准'},
  {mode: 'auto-review', description: '由官方审核代理评估需要批准的操作'},
  {mode: 'full-access', description: '允许访问互联网和电脑上的文件，普通命令不再请求批准'},
];
export function PermissionPicker({settings, enabled, onChange}: {settings: PermissionSettings; enabled: boolean; onChange: (mode: PermissionMode) => Promise<boolean>}) {
  const {s, c} = useTheme();
  const [pending, setPending] = useState(false), [confirmFull, setConfirmFull] = useState(false);
  const sending = useRef(false);
  const change = async (mode: PermissionMode) => {
    if (sending.current || !enabled) return;
    if (mode === 'full-access' && !confirmFull) { setConfirmFull(true); return; }
    sending.current = true; setPending(true);
    try { await onChange(mode); } finally { sending.current = false; setPending(false); setConfirmFull(false); }
  };
  return <View>
    <Text style={s.sub}>当前：{permissionLabels[settings.mode]}</Text>
    {settings.mode === 'custom' && <Text style={s.sub}>访问范围：{settings.sandbox} · 审批：{settings.approval} · 审核：{settings.reviewer}</Text>}
    {choices.map(({mode, description}) => <Pressable key={mode} accessibilityRole="button" accessibilityLabel={`权限：${permissionLabels[mode]}`} disabled={!enabled || pending || settings.mode === mode} style={[s.menuOption, (!enabled || pending) && s.disabled]} onPress={() => void change(mode)}><View style={{flex: 1}}><Text style={s.menuText}>{permissionLabels[mode]}</Text><Text style={s.sub}>{description}</Text></View>{settings.mode === mode && <Check size={18} color={c.accent} />}</Pressable>)}
    {confirmFull && <View style={s.request}><Text style={s.requestText}>后续任务将能够访问这台电脑上的文件和网络。Browser 和 Computer Use 仍保留各自的授权。</Text><Pressable accessibilityRole="button" accessibilityLabel="确认使用完全访问" disabled={!enabled || pending} style={s.primary} onPress={() => void change('full-access')}><Text style={s.primaryText}>确认使用完全访问</Text></Pressable><Pressable accessibilityRole="button" disabled={pending} onPress={() => setConfirmFull(false)}><Text style={s.menuText}>取消</Text></Pressable></View>}
    {!enabled && <Text style={s.sub}>会话空闲且电脑连接后可以更改权限</Text>}
    {pending && <ActivityIndicator color={c.accent} />}
  </View>;
}
