import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ArrowDown, Camera, Check, ChevronDown, Copy, FileText, FlaskConical, Folder, Image as ImageIcon, ListChecks, MessageCircleQuestion, Monitor, Moon, Paperclip, Pencil, Plus, RotateCcw, Settings2, ShieldCheck, Sun, Video, X } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import type { PermissionMode } from '../../../../packages/protocol/src/index';
import { modelLabel } from '../../../../packages/client-shared/src/models';
import { ThemeScope } from '../theme';
import { applyTheme } from '../theme-platform';
import { useTheme } from '../styles';
import { TaskStatusDot } from '../task-status-dot';
import { Markdown } from '../markdown';
import { copyText } from '../runtime';
import { pickAttachments } from '../attachment-picker';
import type { AttachmentAsset } from '../attachment-picker';
import { useConversationDraft } from '../conversation-drafts';
import { ConversationChromeComposer, ConversationChromeHeader } from '../interaction/conversation-chrome';
import type { ComposerAction, ConversationPhase } from '../interaction/conversation-chrome';
import { ChromeActivity } from '../interaction/activity';
import { InteractionSurface } from '../interaction/surface';
import { ModelSurface } from '../interaction/model-surface';
import { ChromeButton, MenuRow } from '../interaction/primitives';
import { QuickModelPanel, AdvancedModelPanel, referenceEffortLabel } from '../interaction/model-panel';
import { ChromePermissionPanel } from '../interaction/permission-panel';
import { interactionDark, interactionLight } from '../interaction/theme';
import { useInteractionMotion } from '../interaction/motion';
import { initialSessions, phaseLabels, previewModels, samplePhoto } from './fixtures';
import type { DemoSession } from './fixtures';
import { ApprovalReviewCard, emptyAnswers, PlanReviewCard, PlanReviewReader, QuestionReviewCard } from './review-cards';
import type { QuestionAnswers } from './review-cards';
import { FileReviewPanel, initialFileReview, reviewChanges } from './file-review';
import { SettingsReviewPanel } from './settings-review';
import type { SettingsReviewSection } from './settings-review';
import { planBody, planInstruction, previewAccents } from './review-fixtures';
import type { PreviewPreferences, ReviewCondition, ReviewScene } from './review-fixtures';
import { readPreviewPreferences, savePreviewPreferences } from './preview-preferences';
import { exportPreviewText } from './preview-export';

type Panel = 'attachments' | 'model' | 'advanced' | 'permissions' | 'options' | 'projects' | 'workshop' | 'image' | 'rename' | 'plan-reader' | 'files' | 'settings' | null;

export default function InteractionPreviewApp() {
  const [preferences, setPreferences] = useState(readPreviewPreferences);
  const system = useColorScheme();
  const dark = preferences.appearance === 'dark' || preferences.appearance === 'system' && system === 'dark';
  const theme = useMemo(() => { const base = dark ? interactionDark : interactionLight, accent = previewAccents[preferences.accent]; return { ...base, colors: { ...base.colors, accent: accent.color, solid: accent.color, slider: accent.color, soft: dark ? accent.dark : accent.light, bubble: dark ? accent.dark : accent.light } }; }, [dark, preferences.accent]);
  const updatePreferences = (value: PreviewPreferences) => { setPreferences(value); try { savePreviewPreferences(value); return true; } catch { return false; } };
  useEffect(() => applyTheme(theme), [theme]);
  return <SafeAreaProvider><ThemeScope theme={theme}><Preview dark={dark} preferences={preferences} onPreferences={updatePreferences} /></ThemeScope></SafeAreaProvider>;
}

function Preview({ dark, preferences, onPreferences }: { dark: boolean; preferences: PreviewPreferences; onPreferences: (value: PreviewPreferences) => boolean }) {
  const { c } = useTheme();
  const motion = useInteractionMotion();
  const { width, height } = useWindowDimensions();
  const framed = Platform.OS === 'web' && width >= 780;
  const [sessions, setSessions] = useState(initialSessions);
  const [thread, setThread] = useState('home');
  const session = sessions[thread]!;
  const [panel, setPanelContent] = useState<Panel>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const setPanel = (next: Panel) => { if (next) setPanelContent(next); setPanelOpen(!!next); };
  const [model, setModel] = useState(previewModels[0]!.model);
  const [effort, setEffort] = useState('high');
  const supportedEfforts = previewModels.find(option => option.model === model)!.supportedReasoningEfforts;
  const [permission, setPermission] = useState<PermissionMode>('ask');
  const [plan, setPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [rename, setRename] = useState('');
  const [previewImage, setPreviewImage] = useState<string>();
  const [jump, setJump] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [scenes, setScenes] = useState<Record<string, ReviewScene>>({});
  const scene = scenes[thread] ?? 'conversation';
  const [condition, setCondition] = useState<ReviewCondition>('normal');
  const [questionMode, setQuestionMode] = useState<'batch' | 'async'>('batch');
  const [questionEpoch, setQuestionEpoch] = useState(0);
  const answerKey = `${thread}:${questionMode}:${questionEpoch}`;
  const [answers, setAnswers] = useState<Record<string, QuestionAnswers>>({});
  const [prepared, setPrepared] = useState<Record<string, boolean>>({});
  const [filesView, setFilesView] = useState(initialFileReview);
  const [settingsSection, setSettingsSection] = useState<SettingsReviewSection>('overview');
  const host = useRef<View>(null), attachmentsAnchor = useRef<View>(null), modelAnchor = useRef<View>(null), composerAnchor = useRef<View>(null), optionsAnchor = useRef<View>(null);
  const list = useRef<ScrollView>(null), follow = useRef(true), sending = useRef(false), ids = useRef(100), activeThread = useRef(thread);
  activeThread.current = thread;
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const { draft, setText, setImages, setFiles, clearSubmitted, getDraft } = useConversationDraft(`codexer-interaction-preview-${draftEpoch}`, 'sample-pc', thread);
  const updateSession = (change: (previous: DemoSession) => DemoSession, key = thread) => setSessions(value => ({ ...value, [key]: change(value[key]!) }));
  const runningCount = Object.values(sessions).filter(item => item.phase === 'running').length;
  const amount = (session.tokens * 0.000008).toFixed(3);
  const notify = (text: string) => setNotice(text);
  const updatePreferences = (value: PreviewPreferences) => { if (!onPreferences(value)) notify('外观已更新，但偏好未能保存'); };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2600); return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);
  useEffect(() => {
    if (session.phase !== 'running') return;
    const key = thread;
    const timer = setInterval(() => { if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') updateSession(value => value.phase === 'running' ? { ...value, elapsed: value.elapsed + 1, tokens: value.tokens + 17 } : value, key); }, 1000);
    return () => clearInterval(timer);
  }, [thread, session.phase]);
  useEffect(() => { follow.current = true; setJump(false); const timer = setTimeout(() => list.current?.scrollToEnd({ animated: false }), 80); return () => clearTimeout(timer); }, [thread]);
  const changeThread = (key: string) => { Keyboard.dismiss(); setPanel(null); setThread(key); };
  const changePhase = (phase: ConversationPhase) => { updateSession(value => ({ ...value, phase, elapsed: phase === 'idle' ? 0 : value.elapsed || 47 })); setPanel(null); };
  const attachments = [...draft.images.map(item => ({ id: `image-${item.key}`, name: item.name, uri: item.uri })), ...draft.files.map(item => ({ id: `file-${item.key}`, name: item.asset.name, detail: item.asset.size > 1024 * 1024 ? `${(item.asset.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(item.asset.size / 1024)} KB` }))];
  const addImages = (assets: ImagePicker.ImagePickerAsset[]) => setImages(current => [...current, ...assets.slice(0, Math.max(0, 20 - current.length)).map(asset => ({ key: ++ids.current, uri: asset.uri, name: asset.fileName || '照片.png', asset, loading: false }))]);
  const addFiles = (assets: AttachmentAsset[]) => setFiles(current => [...current, ...assets.slice(0, Math.max(0, 4 - current.length)).map(asset => ({ key: ++ids.current, asset, loading: false }))]);
  const addExample = () => { setImages(current => current.length >= 20 ? current : [...current, { key: ++ids.current, uri: samplePhoto, name: '旅行照片.png', loading: false }]); setPanel(null); };
  const pick = async (kind: 'photos' | 'camera' | 'files' | 'videos') => {
    setPanel(null);
    const key = thread;
    try {
      if (kind === 'files' || kind === 'videos') { const assets = await pickAttachments(kind === 'videos' ? 'video' : undefined); if (activeThread.current === key) addFiles(assets); }
      else {
        if (kind === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) { notify('需要相机权限才能拍照'); return; }
        const result = kind === 'camera' ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 20 });
        if (!result.canceled && activeThread.current === key) addImages(result.assets);
      }
    } catch { notify('未能读取所选附件，请重试'); }
  };
  const submit = (action: ComposerAction) => {
    if (sending.current) return;
    if (condition === 'offline') { notify('设备离线，草稿已保留'); return; }
    if (prepared[thread] && action === 'steer') { notify('执行方案需要等待任务结束，或先停止当前任务'); return; }
    const submitted = getDraft(), key = thread;
    const content = submitted.text.trim();
    if ((action === 'send' || action === 'steer') && !content && !attachments.length) return;
    sending.current = true; setBusy(true); follow.current = true; setJump(false);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      if (action === 'stop') updateSession(value => ({ ...value, phase: 'interrupted' }), key);
      else if (action === 'continue') updateSession(value => ({ ...value, phase: 'running' }), key);
      else {
        updateSession(value => ({ ...value, phase: 'running', messages: [...value.messages, { id: `message-${++ids.current}`, role: 'user', text: content, attachments: attachments.map(item => ({ name: item.name, uri: 'uri' in item ? item.uri : undefined })) }] }), key);
        clearSubmitted(submitted); Keyboard.dismiss();
        setPrepared(value => ({ ...value, [key]: false }));
        setScenes(value => ({ ...value, [key]: 'conversation' }));
      }
      sending.current = false; setBusy(false);
    }, 180);
    timers.current.add(timer);
  };
  const newThread = () => {
    const key = `new-${++ids.current}`;
    setSessions(value => ({ ...value, [key]: { title: '新会话', phase: 'idle', elapsed: 0, tokens: 0, messages: [] } }));
    changeThread(key);
  };
  const setModelValue = (next: string) => { setModel(next); const option = previewModels.find(item => item.model === next)!; if (!option.supportedReasoningEfforts.includes(effort)) setEffort(option.defaultReasoningEffort); };
  const copy = (text: string) => { void copyText(text).then(() => notify('已复制')).catch(() => notify('复制失败，请手动选择文字')); };
  const close = () => {
    if (panel === 'files' && filesView.file) setFilesView(value => ({ ...value, file: undefined, line: undefined }));
    else if (panel === 'settings' && settingsSection !== 'overview') setSettingsSection('overview');
    else setPanel(null);
  };
  const chooseScene = (next: ReviewScene) => { setScenes(value => ({ ...value, [thread]: next })); if (next !== 'conversation') updateSession(value => ({ ...value, phase: next === 'plan' ? 'idle' : 'running' })); setPanel(null); follow.current = true; requestAnimationFrame(() => list.current?.scrollToEnd({ animated: motion })); };
  const openFiles = (tab: 'all' | 'changed') => { setFilesView(value => ({ ...value, tab, file: undefined, line: undefined })); setPanel('files'); };
  const openSettings = () => { setSettingsSection('overview'); setPanel('settings'); };
  const preparePlan = () => { setText(value => value.includes(planInstruction) ? value : `${value}${value.trim() ? '\n\n' : ''}${planInstruction}`); setPrepared(value => ({ ...value, [thread]: true })); setPanel(null); notify('执行指令已放入草稿，可补充后再发送'); };
  const compactPanel = panel === 'attachments' || panel === 'options';
  const anchor = panel === 'attachments' ? attachmentsAnchor : panel === 'options' ? optionsAnchor : undefined;
  const surfaceTitle = panel === 'plan-reader' ? '计划' : panel === 'files' ? '文件' : panel === 'settings' ? '设置' : panel === 'advanced' ? '高级' : panel === 'permissions' ? '会话权限' : panel === 'projects' ? '项目与会话' : panel === 'workshop' ? '体验样稿' : panel === 'image' ? '附件预览' : panel === 'rename' ? '重命名会话' : '会话菜单';
  const controls = <View style={{ gap: 2 }}>
    <Text style={{ color: c.faint, fontSize: 10, marginLeft: 14, marginBottom: 5 }}>页面与流程</Text>
    <MenuRow Icon={MessageCircleQuestion} title="分页问答" selected={scene === 'questions'} onPress={() => chooseScene('questions')} />
    <MenuRow Icon={ListChecks} title="计划卡片" selected={scene === 'plan'} onPress={() => chooseScene('plan')} />
    <MenuRow Icon={ShieldCheck} title="审批请求" selected={scene === 'approval'} onPress={() => chooseScene('approval')} />
    <MenuRow Icon={Folder} title="文件与目录搜索" onPress={() => openFiles('all')} />
    <MenuRow Icon={Settings2} title="设置与外观" onPress={openSettings} />
    <MenuRow Icon={Monitor} title="主会话" selected={scene === 'conversation'} onPress={() => chooseScene('conversation')} />
    <View style={{ height: 1, backgroundColor: c.line, marginVertical: 9 }} />
    <Text style={{ color: c.faint, fontSize: 10, marginLeft: 14, marginBottom: 5 }}>任务状态</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 11 }}>{(Object.keys(phaseLabels) as ConversationPhase[]).map(phase => <Pressable accessibilityRole="button" accessibilityLabel={`演示${phaseLabels[phase]}`} key={phase} onPress={() => changePhase(phase)} style={{ borderRadius: 9, minHeight: 34, paddingHorizontal: 10, justifyContent: 'center', backgroundColor: session.phase === phase ? c.soft : c.composer }}><Text style={{ color: c.text, fontSize: 11 }}>{phaseLabels[phase]}</Text></Pressable>)}</View>
    <Text style={{ color: c.faint, fontSize: 10, marginLeft: 14, marginTop: 15, marginBottom: 7 }}>异常与提交方式</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 11 }}>{([['normal', '正常'], ['offline', '设备离线'], ['failure', '失败重试'], ['expired', '请求过期']] as const).map(([value, label]) => <Pressable accessibilityRole="button" accessibilityLabel={`演示${label}`} key={value} onPress={() => { setCondition(value); setPanel(null); }} style={{ borderRadius: 8, minHeight: 31, paddingHorizontal: 9, justifyContent: 'center', backgroundColor: condition === value ? c.soft : c.composer }}><Text style={{ color: c.text, fontSize: 10 }}>{label}</Text></Pressable>)}</View>
    {scene === 'questions' && <><View style={{ flexDirection: 'row', gap: 5, paddingHorizontal: 11, marginTop: 7 }}>{(['batch', 'async'] as const).map(mode => <Pressable accessibilityRole="button" accessibilityLabel={mode === 'batch' ? '演示整组提交' : '演示逐题提交'} key={mode} onPress={() => setQuestionMode(mode)} style={{ borderRadius: 8, minHeight: 31, paddingHorizontal: 9, justifyContent: 'center', backgroundColor: questionMode === mode ? c.soft : c.composer }}><Text style={{ color: c.text, fontSize: 10 }}>{mode === 'batch' ? '整组提交' : '逐题提交'}</Text></Pressable>)}</View><MenuRow Icon={RotateCcw} title="重新演示问答" onPress={() => { setQuestionEpoch(value => value + 1); setPanel(null); }} /></>}
    <View style={{ height: 1, backgroundColor: c.line, marginVertical: 7 }} />
    <MenuRow Icon={ImageIcon} title="添加示例图片" onPress={addExample} />
    <MenuRow Icon={RotateCcw} title="重置样稿" onPress={() => {
      for (const timer of timers.current) clearTimeout(timer); timers.current.clear(); sending.current = false; setBusy(false);
      setSessions(initialSessions); setThread('home'); setDraftEpoch(value => value + 1); setModel(previewModels[0]!.model); setEffort('high'); setPermission('ask'); setPlan(false); setPanel(null);
      setScenes({}); setCondition('normal'); setAnswers({}); setPrepared({}); setFilesView(initialFileReview());
    }} />
  </View>;

  return <SafeAreaView style={[styles.root, { backgroundColor: framed ? c.sidebar : c.bg }]} edges={framed ? [] : ['top', 'bottom']}>
    <StatusBar style={dark ? 'light' : 'dark'} />
    <View style={[styles.workspace, framed && { paddingVertical: 25, gap: 50 }]}>
      {framed && <ScrollView style={styles.reviewRail} contentContainerStyle={{ paddingVertical: 14 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><FlaskConical size={19} color={c.accent} /><Text style={{ color: c.text, fontSize: 18, fontWeight: '600' }}>Codexer</Text></View>
        <Text style={{ color: c.muted, fontSize: 12, lineHeight: 21, marginTop: 12, marginBottom: 20 }}>完整功能交互稿 · 第三版{ '\n' }问答、计划、文件与设置的操作核对。</Text>
        {controls}<Text style={{ color: c.faint, fontSize: 11, lineHeight: 19, marginTop: 20 }}>示例数据，不操作真实设备。{ '\n' }可在右侧直接体验全部流程。</Text>
      </ScrollView>}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined} style={[styles.device, { backgroundColor: c.bg, flex: framed ? undefined : 1 }, framed && { width: 430, height: Math.min(900, height - 50), flexShrink: 0, borderRadius: 31, borderWidth: 1, borderColor: c.line, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 25, shadowOffset: { width: 0, height: 8 } }]}>
        <View style={[styles.previewBar, { borderBottomColor: c.line }]}><Text style={{ color: c.faint, fontSize: 10, letterSpacing: 0.4 }}>交互样稿 03 · 示例会话</Text><View style={{ flexDirection: 'row' }}>
          <ChromeButton Icon={dark ? Sun : Moon} label={dark ? '切换亮色' : '切换深色'} onPress={() => updatePreferences({ ...preferences, appearance: dark ? 'light' : 'dark' })} size={16} />
          {!framed && <ChromeButton Icon={Settings2} label="切换样稿场景" onPress={() => setPanel('workshop')} size={17} />}
        </View></View>
        <View ref={host} collapsable={false} style={{ flex: 1, minHeight: 0 }}>
          <View style={{ flex: 1 }} pointerEvents={panelOpen ? 'none' : 'auto'} accessibilityElementsHidden={panelOpen} importantForAccessibility={panelOpen ? 'no-hide-descendants' : 'auto'} aria-hidden={panelOpen}>
            <ConversationChromeHeader title={session.title} subtitle={`旅行相册 · PC 工作站${session.phase === 'interrupted' ? ' · 已暂停' : ''}`} usage={`${(session.tokens / 1000).toFixed(1)}K Token · $${amount}`} running={session.phase === 'running'} onDrawer={() => setPanel('projects')} onNew={newThread} onOptions={() => setPanel('options')} optionsAnchor={optionsAnchor} />
            {condition === 'offline' && <Text accessibilityLiveRegion="polite" style={{ color: c.taskRunning, backgroundColor: c.taskThreadBg, fontSize: 11, paddingHorizontal: 19, paddingVertical: 8 }}>示例设备离线 · 本地草稿可继续编辑</Text>}
            <ScrollView ref={list} style={{ flex: 1 }} contentContainerStyle={styles.messages} keyboardShouldPersistTaps="handled" scrollEventThrottle={60}
              onScrollBeginDrag={() => { follow.current = false; }} onScroll={event => { const { contentSize, contentOffset, layoutMeasurement } = event.nativeEvent; const away = contentSize.height - contentOffset.y - layoutMeasurement.height > 75; if (!away) follow.current = true; setJump(away); }}
              onContentSizeChange={() => { if (follow.current) list.current?.scrollToEnd({ animated: false }); }}>
              {session.messages.length ? session.messages.map(message => <View key={message.id} style={[message.role === 'user' ? styles.userMessage : styles.assistantMessage, message.role === 'user' && { backgroundColor: c.bubble }]}>
                {!!message.attachments?.length && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{message.attachments.map((item, index) => <Pressable key={index} accessibilityRole="button" accessibilityLabel={`查看 ${item.name}`} onPress={() => { setPreviewImage(item.uri); setPanel('image'); }} style={{ backgroundColor: c.composer, borderRadius: 10, padding: 8 }}><Text style={{ fontSize: 12, color: c.text }}>{item.name}</Text></Pressable>)}</View>}
                {!!message.text && <Markdown>{message.text}</Markdown>}
                {message.role === 'assistant' && <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: -11 }}><ChromeButton Icon={Copy} label="复制回复" onPress={() => copy(message.text)} size={14} /><Text style={{ color: c.timestamp, fontSize: 10 }}>16:24</Text></View>}
              </View>) : <View style={{ minHeight: 260, justifyContent: 'center', alignItems: 'center', gap: 10 }}><Text style={{ color: c.text, fontSize: 21, fontWeight: '600' }}>开始一个新任务</Text><Text style={{ color: c.muted, fontSize: 13 }}>描述想做的事情，也可以添加图片或文件</Text></View>}
              {scene === 'questions' && <QuestionReviewCard key={answerKey} answers={answers[answerKey] ?? emptyAnswers()} onChange={value => setAnswers(previous => ({ ...previous, [answerKey]: value }))} mode={questionMode} condition={condition} onAnswered={() => notify('示例回答已提交')} />}
              {scene === 'approval' && <ApprovalReviewCard key={`${thread}:${questionEpoch}`} condition={condition} />}
              {scene === 'plan' && <PlanReviewCard onOpen={() => setPanel('plan-reader')} onCopy={() => copy(planBody)} onExport={() => void exportPreviewText('旅行相册-交互方案.md', planBody, 'text/markdown').catch(() => notify('保存失败，请重试'))} onPrepare={preparePlan} prepared={!!prepared[thread]} />}
              {scene === 'conversation' && session.phase !== 'idle' && <View style={{ gap: 16 }}>
                <ChromeActivity phase={session.phase} elapsed={session.elapsed} tokens={session.tokens} cost={`$${amount}`} />
                {session.phase === 'running' ? <Text style={{ color: c.text, fontSize: 15, lineHeight: 25 }}>照片区域会保留更大的展示空间，操作入口收进卡片底部。接下来检查小屏布局和深色模式。</Text>
                  : session.phase === 'interrupted' ? <Text style={{ color: c.muted, fontSize: 14, lineHeight: 23 }}>任务已暂停。可以补充要求，也可以直接继续执行。</Text>
                    : <><Markdown>{'已完成首页调整：\n\n- 照片卡片采用更宽的预览比例。\n- 统一标题、留白和圆角。\n- 适配亮色与深色模式。\n\n检查已通过，可以继续调整交互细节。'}</Markdown><Pressable accessibilityRole="button" accessibilityLabel="查看本轮文件更改" onPress={() => openFiles('changed')} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 13, paddingHorizontal: 10, borderRadius: 12, backgroundColor: c.composer }}><FileText size={15} color={c.muted} /><Text style={{ color: c.muted, fontSize: 12, flex: 1 }}>已更改 {reviewChanges.length} 个文件</Text><Text style={{ color: c.success, fontSize: 11 }}>+{reviewChanges.reduce((sum, value) => sum + value.added, 0)}</Text><Text style={{ color: c.danger, fontSize: 11 }}>−{reviewChanges.reduce((sum, value) => sum + value.removed, 0)}</Text><ChevronDown size={13} color={c.muted} /></Pressable></>}
              </View>}
            </ScrollView>
            <View style={{ position: 'relative' }}>
              {jump && <Pressable accessibilityRole="button" accessibilityLabel="回到最新消息" onPress={() => { follow.current = true; setJump(false); list.current?.scrollToEnd({ animated: motion }); }} style={[styles.jump, { backgroundColor: c.surface, borderColor: c.line }]}><ArrowDown size={18} color={c.text} /></Pressable>}
              {!!prepared[thread] && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 20, paddingTop: 7 }}><ListChecks size={14} color={c.accent} /><Text style={{ flex: 1, color: c.muted, fontSize: 11 }}>{session.phase === 'running' ? '待执行方案 · 先停止当前任务或等待结束' : '待执行方案 · 发送时进入执行模式'}</Text><Pressable accessibilityRole="button" accessibilityLabel="取消待执行方案" onPress={() => setPrepared(value => ({ ...value, [thread]: false }))}><X size={14} color={c.muted} /></Pressable></View>}
              <ConversationChromeComposer text={draft.text} onChangeText={setText} phase={session.phase} busy={busy} disabledAction={condition === 'offline'} attachments={attachments} plan={plan} modelLabel={modelLabel(model, previewModels)} effortLabel={referenceEffortLabel(effort)} permission={permission} keepExpanded={panelOpen && (panel === 'model' || panel === 'advanced' || panel === 'permissions')} onSubmit={submit}
                onRemoveAttachment={id => id.startsWith('image-') ? setImages(value => value.filter(item => `image-${item.key}` !== id)) : setFiles(value => value.filter(item => `file-${item.key}` !== id))}
                onAttachmentPress={item => { setPreviewImage(item.uri); setPanel('image'); }} onAttachments={() => setPanel('attachments')} onModel={() => setPanel('model')} onPermissions={() => setPanel('permissions')} onClearPlan={() => setPlan(false)}
                attachmentAnchor={attachmentsAnchor} modelAnchor={modelAnchor} composerAnchor={composerAnchor} onImages={addImages} onFiles={addFiles} onImageError={notify} />
            </View>
          </View>
          {!!notice && <View pointerEvents="none" style={[styles.toast, { backgroundColor: c.text }]}><Text accessibilityLiveRegion="polite" style={{ color: c.surface, fontSize: 12 }}>{notice}</Text></View>}
          <ModelSurface open={panelOpen && panel === 'model'} host={host} anchor={modelAnchor} composerAnchor={composerAnchor} onClose={close}>
            <QuickModelPanel options={previewModels} model={model} effort={effort} onEffort={setEffort} onAdvanced={() => { Keyboard.dismiss(); setPanel('advanced'); }} />
          </ModelSurface>
          <InteractionSurface open={panelOpen && panel !== 'model'} host={host} anchor={anchor} kind={compactPanel ? 'popover' : panel === 'projects' ? 'drawer' : panel === 'files' || panel === 'settings' || panel === 'plan-reader' ? 'reader' : 'sheet'} onClose={() => setPanel(null)} onBack={close} title={surfaceTitle} width={248} align={panel === 'attachments' ? 'start' : 'end'} variant={panel === 'advanced' ? 'settings' : panel === 'permissions' ? 'permissions' : 'default'}>
            {panel === 'attachments' && <>
              <MenuRow Icon={Camera} title="相机" onPress={() => void pick('camera')} /><MenuRow Icon={ImageIcon} title="照片" onPress={() => void pick('photos')} /><MenuRow Icon={Video} title="视频" onPress={() => void pick('videos')} /><MenuRow Icon={Paperclip} title="文件" onPress={() => void pick('files')} />
              <View style={{ height: 1, backgroundColor: c.line, margin: 6 }} /><MenuRow Icon={ListChecks} title="方案模式" selected={plan} disabled={session.phase === 'running'} onPress={() => { setPlan(!plan); setPanel(null); }} />
            </>}
            {panel === 'advanced' && <AdvancedModelPanel options={previewModels} model={model} effort={effort} onModel={setModelValue} onEffort={setEffort} />}
            {panel === 'permissions' && <ChromePermissionPanel mode={permission} onChange={value => { setPermission(value); setPanel(null); }} />}
            {panel === 'options' && <><MenuRow Icon={Pencil} title="重命名" onPress={() => { setRename(session.title); setPanel('rename'); }} /><MenuRow Icon={Copy} title="复制会话 ID" onPress={() => { copy(`preview-${thread}`); setPanel(null); }} /><View style={{ backgroundColor: c.line, height: 1, margin: 6 }} /><MenuRow Icon={FileText} title="更改" onPress={() => openFiles('changed')} /><MenuRow Icon={Folder} title="文件" onPress={() => openFiles('all')} /><MenuRow Icon={Settings2} title="设置" onPress={openSettings} /></>}
            {panel === 'projects' && <ScrollView contentContainerStyle={{ gap: 5, paddingVertical: 12 }}><View style={[styles.pc, { backgroundColor: c.surface }]}><Monitor size={21} color={c.text} /><View style={{ flex: 1, gap: 3 }}><Text style={{ color: c.text, fontSize: 14 }}>PC 工作站</Text><Text style={{ color: c.muted, fontSize: 11 }}>已连接</Text></View>{runningCount > 0 && <TaskStatusDot running label="设备有任务进行中" />}{runningCount > 1 && <Text style={{ color: c.taskRunning, fontSize: 12 }}>{runningCount}</Text>}</View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, paddingTop: 16, paddingBottom: 9 }}><ChevronDown size={14} color={c.muted} /><Folder size={16} color={c.muted} /><Text style={{ color: c.text, fontSize: 14 }}>旅行相册</Text><Text style={{ color: c.faint, fontSize: 10 }}>38.6K · $0.21</Text></View>
              {Object.entries(sessions).map(([key, item]) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={`打开会话：${item.title}`} onPress={() => changeThread(key)} style={[styles.threadRow, { backgroundColor: item.phase === 'running' ? c.taskThreadBg : key === thread ? c.soft : 'transparent' }]}>{item.phase === 'running' && <TaskStatusDot running label="任务进行中" />}<Text numberOfLines={1} style={{ color: c.text, flex: 1, fontSize: 13 }}>{item.title}</Text>{key === thread && <Check size={14} color={c.accent} />}</Pressable>)}
              <MenuRow Icon={Plus} title="新建会话" onPress={newThread} />
              <MenuRow Icon={Folder} title="浏览项目文件" onPress={() => openFiles('all')} /><MenuRow Icon={Settings2} title="设置" onPress={openSettings} />
            </ScrollView>}
            {panel === 'workshop' && <ScrollView contentContainerStyle={{ paddingBottom: 10 }}>{controls}</ScrollView>}
            {panel === 'plan-reader' && <PlanReviewReader onCopy={() => copy(planBody)} onPrepare={preparePlan} onNotice={notify} />}
            {panel === 'files' && <FileReviewPanel state={filesView} onChange={setFilesView} condition={condition} onCopy={copy} onNotice={notify} />}
            {panel === 'settings' && <SettingsReviewPanel section={settingsSection} onSection={setSettingsSection} preferences={preferences} onPreferences={updatePreferences} condition={condition} onCopy={copy} onNotice={notify} />}
            {panel === 'image' && <View style={{ height: 280, justifyContent: 'center', alignItems: 'center' }}>{previewImage ? <Image source={{ uri: previewImage }} resizeMode="contain" style={{ width: '100%', height: '100%' }} /> : <><FileText size={35} color={c.muted} /><Text style={{ color: c.muted, marginTop: 14 }}>已添加到当前草稿</Text></>}</View>}
            {panel === 'rename' && <View style={{ padding: 8, gap: 16 }}><TextInput accessibilityLabel="会话名称" value={rename} onChangeText={setRename} autoFocus maxLength={1000} style={{ color: c.text, backgroundColor: c.input, borderRadius: 12, padding: 13, fontSize: 15 }} /><Pressable accessibilityRole="button" disabled={!rename.trim()} onPress={() => { updateSession(value => ({ ...value, title: rename.trim() })); setPanel(null); }} style={{ backgroundColor: c.solid, minHeight: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', opacity: rename.trim() ? 1 : 0.4 }}><Text style={{ color: c.onSolid }}>保存</Text></Pressable></View>}
          </InteractionSurface>
        </View>
      </KeyboardAvoidingView>
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, workspace: { flex: 1, minHeight: 0, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  reviewRail: { width: 245, maxWidth: 245, flexGrow: 0, flexShrink: 0, alignSelf: 'stretch', maxHeight: '100%', paddingHorizontal: 8 }, device: { minHeight: 0, alignSelf: 'stretch' },
  previewBar: { minHeight: 39, height: 39, paddingLeft: 17, paddingRight: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth },
  messages: { paddingHorizontal: 19, paddingTop: 20, paddingBottom: 25, gap: 24 },
  userMessage: { alignSelf: 'flex-end', maxWidth: '88%', paddingHorizontal: 14, paddingTop: 9, paddingBottom: 7, borderRadius: 20 }, assistantMessage: { alignSelf: 'stretch' },
  jump: { position: 'absolute', top: -44, alignSelf: 'center', width: 33, height: 33, borderWidth: 1, borderRadius: 17, justifyContent: 'center', alignItems: 'center' },
  toast: { position: 'absolute', top: 80, alignSelf: 'center', paddingHorizontal: 17, paddingVertical: 11, borderRadius: 20, zIndex: 70, maxWidth: '90%' },
  pc: { marginHorizontal: 7, padding: 13, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 9 },
  threadRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 5, paddingHorizontal: 12, minHeight: 45, borderRadius: 12, marginLeft: 21 },
});
