import { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Check, ChevronDown, ChevronRight, ChevronUp, Clock3, Copy, Folder, HelpCircle, Pencil, Sparkles, Terminal } from 'lucide-react-native';
import { inputQuestions } from '../../../packages/client-shared/src/questions';
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
import { ShimmerLabel } from './shimmer';

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
    <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${title}，${open ? '收起' : '展开'}处理记录`} onPress={() => setOpen(value => !value)} style={s.executionHead}><ExecutionIcon item={latest} />{section.running ? <ShimmerLabel text={title} /> : <Text style={s.executionTitle}>{title}</Text>}{!!preview && <Text style={s.executionPreview} numberOfLines={1}>{preview}</Text>}<Animated.View testID={`execution-arrow-${section.id}`} style={[s.executionArrow, {transform: [{rotate: rotation.interpolate({inputRange: [0, 1], outputRange: ['0deg', '90deg']})}]}]}><ChevronRight size={14} color={c.muted} /></Animated.View></Pressable>
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

export function FileChangesPanel({ changes, compact = true }: { changes: NonNullable<HistoryTurn['fileChanges']>; compact?: boolean }) {
  const [diffOpen, setDiffOpen] = useState(false);
  if (!changes.length) return null;
  const diffs = changes.map(change => <View key={change.path} style={[s.diff, !compact && {borderTopWidth: 1, borderColor: c.line}]}><Text style={s.diffPath}>{change.path}</Text><Text selectable style={s.code}>{change.diff || '差异暂不可用'}</Text>{change.truncated && <Text style={s.usage}>部分差异已截断</Text>}</View>);
  return <View style={compact ? s.changes : s.completedChanges}><Pressable accessibilityRole="button" accessibilityLabel={`${changes.length} 个文件已更改，${diffOpen ? '收起' : '查看'}差异`} aria-expanded={diffOpen} onPress={() => setDiffOpen(!diffOpen)} style={compact ? s.changeHead : s.completedChangeHead}>{!compact && <Folder size={15} color={c.muted} />}<Text style={compact ? s.changeTitle : s.completedChangeTitle}>{compact ? `${changes.length} 个文件已更改` : `已编辑 ${changes.length} 个文件`}</Text><Text style={compact ? s.additions : s.completedAdditions}>+{changes.reduce((n, change) => n + change.additions, 0)}</Text><Text style={s.deletions}>-{changes.reduce((n, change) => n + change.deletions, 0)}</Text>{!compact && <ChevronDown size={16} color={c.muted} style={diffOpen ? s.rotated : undefined} />}</Pressable>{diffOpen && (compact ? <ScrollView style={s.diffs} nestedScrollEnabled>{diffs}</ScrollView> : diffs)}</View>;
}

export const TurnView = memo(function TurnView({ turn, active, deviceId, threadId, onImage }: { turn: HistoryTurn; active: boolean; deviceId: string; threadId: string; onImage: ImageViewer }) {
  return <View style={s.turn}>
    {buildActivityBlocks(turn, active).map(block => block.kind === 'message' ? <Message key={block.item.id} item={block.item} deviceId={deviceId} threadId={threadId} onImage={onImage} /> : <Activity key={block.id} block={block} deviceId={deviceId} threadId={threadId} onImage={onImage} />)}
    {!active && !!turn.fileChanges?.length && <FileChangesPanel changes={turn.fileChanges} compact={false} />}
    {turn.tokenUsage && <Text style={s.usage}>输入 {turn.tokenUsage.inputTokens.toLocaleString()} · 输出 {turn.tokenUsage.outputTokens.toLocaleString()} · 缓存命中 {turn.tokenUsage.cachedInputTokens.toLocaleString()}{turn.tokenUsage.state === 'partial' ? ' · 部分统计' : turn.tokenUsage.state === 'running' ? ' · 统计中' : ''}</Text>}
  </View>;
});

export function RequestPanel({ request, threadId, send, enabled }: { request: InteractiveRequest; threadId: string; enabled: boolean; send: (payload: RemoteCommand['payload']) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const questions = inputQuestions(request.details);
  const approval = request.kind === 'commandApproval' || request.kind === 'fileApproval';
  const canAnswer = enabled && request.respondable && !!request.turnId && !pending && !submitted && (approval || request.kind === 'userInput' && questions.length > 0);
  const answerFor = (id: string) => {
    const question = questions.find(item => item.id === id)!;
    const choice = choices[id];
    return choice !== undefined && choice >= 0 ? question.options[choice]?.label ?? '' : answers[id] ?? '';
  };
  const submit = async (payload: RemoteCommand['payload']) => {
    if (!canAnswer || sending.current) return;
    sending.current = true; setPending(true); setError('');
    try { await send(payload); setSubmitted(true); setAnswers({}); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '提交失败，请重试'); }
    finally { sending.current = false; setPending(false); }
  };
  const allowed = Array.isArray(request.details.availableDecisions) ? request.details.availableDecisions : ['accept', 'decline', 'cancel'];
  return <View style={[s.request, request.kind === 'userInput' && s.questionCard]}>
    <View style={s.requestHeading}><HelpCircle size={16} color={c.muted} /><Text style={s.requestTitle}>{request.kind === 'userInput' ? '回答问题' : '待处理请求'}</Text>{request.kind === 'userInput' && request.details.isBlocking === false && <Text style={s.sub}>任务可继续执行</Text>}</View>
    {!!request.reason && <Text style={s.requestText}>{request.reason}</Text>}{!!request.command && <Text style={s.code}>{request.command}</Text>}
    {request.kind === 'userInput' && !submitted && questions.map((question, index) => <View key={question.id} style={s.question}>
      {!!question.header && <Text style={s.questionHeader}>{questions.length > 1 ? `${index + 1}/${questions.length} · ` : ''}{question.header}</Text>}
      <Text style={s.questionText}>{question.question}</Text>
      {question.options.map((option, optionIndex) => <Pressable key={option.label} accessibilityRole="radio" accessibilityState={{checked: choices[question.id] === optionIndex, disabled: !canAnswer}} disabled={!canAnswer} onPress={() => setChoices(value => ({...value, [question.id]: optionIndex}))} style={[s.option, choices[question.id] === optionIndex && s.optionSelected]}><View style={s.optionBody}><Text style={s.requestText}>{option.label}</Text>{!!option.description && <Text style={s.optionDescription}>{option.description}</Text>}</View>{choices[question.id] === optionIndex ? <Check size={17} color={c.accent} /> : <View style={s.optionCircle} />}</Pressable>)}
      {!!question.options.length && question.isOther && <Pressable accessibilityRole="radio" accessibilityLabel={`自定义回答：${question.header || question.question}`} accessibilityState={{checked: choices[question.id] === -1, disabled: !canAnswer}} disabled={!canAnswer} onPress={() => setChoices(value => ({...value, [question.id]: -1}))} style={[s.option, choices[question.id] === -1 && s.optionSelected]}><Text style={s.requestText}>自定义回答</Text>{choices[question.id] === -1 ? <Check size={17} color={c.accent} /> : <View style={s.optionCircle} />}</Pressable>}
      {(!question.options.length || question.isOther && choices[question.id] === -1) && <TextInput accessibilityLabel={`回答：${question.header || question.question}`} style={s.answerInput} value={answers[question.id] ?? ''} onChangeText={value => setAnswers(current => ({...current, [question.id]: value}))} editable={canAnswer} placeholder="输入你的回答" placeholderTextColor={c.muted} multiline={!question.isSecret} secureTextEntry={question.isSecret} autoCorrect={!question.isSecret} autoComplete="off" maxLength={8192} />}
    </View>)}
    {submitted ? <Text style={s.sub}>回答已提交，等待 Codex 更新…</Text> : request.kind === 'userInput' && questions.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="提交回答" style={[s.smallPrimary, (!canAnswer || questions.some(question => !answerFor(question.id).trim())) && s.disabled]} disabled={!canAnswer || questions.some(question => !answerFor(question.id).trim())} onPress={() => void submit({type: 'input.respond', threadId, turnId: request.turnId!, requestId: request.id, answers: Object.fromEntries(questions.map(question => [question.id, {answers: [answerFor(question.id)]}]))})}>{pending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.primaryText}>提交回答</Text>}</Pressable> : approval ? <View style={s.decisionRow}>{(['accept', 'decline', 'cancel'] as const).filter(decision => allowed.includes(decision)).map(decision => <Pressable accessibilityRole="button" key={decision} disabled={!canAnswer} onPress={() => void submit({type: 'approval.respond', threadId, turnId: request.turnId!, requestId: request.id, decision})} style={[s.decision, decision === 'accept' && s.decisionAccept, !canAnswer && s.disabled]}><Text style={decision === 'accept' ? s.primaryText : s.requestText}>{decision === 'accept' ? '允许' : decision === 'decline' ? '拒绝' : '取消'}</Text></Pressable>)}</View> : null}
    {(!request.respondable || !request.turnId || request.kind === 'userInput' && !questions.length || !approval && request.kind !== 'userInput') && <Text style={s.sub}>此请求暂不能在远程回答，请在 PC 的 Codex 中处理。</Text>}
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
  </View>;
}
