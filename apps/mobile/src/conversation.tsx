import { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Check, ChevronDown, ChevronRight, ChevronUp, Clock3, Copy, Folder, Pencil, Sparkles, Terminal } from 'lucide-react-native';
import { activityLabel, activitySections, buildActivityBlocks, executionItemLabel, formatDuration, itemDuration, messageRole } from '../../../packages/client-shared/src/activity';
import type { ExecutionSection } from '../../../packages/client-shared/src/activity';
import type { HistoryTurn, InteractiveRequest, RemoteCommand, RemoteItem } from '../../../packages/protocol/src/index';
import { userPresentation } from '../../../packages/protocol/src/user-presentation';
import { relay } from './relay';
import { Markdown } from './markdown';
import { RelayImage } from './relay-image';
import { CodeBlock } from './code-block';
import { copyText } from './runtime';
import { c, s } from './styles';

type ImageSource = { uri: string; headers?: Record<string, string> };
type ImageViewer = (source: ImageSource, name: string) => void;

function ExecutionIcon({ item }: { item?: RemoteItem }) {
  const Icon = !item || item.type === 'reasoning' ? Sparkles : item.files?.length || item.type === 'fileChange' ? Pencil : Terminal;
  return <Icon size={14} color={c.muted} />;
}

function Message({ item, running = false, deviceId, threadId, onImage }: { item: RemoteItem; running?: boolean; deviceId: string; threadId: string; onImage: ImageViewer }) {
  const role = messageRole(item);
  const [open, setOpen] = useState(false);
  const images = item.images ?? [];
  const body = role === 'user' ? userPresentation(item.text ?? '').body : item.text ?? '';
  const display = images.some(image => image.source) ? body.replace(/!\[[^\]]*\]\([^)]*\)/g, '') : body;
  if (role) {
    if (!body && !images.length && !item.files?.length) return null;
    return <View style={[s.message, role === 'user' ? s.userMessage : s.agentMessage]}>
      {!!display && <Markdown>{display}</Markdown>}
      {!!images.length && <View style={s.imageRow}>{images.map(image => <Pressable key={image.id} accessibilityRole="button" accessibilityLabel={`查看图片 ${image.name}`} onPress={() => onImage(relay.imageSource(deviceId, threadId, image.id), image.name)}><RelayImage source={relay.imageSource(deviceId, threadId, image.id)} resizeMode="cover" style={s.image} /></Pressable>)}</View>}
      {!!item.files?.length && <Text style={s.fileNames}>{item.files.join(' · ')}</Text>}
      {!!display && <Pressable accessibilityRole="button" accessibilityLabel="复制消息" style={[s.iconButton, { alignSelf: role === 'user' ? 'flex-end' : 'flex-start', width: 30, height: 28 }]} onPress={() => void copyText(display).catch(() => relay.showNotice('复制失败，请选择文字手动复制'))}><Copy size={14} color={c.muted} /></Pressable>}
    </View>;
  }
  const title = executionItemLabel(item, running);
  const ToggleIcon = open ? ChevronUp : ChevronDown;
  const preview = item.command?.split('\n')[0] ?? item.files?.join(' · ') ?? item.text?.split('\n')[0] ?? '';
  return <View style={s.tool}>
    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${title}，${open ? '收起' : '展开'}详情`} onPress={() => setOpen(!open)} style={s.toolHead}><ExecutionIcon item={item} /><Text style={s.toolTitle}>{title}</Text><Text style={s.toolPreview} numberOfLines={1}>{preview}</Text>{itemDuration(item) !== undefined && <Text style={s.toolTime}>{formatDuration(itemDuration(item)!)}</Text>}<ToggleIcon size={13} color={c.muted} /></Pressable>
    {open && <View style={s.toolBody}>{!!item.text && <Markdown>{item.text}</Markdown>}{!!item.command && <CodeBlock language="命令">{item.command}</CodeBlock>}{!!item.output && <CodeBlock language="输出">{item.output}</CodeBlock>}{!!item.files?.length && <Text style={s.fileNames}>{item.files.join('\n')}</Text>}</View>}
  </View>;
}

function ExecutionGroup({ section, deviceId, threadId, onImage }: { section: ExecutionSection; deviceId: string; threadId: string; onImage: ImageViewer }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const height = useRef(new Animated.Value(0)).current;
  const rotation = useRef(new Animated.Value(0)).current;
  const listHeight = Math.min(contentHeight || 260, 260);
  useEffect(() => {
    const animation = Animated.timing(rotation, {toValue: open ? 1 : 0, duration: 240, easing: Easing.inOut(Easing.cubic), useNativeDriver: Platform.OS !== 'web'});
    animation.start();
    return () => animation.stop();
  }, [open, rotation]);
  useEffect(() => {
    if (open) setMounted(true);
    const animation = Animated.timing(height, {toValue: open ? Math.min(contentHeight, 260) : 0, duration: 240, easing: Easing.inOut(Easing.cubic), useNativeDriver: false});
    animation.start(({finished}) => { if (finished && !open) setMounted(false); });
    return () => animation.stop();
  }, [open, contentHeight, height]);
  const latest = section.items.at(-1);
  const title = executionItemLabel(latest, section.running);
  const preview = latest?.type === 'reasoning' ? '' : latest?.command?.split('\n')[0] ?? latest?.files?.join(' · ') ?? latest?.text?.split('\n')[0] ?? '';
  return <View style={s.executionGroup}>
    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${title}，${open ? '收起' : '展开'}处理记录`} onPress={() => setOpen(value => !value)} style={s.executionHead}><ExecutionIcon item={latest} /><Text style={s.executionTitle}>{title}</Text>{!!preview && <Text style={s.executionPreview} numberOfLines={1}>{preview}</Text>}<Animated.View testID={`execution-arrow-${section.id}`} style={[s.executionArrow, {transform: [{rotate: rotation.interpolate({inputRange: [0, 1], outputRange: ['0deg', '90deg']})}]}]}><ChevronRight size={14} color={c.muted} /></Animated.View></Pressable>
    {mounted && <Animated.View testID={`execution-body-${section.id}`} pointerEvents={open ? 'auto' : 'none'} aria-hidden={!open} accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'} style={[s.executionBody, {height}]}><ScrollView nestedScrollEnabled style={[s.executionList, {height: listHeight}]} contentContainerStyle={s.executionListContent} onContentSizeChange={(_width, measuredHeight) => setContentHeight(Math.ceil(measuredHeight))}>{section.items.map((item, index) => <Message key={item.id} item={item} running={section.running && index === section.items.length - 1} deviceId={deviceId} threadId={threadId} onImage={onImage} />)}{!section.items.length && <Text style={s.executionWaiting}>等待新的处理记录…</Text>}</ScrollView></Animated.View>}
  </View>;
}

type ActivityBlock = Extract<ReturnType<typeof buildActivityBlocks>[number], { kind: 'activity' }>;
function Activity({ block, deviceId, threadId, onImage }: { block: ActivityBlock; deviceId: string; threadId: string; onImage: ImageViewer }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (block.state !== 'running') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [block.state]);
  return <View style={s.activity}>
    <View style={s.activityHead}>{block.state === 'running' ? <ActivityIndicator size="small" color={c.accent} /> : <Clock3 size={14} color={c.muted} />}<Text style={s.activityText}>{activityLabel(block, now)}</Text></View>
    <View style={s.line} />
    {activitySections(block).map(section => {
      if (section.kind === 'execution') return <ExecutionGroup key={section.id} section={section} deviceId={deviceId} threadId={threadId} onImage={onImage} />;
      const item = section.item;
      if (messageRole(item) === 'assistant' && item.phase !== 'final_answer') return <View key={item.id} style={s.commentary}><Markdown>{item.text ?? ''}</Markdown></View>;
      return <Message key={item.id} item={item} deviceId={deviceId} threadId={threadId} onImage={onImage} />;
    })}
  </View>;
}

export const TurnView = memo(function TurnView({ turn, active, deviceId, threadId, onImage }: { turn: HistoryTurn; active: boolean; deviceId: string; threadId: string; onImage: ImageViewer }) {
  const [diffOpen, setDiffOpen] = useState(false);
  return <View style={s.turn}>
    {buildActivityBlocks(turn, active).map(block => block.kind === 'message' ? <Message key={block.item.id} item={block.item} deviceId={deviceId} threadId={threadId} onImage={onImage} /> : <Activity key={block.id} block={block} deviceId={deviceId} threadId={threadId} onImage={onImage} />)}
    {!!turn.fileChanges?.length && <View style={s.changes}><Pressable onPress={() => setDiffOpen(!diffOpen)} style={s.changeHead}><Folder size={15} color={c.muted} /><Text style={s.changeTitle}>已编辑 {turn.fileChanges.length} 个文件</Text><Text style={s.additions}>+{turn.fileChanges.reduce((n, change) => n + change.additions, 0)}</Text><Text style={s.deletions}>-{turn.fileChanges.reduce((n, change) => n + change.deletions, 0)}</Text><ChevronDown size={16} color={c.muted} style={diffOpen ? s.rotated : undefined} /></Pressable>{diffOpen && turn.fileChanges.map(change => <View key={change.path} style={s.diff}><Text style={s.diffPath}>{change.path}</Text><Text selectable style={s.code}>{change.diff || '差异暂不可用'}</Text></View>)}</View>}
    {turn.tokenUsage && <Text style={s.usage}>输入 {turn.tokenUsage.inputTokens.toLocaleString()} · 输出 {turn.tokenUsage.outputTokens.toLocaleString()} · 缓存命中 {turn.tokenUsage.cachedInputTokens.toLocaleString()}{turn.tokenUsage.state === 'partial' ? ' · 部分统计' : turn.tokenUsage.state === 'running' ? ' · 统计中' : ''}</Text>}
    {turn.truncated && <Text style={s.usage}>部分内容已截断</Text>}
  </View>;
});

export function RequestPanel({ request, threadId, send }: { request: InteractiveRequest; threadId: string; send: (payload: RemoteCommand['payload']) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!request.turnId) return null;
  const details = request.details as Record<string, unknown>;
  const questions = Array.isArray(details.questions) ? details.questions as Array<Record<string, unknown>> : [];
  const allowed = Array.isArray(details.availableDecisions) ? details.availableDecisions : ['accept', 'decline', 'cancel'];
  return <View style={s.request}><Text style={s.requestTitle}>{request.kind === 'userInput' ? 'Codex 需要回答' : '待处理请求'}</Text>{!!request.reason && <Text style={s.requestText}>{request.reason}</Text>}{!!request.command && <Text style={s.code}>{request.command}</Text>}
    {request.kind === 'userInput' ? <>{questions.map((question, index) => {
      const id = String(question.id ?? `question-${index}`);
      const options = Array.isArray(question.options) ? question.options : [];
      return <View key={id}><Text style={s.requestText}>{String(question.question ?? question.header ?? '问题')}</Text>{options.length ? options.map(option => { const label = typeof option === 'object' && option ? String((option as Record<string, unknown>).label ?? (option as Record<string, unknown>).value ?? '') : String(option); return <Pressable key={label} onPress={() => setAnswers({ ...answers, [id]: label })} style={[s.option, answers[id] === label && s.optionSelected]}><Text style={s.requestText}>{label}</Text>{answers[id] === label && <Check size={15} color={c.accent} />}</Pressable>; }) : <TextInput style={s.field} value={answers[id] ?? ''} onChangeText={value => setAnswers({ ...answers, [id]: value })} placeholder="输入回答" />}</View>;
    })}<Pressable style={[s.smallPrimary, (!request.respondable || questions.some((question, index) => !(answers[String(question.id ?? `question-${index}`)] ?? '').trim())) && s.disabled]} disabled={!request.respondable || questions.some((question, index) => !(answers[String(question.id ?? `question-${index}`)] ?? '').trim())} onPress={() => send({ type: 'input.respond', threadId, turnId: request.turnId!, requestId: request.id, answers: Object.fromEntries(questions.map((question, index) => { const id = String(question.id ?? `question-${index}`); return [id, { answers: [answers[id]!] }]; })) })}><Text style={s.primaryText}>提交回答</Text></Pressable></> : <View style={s.decisionRow}>{(['accept', 'decline', 'cancel'] as const).filter(decision => allowed.includes(decision)).map(decision => <Pressable key={decision} disabled={!request.respondable} onPress={() => send({ type: 'approval.respond', threadId, turnId: request.turnId!, requestId: request.id, decision })} style={[s.decision, decision === 'accept' && s.decisionAccept]}><Text style={decision === 'accept' ? s.primaryText : s.requestText}>{decision === 'accept' ? '允许' : decision === 'decline' ? '拒绝' : '取消'}</Text></Pressable>)}</View>}
  </View>;
}
