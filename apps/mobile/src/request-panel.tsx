import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Check, ChevronLeft, ChevronRight, Pencil, ShieldCheck } from 'lucide-react-native';
import type { InteractiveRequest, RemoteCommand } from '../../../packages/protocol/src/index';
import { inputQuestions } from '../../../packages/client-shared/src/questions';
import { useTheme } from './styles';
import { useRequestDraft } from './request-drafts';
import { ChromeButton } from './interaction/primitives';
import { useInteractionMotion } from './interaction/motion';

export function RequestPanel({ request, deviceId = '', threadId, send, enabled }: { request: InteractiveRequest; deviceId?: string; threadId: string; enabled: boolean; send: (payload: RemoteCommand['payload']) => Promise<void> }) {
  const { c } = useTheme();
  const [state, update] = useRequestDraft(deviceId, threadId, request);
  const motion = useInteractionMotion(), fade = useRef(new Animated.Value(1)).current,previousPage=useRef(0),direction=useRef(1);
  const questions = inputQuestions(request.details), perQuestion = request.details.source === 'asyncMessage';
  const approval = request.kind === 'commandApproval' || request.kind === 'fileApproval';
  const access = request.kind === 'mcpElicitation' ? request.approval : undefined;
  const supported = request.respondable && (!!request.turnId || !!access) && (approval || !!access || request.kind === 'userInput' && questions.length > 0);
  const canAnswer = enabled && supported && !state.pending && !state.submitted;
  const page = Math.min(state.page, Math.max(0, questions.length - 1)), question = questions[page];
  const answered = !!question && state.sent.includes(question.id);
  const complete = state.submitted || perQuestion && questions.length > 0 && questions.every(q => state.sent.includes(q.id));
  const value = (id: string, choices = state.choices) => {
    const q = questions.find(q => q.id === id)!;
    return choices[id] !== undefined && choices[id]! >= 0 ? q.options[choices[id]!]!.label : state.text[id] ?? '';
  };
  const manual = !!question && (!question.options.length || state.choices[question.id] === -1);
  useEffect(() => {
    direction.current=page>=previousPage.current?1:-1;previousPage.current=page;
    fade.setValue(motion ? 0 : 1);
    const animation = Animated.timing(fade, { toValue: 1, duration: motion ? 170 : 0, useNativeDriver: Platform.OS !== 'web' });
    animation.start(); return () => animation.stop();
  }, [page, fade, motion]);
  const submit = async (payload: RemoteCommand['payload']) => {
    // The synchronous store update also locks a second click before React renders.
    let acquired = false;
    update(previous => { if (previous.pending || previous.submitted || !canAnswer) return previous; acquired = true; return { ...previous, pending: true, error: '' }; });
    if (!acquired) return;
    try {
      await send(payload);
      update(previous => {
        const ids = payload.type === 'input.respond' ? Object.keys(payload.answers) : [];
        const sent = [...new Set([...previous.sent, ...ids])];
        const next = perQuestion ? questions.findIndex(q => !sent.includes(q.id)) : -1;
        return { ...previous, pending: false, submitted: !perQuestion, sent, page: next >= 0 ? next : previous.page,
          text: perQuestion ? Object.fromEntries(Object.entries(previous.text).filter(([id]) => !ids.includes(id))) : {},
          choices: perQuestion ? previous.choices : {} };
      });
    } catch (failure) { update(previous => ({ ...previous, pending: false, error: failure instanceof Error ? failure.message : '提交失败，请重试' })); }
  };
  const sendAnswers = (ids: string[], choices = state.choices) => {
    if (ids.some(id => !value(id, choices).trim())) return;
    void submit({ type: 'input.respond', threadId, turnId: request.turnId!, requestId: request.id, answers: Object.fromEntries(ids.map(id => [id, { answers: [value(id, choices)] }])) });
  };
  const choose = (index: number) => {
    if (!canAnswer || answered || !question) return;
    const choices = { ...state.choices, [question.id]: index };
    update(previous => ({ ...previous, choices }));
    if (perQuestion && index >= 0) sendAnswers([question.id], choices);
  };
  const button = (label: string, action: () => void, primary = false, disabled = !canAnswer) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={action} style={[styles.button, { backgroundColor: primary ? c.text : c.surface, borderColor: primary ? c.text : c.line, opacity: disabled ? .4 : 1 }]}><Text style={{ color: primary ? c.surface : c.text, fontSize: 13, fontWeight: '600' }}>{label === '继续下一题' ? '下一题' : label.startsWith('提交回答') ? '提交' : label}</Text></Pressable>;
  const allowed = Array.isArray(request.details.availableDecisions) ? request.details.availableDecisions : ['accept', 'decline', 'cancel'];
  const title = request.kind === 'userInput' ? '回答问题' : access ? access.kind === 'browser' ? 'Browser 网站授权' : 'Computer Use 应用授权' : request.kind === 'commandApproval' ? '允许执行此命令？' : request.kind === 'fileApproval' ? '允许更改文件？' : '待处理请求';
  return <View testID="request-review-card" style={[styles.card, { backgroundColor: c.composer }]}>
    {request.kind === 'userInput' ? <View style={[styles.heading,{marginTop:-9,marginLeft:-11,marginRight:-9}]}>{questions.length > 1 && <><ChromeButton Icon={ChevronLeft} label="上一题" size={17} disabled={page === 0 || state.pending} onPress={() => update(previous => ({ ...previous, page: page - 1 }))} /><Text style={{ color: c.muted, fontSize: 12 }}>{page + 1}/{questions.length}</Text><ChromeButton Icon={ChevronRight} label="下一题" size={17} disabled={page === questions.length - 1 || state.pending} onPress={() => update(previous => ({ ...previous, page: page + 1 }))} /></>}<View style={{flex:1}} /><Text style={{color:c.faint,fontSize:11}}>{complete ? '已回答' : perQuestion ? '逐题回答' : '回答问题'}</Text></View> : <View style={styles.heading}><ShieldCheck size={19} color={c.text} /><Text style={{color:c.text,fontSize:14,fontWeight:'600',flex:1}}>{title}</Text></View>}
    {!!request.reason && <Text selectable style={{ color: c.text, lineHeight: 21 }}>{request.reason}</Text>}
    {request.detailsTruncated && <Text style={{ color: c.muted, fontSize: 12 }}>请求详情已截断，请在 PC 核对完整内容。</Text>}
    {!!request.command && <View style={[styles.command, { backgroundColor: c.surface }]}><Text selectable style={{ color: c.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 19 }}>{request.command}</Text></View>}
    {access && <><Text selectable style={{ color: c.text, lineHeight: 21 }}>{access.kind === 'browser' ? '允许 ChatGPT 访问网站：' : '允许 ChatGPT 使用应用：'}{access.target}</Text>{!!access.message && <Text selectable style={{ color: c.muted, lineHeight: 20 }}>{access.message}</Text>}{access.kind === 'computer' && <Text style={{ color: c.muted, fontSize: 12 }}>允许后可查看该应用内容、截图并执行操作。</Text>}{access.elevatedRisk && <Text style={{ color: c.danger }}>此请求被官方标记为高风险，请核对访问目标及操作说明。</Text>}</>}
    {question && !complete && <Animated.View key={question.id} style={{ opacity: fade, gap: 10,transform:[{translateX:fade.interpolate({inputRange:[0,1],outputRange:[motion?direction.current*18:0,0]})}] }}>
      {!!question.header && <Text style={{ color: c.muted, fontSize: 12 }}>{question.header}</Text>}
      <Text selectable accessibilityRole="header" style={{ color: c.text, fontSize: 17, lineHeight: 25, fontWeight: '600' }}>{question.question}</Text>

      {question.options.map((option, index) => <Pressable key={option.label} accessibilityRole="radio" aria-checked={state.choices[question.id] === index} disabled={!canAnswer || answered} onPress={() => choose(index)} style={[styles.option, { backgroundColor: state.choices[question.id] === index ? c.surface : 'transparent' }]}><View style={{ flex: 1, gap: 3 }}><Text style={{ color: c.text, fontSize: 14 }}>{option.label}</Text>{!!option.description && <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{option.description}</Text>}</View>{state.choices[question.id] === index && <Check size={17} color={c.text} />}</Pressable>)}
      {(question.isOther || !question.options.length) && !answered && <View style={[styles.input,{flexDirection:'row',alignItems:'center',gap:9,paddingVertical:0,borderColor:state.choices[question.id] === -1 ? c.accent : 'transparent',backgroundColor:state.choices[question.id] === -1 ? c.surface : 'transparent'}]}><Pencil size={13} color={c.faint} /><TextInput accessibilityLabel={`回答：${question.header || question.question}`} value={state.text[question.id] ?? ''} onFocus={() => {if(canAnswer) choose(-1);}} onChangeText={text => update(previous => ({ ...previous, choices:{...previous.choices,[question.id]:-1}, text: { ...previous.text, [question.id]: text } }))} editable={canAnswer} placeholder="请提供其他答案" placeholderTextColor={c.faint} multiline={!question.isSecret} secureTextEntry={question.isSecret} autoCorrect={!question.isSecret} autoComplete="off" maxLength={8192} style={{flex:1,color:c.text,fontSize:13,lineHeight:20,minHeight:38,maxHeight:110,paddingVertical:9}} /></View>}
      <View style={{flexDirection:'row',alignItems:'center',gap:10,marginTop:4}}><Text style={{flex:1,color:c.faint,fontSize:11}}>{perQuestion ? '选择选项后提交本题' : '所有答案确认后一起提交'}</Text>
      {answered ? <Text style={{ color: c.success }}>本题已提交</Text> : perQuestion ? manual && button(`提交回答：${question.question}`, () => sendAnswers([question.id]), true, !canAnswer || !value(question.id).trim()) : page < questions.length - 1 ? button('继续下一题', () => update(previous => ({ ...previous, page: page + 1 })), true, !canAnswer || !value(question.id).trim()) : button('提交回答', () => sendAnswers(questions.map(q => q.id)), true, !canAnswer || questions.some(q => !value(q.id).trim()))}</View>
    </Animated.View>}
    {complete ? <View style={styles.heading}><Check size={16} color={c.success} /><Text style={{ color: c.muted, fontSize: 12 }}>回答已提交，等待 Codex 更新…</Text></View> : access ? <View style={styles.actions}>{access.scopes.map(scope => button(scope === 'always' ? access.kind === 'browser' ? '始终允许此网站' : '始终允许此应用' : scope === 'session' ? '允许本次会话' : '允许一次', () => void submit({ type: 'elicitation.respond', threadId, turnId: request.turnId, requestId: request.id, decision: 'accept', scope }), true))}{button('拒绝', () => void submit({ type: 'elicitation.respond', threadId, turnId: request.turnId, requestId: request.id, decision: 'decline', scope: 'once' }))}</View> : approval && <View style={styles.actions}>{(['accept', 'decline', 'cancel'] as const).filter(decision => allowed.includes(decision)).map(decision => button(decision === 'accept' ? '允许' : decision === 'decline' ? '拒绝' : '取消', () => void submit({ type: 'approval.respond', threadId, turnId: request.turnId!, requestId: request.id, decision }), decision === 'accept'))}</View>}
    {state.pending && <View accessibilityLiveRegion="polite" style={styles.heading}><ActivityIndicator size="small" color={c.muted} /><Text style={{ color: c.muted, fontSize: 12 }}>正在发送回答…</Text></View>}
    {!supported && <Text style={{ color: c.muted, lineHeight: 20 }}>此请求暂不能在远程回答，请在 PC 的 Codex 中处理。</Text>}
    {!enabled && supported && !complete && <Text style={{ color: c.muted, fontSize: 12 }}>等待设备连接与会话状态同步后可回答。</Text>}
    {!!state.error && <Text accessibilityRole="alert" style={{ color: c.danger, fontSize: 13 }}>{state.error} · 答案已保留，请重试。</Text>}
  </View>;
}
const styles = StyleSheet.create({
  card: { borderRadius: 20, padding: 18, marginVertical: 10, gap: 14 }, heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal:10,paddingVertical:13, marginHorizontal:-8, borderRadius: 12, minHeight: 46 },
  input: { borderWidth: 1, borderRadius: 14, padding: 13, minHeight: 48, maxHeight: 160, fontSize: 14 },
  button: { minHeight: 36, paddingHorizontal: 15, paddingVertical: 10, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, command: { borderRadius: 12, padding: 13 },
});
