import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Check } from 'lucide-react-native';
import type { PermissionMode, PermissionSettings } from '../../../../packages/protocol/src/index';
import { useTheme } from '../styles';
import { chromePermissionLabels, PermissionSymbol } from './control-symbols';

const choices = [
  { mode: 'ask', description: '自动处理工作区内操作，超出范围时请求批准' },
  { mode: 'auto-review', description: '由官方审核代理评估需要批准的操作' },
  { mode: 'full-access', description: '完全访问计算机（风险较高）' },
  { mode: 'read-only', description: '仅查看文件，需要修改时请求批准' },
] as const;

export function ChromePermissionPanel({ mode, onChange, disabled = false, settings, labelPrefix = '' }: { mode: PermissionSettings['mode']; onChange: (mode: PermissionMode) => void; disabled?: boolean; settings?: PermissionSettings; labelPrefix?: string }) {
  const { c, theme } = useTheme();
  const [confirm, setConfirm] = useState(false);
  const [help, setHelp] = useState(false);
  return <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
    {confirm ? <View style={{ padding: 13, gap: 17 }}>
      <PermissionSymbol mode="full-access" size={28} /><Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>允许完全访问？</Text>
      <Text style={{ color: c.muted, fontSize: 14, lineHeight: 22 }}>任务将能够访问这台电脑上的文件和网络。Browser 和 Computer Use 保留各自的授权。</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="确认使用完全访问" disabled={disabled} onPress={() => onChange('full-access')} style={{ minHeight: 45, opacity: disabled ? .4 : 1, backgroundColor: c.solid, alignItems: 'center', justifyContent: 'center', borderRadius: 23 }}><Text style={{ color: c.onSolid, fontSize: 14, fontWeight: '600' }}>确认使用完全访问</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => setConfirm(false)} style={{ minHeight: 40, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.text }}>取消</Text></Pressable>
    </View> : <View style={{ paddingTop: 8, paddingBottom: 3 }}>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '500', textAlign: 'center' }}>应如何批准 Codex 操作？</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="了解权限说明" onPress={() => setHelp(!help)} style={{ alignSelf: 'center', minHeight: 36, justifyContent: 'center', marginBottom: 10 }}><Text style={{ color: c.accent, fontSize: 14 }}>了解更多</Text></Pressable>
      {help && <Text style={{ color: c.muted, fontSize: 13, lineHeight: 20, paddingBottom: 15 }}>权限决定文件、网络和审批的范围。选择后将应用到当前会话；Browser 和 Computer Use 保留各自的授权。</Text>}
      {mode === 'custom' && settings && <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18, paddingBottom: 12 }}>当前为自定义权限：{settings.sandbox} · {settings.approval} · {settings.reviewer}</Text>}
      <View style={{ borderRadius: 28, backgroundColor: theme.dark ? c.composer : '#f8f8f8', overflow: 'hidden' }}>{choices.map((choice, index) => <View key={choice.mode}>
        {!!index && <View style={{ height: .5, backgroundColor: c.line, marginLeft: 52 }} />}
        <Pressable accessibilityRole="button" accessibilityLabel={labelPrefix + chromePermissionLabels[choice.mode]} disabled={disabled || mode === choice.mode} accessibilityState={{ selected: mode === choice.mode, disabled }} onPress={() => choice.mode === 'full-access' ? setConfirm(true) : onChange(choice.mode)} style={{ flexDirection: 'row', gap: 14, alignItems: 'center', padding: 16, minHeight: 78, opacity: disabled ? .5 : 1 }}>
          <PermissionSymbol mode={choice.mode} size={22} /><View style={{ flex: 1, gap: 3 }}><Text style={{ color: choice.mode === 'full-access' ? '#e85d00' : c.text, fontSize: 16 }}>{chromePermissionLabels[choice.mode]}</Text><Text style={{ color: choice.mode === 'full-access' ? '#e85d00' : c.muted, fontSize: 13, lineHeight: 18 }}>{choice.description}</Text></View>
          {mode === choice.mode && <Check size={18} color={c.text} strokeWidth={2} />}
        </Pressable>
      </View>)}</View>
    </View>}
  </ScrollView>;
}
