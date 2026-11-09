import { createContext, useContext, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Check, Circle, Copy, Download, ListChecks, Maximize2 } from 'lucide-react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import type { RemoteItem } from '../../../packages/protocol/src/index';
import { useTheme } from './styles';
import { Markdown } from './markdown';
import { copyText } from './runtime';
import { exportText } from './export-text';
import { ChromeButton } from './interaction/primitives';
import { ReviewReader } from './review-reader';
import { FileLinkContext } from './file-link-context';
import { historyKey, relay } from './relay';

export type PreparedPlan = { turnId: string; itemId: string; title: string; text: string };
export const PlanPreparationContext = createContext<((plan: PreparedPlan) => void) | undefined>(undefined);
export function completePlan(item: RemoteItem, turnStatus: string) {
  return item.type === 'plan' && !!item.text?.trim() && !item.truncated && (item.status === 'completed' || turnStatus === 'completed' && !['inProgress', 'failed', 'interrupted', 'cancelled'].includes(item.status ?? ''));
}
export function planTitle(item: RemoteItem) {
  return (item.text ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/^#{1,6}\s*/, '').slice(0, 100) || '实施方案';
}

export function PlanCard({ item, turnId, turnStatus, deviceId, threadId }: { item: RemoteItem; turnId: string; turnStatus: string; deviceId: string; threadId: string }) {
  const { c } = useTheme(), prepare = useContext(PlanPreparationContext);
  const [open, setOpen] = useState(false), [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(false), loadLock = useRef(false);
  const card=useRef<View>(null);
  const text = item.text ?? '', summary = text.replace(/^\s*#{1,6}\s+[^\n]*\n?/, ''), title = planTitle(item), ready = completePlan(item, turnStatus);
  const generated = item.status === 'inProgress' || turnStatus === 'inProgress' && item.status !== 'completed';
  const act = async (action: () => Promise<unknown>, success: string) => { try { await action(); setFeedback(success); } catch { setFeedback('操作失败，请重试。'); } };
  const copy = () => void act(() => copyText(text), generated ? '已复制当前生成内容' : '已复制方案');
  const save = () => void act(() => exportText(`${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}${generated ? '-生成中' : ''}.md`, generated ? `> 当前生成内容，尚未完成。\n\n${text}` : text, 'text/markdown'), '已交给系统保存或分享');
  const controls = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><ChromeButton Icon={Copy} label="复制方案" onPress={copy} disabled={!text || !!item.truncated} size={17} /><ChromeButton Icon={Download} label="导出方案" onPress={save} disabled={!text || !!item.truncated} size={17} /></View>;
  const execute = <Pressable accessibilityRole="button" accessibilityLabel="执行此方案" disabled={!ready || !prepare} onPress={() => { if (ready) { prepare?.({ turnId, itemId: item.id, title, text }); setOpen(false); } }} style={{ alignSelf:'flex-end', borderWidth: 1, borderColor: c.line, borderRadius: 22, paddingHorizontal: 18, paddingVertical: 11, alignItems: 'center', opacity: ready && prepare ? 1 : .4 }}><Text style={{ color: c.text, fontSize: 13, fontWeight: '600' }}>执行此方案</Text></Pressable>;
  const limitation = item.truncated ? '方案内容已截断，暂不能执行、复制或导出完整方案。请刷新会话加载历史；仍不完整时需在 PC 查看。' : generated ? '方案正在生成，可阅读当前内容，完成后可准备执行。' : !ready ? '方案尚未完整完成，仅供阅读。' : '';
  const load = async () => {
    if (loadLock.current) return;
    loadLock.current = true; setLoading(true);
    try {
      await relay.loadHistory(deviceId, threadId);
      const history = relay.getSnapshot().histories[historyKey(deviceId, threadId)];
      const full = history?.turns.find(turn => turn.id === turnId)?.items.find(candidate => candidate.id === item.id);
      setFeedback(history?.loading ? '历史正在同步，请稍后重试。' : history?.error ? `读取失败：${history.error}` : full?.text && !full.truncated ? '已加载完整方案' : '当前历史仍未提供完整方案，请在 PC 查看。');
    } catch { setFeedback('方案读取失败，请重试。'); }
    finally { loadLock.current = false; setLoading(false); }
  };
  const reload = item.truncated && <Pressable accessibilityRole="button" accessibilityLabel="重新读取完整方案" disabled={loading} onPress={() => void load()} style={{ paddingVertical: 8 }}><Text style={{ color:c.accent,fontSize:12 }}>{loading ? '正在读取方案…' : '重新读取完整方案'}</Text></Pressable>;
  return <View ref={card} collapsable={false} testID="plan-review-card" style={{ backgroundColor: c.composer, padding: 18, gap: 12, borderRadius: 20, marginVertical: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><ListChecks size={18} color={c.muted} /><Text style={{ color: c.muted, fontSize: 12, flex: 1 }}>计划</Text>{controls}</View>
    <Text accessibilityRole="header" style={{ color: c.text, fontSize: 18, lineHeight: 26, fontWeight: '600' }}>{title}</Text>
    <View style={{ maxHeight: 156, overflow: 'hidden' }}><Markdown>{summary}</Markdown><View pointerEvents="none" style={{ position: 'absolute', bottom: 0, height: 48, left: 0, right: 0 }}><Svg width="100%" height="100%"><Defs><LinearGradient id={`plan-fade-${item.id}`} x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={c.composer} stopOpacity="0" /><Stop offset="1" stopColor={c.composer} stopOpacity="1" /></LinearGradient></Defs><Rect width="100%" height="100%" fill={`url(#plan-fade-${item.id})`} /></Svg></View></View>
    <Pressable accessibilityRole="button" accessibilityLabel="阅读全文方案" onPress={() => setOpen(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6 }}><Maximize2 size={15} color={c.muted} /><Text style={{ color: c.text, fontSize: 13 }}>阅读全文</Text></Pressable>
    {!!limitation && <Text style={{ color: c.muted, fontSize: 12, lineHeight: 19 }}>{limitation}</Text>}{reload}{execute}
    {!!feedback && !open && <Text accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 12 }}>{feedback}</Text>}
    <ReviewReader open={open} onClose={() => setOpen(false)} title="完整方案" origin={card} desktopWidth={860}>
      <View style={{ flexDirection: 'row', padding: 12, gap: 10, alignItems: 'center' }}>{controls}<View style={{ flex: 1 }} />{execute}</View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 12 }}><FileLinkContext.Provider value={undefined}><Markdown>{text}</Markdown></FileLinkContext.Provider>{!!limitation && <Text style={{ color: c.muted, fontSize: 12 }}>{limitation}</Text>}{reload}{!!feedback && <Text accessibilityLiveRegion="polite" style={{ color: c.muted }}>{feedback}</Text>}</ScrollView>
    </ReviewReader>
  </View>;
}

export function ExecutionPlan({ steps }: { steps: { step: string; status: string }[] }) {
  const { c } = useTheme();
  if (!steps.length) return null;
  return <View testID="execution-plan" style={{ paddingVertical: 12, gap: 9 }}><Text style={{ color: c.muted, fontSize: 12 }}>执行步骤</Text>{steps.map((step, index) => <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>{step.status === 'completed' ? <Check size={16} color={c.success} /> : <Circle size={15} color={step.status === 'inProgress' || step.status === 'in_progress' ? c.accent : c.faint} fill={step.status === 'inProgress' || step.status === 'in_progress' ? c.accent : 'transparent'} />}<Text selectable style={{ color: step.status === 'completed' ? c.muted : c.text, flex: 1, fontSize: 13, lineHeight: 19 }}>{step.step}</Text></View>)}</View>;
}
