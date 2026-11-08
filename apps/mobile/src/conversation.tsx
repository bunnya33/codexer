import { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Bot, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Pencil, Sparkles, Terminal } from 'lucide-react-native';
import { activityLabel, activitySections, buildActivityBlocks, executionItemSummary, executionSectionSummary, formatDuration, itemDuration, messageRole } from '../../../packages/client-shared/src/activity';
import type { ExecutionSection } from '../../../packages/client-shared/src/activity';
import type { HistoryTurn, RemoteItem } from '../../../packages/protocol/src/index';
import { userPresentation } from '../../../packages/protocol/src/user-presentation';
import { relay } from './relay';
import { Markdown } from './markdown';
import { RelayImage } from './relay-image';
import { CodeBlock } from './code-block';
import { copyText } from './runtime';
import { useTheme } from './styles';
import { ShimmerLabel } from './shimmer';
import { DrawerSwipeBlock } from './drawer-swipe-block';
import { FileChangesPanel } from './file-review';
import { localAudioPath, stripInlineImageReferences } from '../../../packages/client-shared/src/audio';
import { TurnEndTime, TurnTiming } from './turn-timing';
import { recordedTurnTiming } from '../../../packages/client-shared/src/turn-timing';
import { turnCostLabel } from '../../../packages/client-shared/src/project-usage';
import { TaskStatusDot } from './task-status-dot';
import { useInteractionMotion } from './interaction/motion';
import { PlanCard, ExecutionPlan } from './plan-review';

type ImageSource = { uri: string; headers?: Record<string, string> };
type ImageViewer = (source: ImageSource, name: string) => void;

function ExecutionIcon({ item }: { item?: RemoteItem }) {
  const { c } = useTheme();
  const Icon = item?.subAgents?.length ? Bot : !item || item.type === 'reasoning' ? Sparkles : item.files?.length || item.type === 'fileChange' ? Pencil : Terminal;
  return <Icon size={14} color={c.muted} />;
}

function Message({ item, running = false, deviceId, threadId, onImage }: { item: RemoteItem; running?: boolean; deviceId: string; threadId: string; onImage: ImageViewer }) {
  const { c, s } = useTheme();
  const role = messageRole(item);
  const [open, setOpen] = useState(false);
  const images = (item.images ?? []).filter(image => !image.source || !localAudioPath(image.source));
  const imageSources = images.flatMap(image => image.source ? [image.source] : []);
  const presentation = role === 'user' ? userPresentation(item.text ?? '') : null;
  const body = presentation?.body ?? item.text ?? '';
  const parts = role === 'user' ? item.userMessageParts ?? presentation?.parts : undefined;
  const display = stripInlineImageReferences(body, imageSources);
  if (role) {
    if (!body && !images.length && !item.files?.length) return null;
    return <View style={[s.message, role === 'user' ? s.userMessage : s.agentMessage]}>
      {parts?.length ? <View style={s.replyParts}>{parts.map((part, index) => part.type === 'questionAnswer'
        ? <View key={index} style={s.replyPair}><Text selectable style={s.replyQuestion}>{part.question}</Text><Text selectable style={s.replyAnswer}>{part.answer}</Text></View>
        : <Markdown key={index}>{stripInlineImageReferences(part.text, imageSources)}</Markdown>)}</View> : !!display && <Markdown>{display}</Markdown>}
      {!!images.length && <DrawerSwipeBlock style={s.imageRow}>{images.map(image => <Pressable key={image.id} accessibilityRole="button" accessibilityLabel={`查看图片 ${image.name}`} onPress={() => onImage(relay.imageSource(deviceId, threadId, image.id), image.name)}><RelayImage source={relay.imageSource(deviceId, threadId, image.id)} resizeMode="cover" style={s.image} /></Pressable>)}</DrawerSwipeBlock>}
      {!!item.files?.length && <Text style={s.fileNames}>{item.files.join(' · ')}</Text>}
      {!!display && <Pressable accessibilityRole="button" accessibilityLabel="复制消息" style={[s.iconButton, { alignSelf: role === 'user' ? 'flex-end' : 'flex-start', width: 30, height: 28 }]} onPress={() => void copyText(display).catch(() => relay.showNotice('复制失败，请选择文字手动复制'))}><Copy size={14} color={c.muted} /></Pressable>}
    </View>;
  }
  const title = executionItemSummary(item, running);
  const ToggleIcon = open ? ChevronUp : ChevronDown;
  return <View style={s.tool}>
    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${title}，${open ? '收起' : '展开'}详情`} onPress={() => setOpen(!open)} style={s.toolHead}><ExecutionIcon item={item} /><Text style={s.toolTitle} numberOfLines={1}>{title}</Text>{itemDuration(item) !== undefined && <Text style={s.toolTime}>{formatDuration(itemDuration(item)!)}</Text>}<ToggleIcon size={13} color={c.muted} /></Pressable>
    {open && <View style={s.toolBody}>{!!item.text && <Markdown>{item.text}</Markdown>}{!!item.command && <CodeBlock language="命令">{item.command}</CodeBlock>}{!!item.output && <CodeBlock language="输出">{item.output}</CodeBlock>}{!!item.files?.length && <Text style={s.fileNames}>{item.files.join('\n')}</Text>}</View>}
  </View>;
}

function ExecutionGroup({ section, deviceId, threadId, onImage }: { section: ExecutionSection; deviceId: string; threadId: string; onImage: ImageViewer }) {
  const { c, s } = useTheme();
  const motion = useInteractionMotion();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const height = useRef(new Animated.Value(0)).current;
  const rotation = useRef(new Animated.Value(0)).current;
  const listHeight = Math.min(contentHeight || 260, 260);
  useEffect(() => {
    const animation = Animated.timing(rotation, {toValue: open ? 1 : 0, duration: motion ? 240 : 0, easing: Easing.inOut(Easing.cubic), useNativeDriver: Platform.OS !== 'web'});
    animation.start();
    return () => animation.stop();
  }, [open, rotation, motion]);
  useEffect(() => {
    if (open) setMounted(true);
    const animation = Animated.timing(height, {toValue: open ? Math.min(contentHeight, 260) : 0, duration: motion ? 240 : 0, easing: Easing.inOut(Easing.cubic), useNativeDriver: false});
    animation.start(({finished}) => { if (finished && !open) setMounted(false); });
    return () => animation.stop();
  }, [open, contentHeight, height, motion]);
  const latest = section.items.at(-1);
  const title = executionSectionSummary(section);
  const iconItem = section.running ? latest : [...section.items].reverse().find(item => item.type !== 'reasoning') ?? latest;
  return <View style={s.executionGroup}>
    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${title}，${open ? '收起' : '展开'}处理记录`} onPress={() => setOpen(value => !value)} style={s.executionHead}><ExecutionIcon item={iconItem} />{section.running ? <ShimmerLabel text={title} /> : <Text style={s.executionTitle} numberOfLines={1}>{title}</Text>}<Animated.View testID={`execution-arrow-${section.id}`} style={[s.executionArrow, {transform: [{rotate: rotation.interpolate({inputRange: [0, 1], outputRange: ['0deg', '90deg']})}]}]}><ChevronRight size={14} color={c.muted} /></Animated.View></Pressable>
    {mounted && <Animated.View testID={`execution-body-${section.id}`} pointerEvents={open ? 'auto' : 'none'} aria-hidden={!open} accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'} style={[s.executionBody, {height}]}><ScrollView nestedScrollEnabled style={[s.executionList, {height: listHeight}]} contentContainerStyle={s.executionListContent} onContentSizeChange={(_width, measuredHeight) => setContentHeight(Math.ceil(measuredHeight))}>{section.items.map((item, index) => <Message key={item.id} item={item} running={section.running && index === section.items.length - 1} deviceId={deviceId} threadId={threadId} onImage={onImage} />)}{!section.items.length && <Text style={s.executionWaiting}>等待新的处理记录…</Text>}</ScrollView></Animated.View>}
  </View>;
}

type ActivityBlock = Extract<ReturnType<typeof buildActivityBlocks>[number], { kind: 'activity' }>;
function Activity({ block, turn, deviceId, threadId, onImage, questionRequestIds, steps }: { block: ActivityBlock; turn: HistoryTurn; deviceId: string; threadId: string; onImage: ImageViewer; questionRequestIds: string[]; steps?: {step:string;status:string}[] }) {
  const { c, s } = useTheme();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (block.state !== 'running') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [block.state]);
  return <View style={s.activity}>
    <View>
      <TurnTiming turn={turn} running={block.state === 'running'} />
      <View style={s.activityHead}>{block.state === 'running' ? <ActivityIndicator testID="processing-spinner" size="small" color={c.muted} accessibilityLabel="正在处理" /> : <View testID="activity-ended-check" accessible accessibilityLabel="任务已结束" style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}><Check size={16} strokeWidth={2.5} color={c.success} /></View>}<Text style={s.activityText}>{activityLabel(block, now)}</Text></View>
    </View>
    <View style={s.line} />
    {!!steps?.length && <ExecutionPlan steps={steps} />}
    {activitySections(block).map(section => {
      if (section.kind === 'execution') return <ExecutionGroup key={section.id} section={section} deviceId={deviceId} threadId={threadId} onImage={onImage} />;
      const item = section.item;
      if (item.type === 'plan') return <PlanCard key={item.id} item={item} turnId={turn.id} turnStatus={turn.status} deviceId={deviceId} threadId={threadId} />;
      if (item.questionRequestId && questionRequestIds.includes(item.questionRequestId)) return null;
      if (messageRole(item) === 'assistant' && item.phase !== 'final_answer') return <View key={item.id} style={s.commentary}><Markdown>{item.text ?? ''}</Markdown></View>;
      return <Message key={item.id} item={item} deviceId={deviceId} threadId={threadId} onImage={onImage} />;
    })}
  </View>;
}

export { FileChangesPanel } from './file-review';

export const TurnView = memo(function TurnView({ turn, active, deviceId, threadId, onImage, questionRequestIds, steps }: { turn: HistoryTurn; active: boolean; deviceId: string; threadId: string; onImage: ImageViewer; questionRequestIds: string[]; steps?: {step: string; status: string}[] }) {
  const { s } = useTheme();
  const { end } = recordedTurnTiming(turn, active);
  const running = active || turn.status === 'inProgress';
  const cost = turnCostLabel(turn.tokenUsage);
  return <View style={s.turn}>
    {buildActivityBlocks(turn, active).map(block => block.kind === 'message' ? <Message key={block.item.id} item={block.item} deviceId={deviceId} threadId={threadId} onImage={onImage} /> : <Activity key={block.id} block={block} turn={turn} deviceId={deviceId} threadId={threadId} onImage={onImage} questionRequestIds={questionRequestIds} steps={steps} />)}
    {!active && !!turn.fileChanges?.length && <FileChangesPanel changes={turn.fileChanges} compact={false} deviceId={deviceId} threadId={threadId} turnId={turn.id} />}
    {(turn.tokenUsage || running || end) && <View style={s.turnFooter}>
      {(turn.tokenUsage || running) && <View testID="turn-token-usage" style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        {running && <TaskStatusDot running label="任务进行中" />}
        <Text style={[s.usage, { flexShrink: 1 }]}>{turn.tokenUsage ? `输入 ${turn.tokenUsage.inputTokens.toLocaleString()} · 输出 ${turn.tokenUsage.outputTokens.toLocaleString()} · 缓存命中 ${turn.tokenUsage.cachedInputTokens.toLocaleString()}${turn.tokenUsage.state === 'partial' ? ' · 部分统计' : turn.tokenUsage.state === 'running' ? ' · 统计中' : ''}` : 'Token 统计中'}{!!cost && <Text testID="turn-cost"> · {cost}</Text>}</Text>
      </View>}
      <TurnEndTime turn={turn} running={active} />
    </View>}
  </View>;
});

export { RequestPanel } from './request-panel';
