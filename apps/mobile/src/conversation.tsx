import { memo, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { Check, ChevronDown, Clock3, Copy, Folder, Terminal } from 'lucide-react-native';
import { activityLabel, buildActivityBlocks, formatDuration, itemDuration, messageRole } from '../../../packages/client-shared/src/activity';
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

function Message({ item, deviceId, threadId, onImage }: { item: RemoteItem; deviceId: string; threadId: string; onImage: ImageViewer }) {
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
  const title = item.command ? '运行命令' : item.files?.length ? '修改文件' : item.type === 'reasoning' ? '思考' : item.tool || '工具调用';
  const preview = item.command?.split('\n')[0] ?? item.text?.split('\n')[0] ?? '';
  return <View style={s.tool}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}，${open ? '收起' : '展开'}`} onPress={() => setOpen(!open)} style={s.toolHead}><Terminal size={15} color={c.muted} /><Text style={s.toolTitle}>{title}</Text><Text style={s.toolPreview} numberOfLines={1}>{preview}</Text>{itemDuration(item) !== undefined && <Text style={s.toolTime}>{formatDuration(itemDuration(item)!)}</Text>}<ChevronDown size={15} color={c.muted} style={open ? s.rotated : undefined} /></Pressable>
    {open && <View style={s.toolBody}>{!!item.text && <Markdown>{item.text}</Markdown>}{!!item.command && <CodeBlock language="命令">{item.command}</CodeBlock>}{!!item.output && <CodeBlock language="输出">{item.output}</CodeBlock>}{!!item.files?.length && <Text style={s.fileNames}>{item.files.join('\n')}</Text>}</View>}
  </View>;
}

type ActivityBlock = Extract<ReturnType<typeof buildActivityBlocks>[number], { kind: 'activity' }>;
function Activity({ block, deviceId, threadId, onImage }: { block: ActivityBlock; deviceId: string; threadId: string; onImage: ImageViewer }) {
  const [open, setOpen] = useState(block.state === 'running');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (block.state !== 'running') setOpen(false); }, [block.state]);
  useEffect(() => { if (block.state !== 'running') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [block.state]);
  const count = block.items.filter(item => item.command || item.output || item.tool || item.files?.length).length;
  return <View style={s.activity}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${activityLabel(block, now)}，${open ? '收起' : '展开'}处理记录`} onPress={() => setOpen(!open)} style={s.activityHead}>{block.state === 'running' ? <ActivityIndicator size="small" color={c.accent} /> : <Clock3 size={16} color={c.accent} />}<Text style={s.activityText}>{activityLabel(block, now)}</Text><Text style={s.activityCount}>{count ? `${count} 条执行` : ''}</Text><ChevronDown size={17} color={c.muted} style={open ? s.rotated : undefined} /></Pressable>
    <View style={s.line} />
    {block.items.map(item => {
      const visible = messageRole(item) === 'user' || messageRole(item) === 'assistant' && item.phase === 'final_answer';
      if (!open && !visible) return null;
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
