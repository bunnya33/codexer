import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronRight, FilePenLine, SquareTerminal } from 'lucide-react-native';
import { ShimmerLabel } from '../shimmer';
import { TaskStatusDot } from '../task-status-dot';
import { useTheme } from '../styles';
import { useInteractionMotion } from './motion';
import type { ConversationPhase } from './conversation-chrome';

export function ChromeActivity({ phase, elapsed, tokens, cost }: { phase: ConversationPhase; elapsed: number; tokens: number; cost: string }) {
  const { c } = useTheme();
  const motion = useInteractionMotion();
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState(false);
  const [mounted, setMounted] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const running = phase === 'running';
  useEffect(() => {
    if (open) setMounted(true);
    const animation = Animated.timing(progress, { toValue: open ? 1 : 0, duration: motion ? 220 : 0, useNativeDriver: false });
    animation.start(({ finished }) => { if (finished && !open) setMounted(false); });
    return () => animation.stop();
  }, [open, motion, progress]);
  return <View style={{ gap: 9 }}>
    <View style={styles.status}>{running ? <ActivityIndicator size="small" color={c.muted} /> : <Check size={15} color={phase === 'completed' ? c.success : c.muted} />}
      <Text style={[styles.secondary, { color: c.muted }]}>{running ? '已运行' : phase === 'interrupted' ? '已暂停' : '已处理'} {Math.floor(elapsed / 60) ? `${Math.floor(elapsed / 60)} 分 ` : ''}{elapsed % 60} 秒</Text>
    </View>
    <View style={{ height: 1, backgroundColor: c.line, marginBottom: 2 }} />
    <Pressable accessibilityRole="button" accessibilityLabel={`${open ? '收起' : '展开'}处理记录`} accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={styles.summary}>
      <FilePenLine size={15} color={c.muted} />
      {running && motion ? <ShimmerLabel text="正在调整卡片布局与照片预览" /> : <Text numberOfLines={1} style={[styles.secondary, { color: c.muted }]}>{running ? '正在调整卡片布局与照片预览' : phase === 'interrupted' ? '已编辑首页，任务已暂停' : '已编辑 2 个文件，运行 1 条命令'}</Text>}
      <Animated.View style={{ transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] }) }] }}><ChevronRight size={14} color={c.muted} /></Animated.View>
    </Pressable>
    {mounted && <Animated.View pointerEvents={open ? 'auto' : 'none'} accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'} style={{ height: progress.interpolate({ inputRange: [0, 1], outputRange: [0, command ? 212 : 116] }), opacity: progress, overflow: 'hidden', marginLeft: 20, borderLeftWidth: 1, borderLeftColor: c.subtleLine }}>
      <ScrollView nestedScrollEnabled contentContainerStyle={{ paddingLeft: 12, gap: 8, paddingVertical: 5 }}>
        {['读取 src/screens/Home.tsx', '编辑 src/components/PhotoCard.tsx'].map(label => <View key={label} style={styles.summary}><FilePenLine size={14} color={c.muted} /><Text style={[styles.secondary, { color: c.muted }]}>{label}</Text></View>)}
        <Pressable accessibilityRole="button" accessibilityLabel="查看检查命令" onPress={() => setCommand(value => !value)} style={styles.summary}><SquareTerminal size={14} color={c.muted} /><Text style={[styles.secondary, { color: c.muted }]}>运行 npm run typecheck</Text><ChevronRight size={13} color={c.muted} /></Pressable>
        {command && <View style={{ backgroundColor: c.code, borderRadius: 10, padding: 12, gap: 7 }}><Text selectable style={[styles.code, { color: c.text }]}>$ npm run typecheck</Text><Text selectable style={[styles.code, { color: c.muted }]}>tsc --noEmit{ '\n' }检查通过 · exit code 0</Text></View>}
      </ScrollView>
    </Animated.View>}
    <View style={styles.tokens}>{running && <TaskStatusDot running label="任务进行中" />}<Text testID="chrome-token-usage" style={{ color: c.muted, fontSize: 11, lineHeight: 18 }}>输入 {tokens.toLocaleString()} · 输出 {Math.floor(tokens / 4).toLocaleString()} · 缓存 {Math.min(2048, tokens).toLocaleString()} · {cost}</Text></View>
    {phase === 'completed' && <Text style={{ color: c.timestamp, fontSize: 11 }}>16:25 · 已完成</Text>}
  </View>;
}

const styles = StyleSheet.create({
  status: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 24 }, secondary: { fontSize: 12, lineHeight: 19, flexShrink: 1 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 }, tokens: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  code: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 18 },
});
