import { themedStyles } from './theme';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Crosshair, Maximize2, MessageSquare, Minimize2, RefreshCw, Share2, SlidersHorizontal, X } from 'lucide-react-native';
import { buildPreviewDocument } from '../../../packages/client-shared/src/preview-runtime';
import { MAX_PREVIEW_HTML_BYTES, previewControls, previewFeedback, restoredControlValue, widgetState } from '../../../packages/client-shared/src/previews';
import type { PreviewReference, TweakControl, WidgetState } from '../../../packages/client-shared/src/previews';
import { previewFile, fileError } from './file-transfer';
import { relay } from './relay';
import { randomId } from './runtime';
import { readPreviewState, savePreviewState } from './preview-storage';
import { PreviewSurface } from './preview-surface';
import type { PreviewSurfaceHandle } from './preview-surface.types';
import { PreviewRange } from './preview-range';
import { PreviewColor } from './preview-color';
import { useTheme } from './styles';
import { PreviewShareDialog } from './preview-share-dialog';

const controlKey = (control: TweakControl) => `${control.group}:${control.label}:${control.kind}`;
let stopActivePreview: (() => void) | undefined;
export function PreviewCard({ reference, deviceId, threadId }: { reference: PreviewReference; deviceId: string; threadId: string }) {
  const { c } = useTheme();
  const ps = usePsStyles();
  const [revision, setRevision] = useState(0), [expanded, setExpanded] = useState(false), [tweaking, setTweaking] = useState(false);
  const [sharing,setSharing]=useState(false);
  const [enabled, setEnabled] = useState(false);
  const [document, setDocument] = useState<string>(), [url, setUrl] = useState<string>(), [channel, setChannel] = useState('');
  const [height, setHeight] = useState(280), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [controls, setControls] = useState<TweakControl[]>([]), [feedback, setFeedback] = useState<string | null>(null), [sending, setSending] = useState(false);
  const [annotating, setAnnotating] = useState(false), [selection, setSelection] = useState<{ selector: string; tag: string; text: string } | null>(null);
  const state = useRef<WidgetState | null>(null), tweaks = useRef<Record<string, string | number | boolean>>({});
  const surface = useRef<PreviewSurfaceHandle>(null), alive = useRef(true), storageWrites = useRef<Promise<void>>(Promise.resolve());
  const key = relay.previewStateKey(deviceId, threadId, reference.source);
  const active = useRef('');
  const persist = useCallback(() => {
    const snapshot = { state: state.current, tweaks: { ...tweaks.current } };
    const write = storageWrites.current.catch(() => {}).then(() => savePreviewState(key, snapshot));
    storageWrites.current = write; return write;
  }, [key]);
  useEffect(() => {
    if (!enabled) return;
    stopActivePreview?.();
    const stop = () => { setEnabled(false); setExpanded(false); };
    stopActivePreview = stop;
    return () => { if (stopActivePreview === stop) stopActivePreview = undefined; };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    const abort = new AbortController(), nextChannel = randomId(); active.current = nextChannel;
    let serverSource: string | undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    setLoading(true); setHeight(280); setError(''); setDocument(undefined); setUrl(undefined); setControls([]); setChannel(nextChannel); setAnnotating(false); setSelection(null);
    void (async () => {
      try {
        await storageWrites.current.catch(() => {});
        const saved = await readPreviewState(key); if (abort.signal.aborted) return;
        state.current = widgetState(saved?.state); tweaks.current = saved?.tweaks ?? {};
        if (reference.kind === 'html') {
          const info = await relay.fileInfo(deviceId, threadId, reference.source, abort.signal);
          if (info.size > MAX_PREVIEW_HTML_BYTES) throw new Error('预览超过 2 MB，请精简内容后重试');
          const html = await previewFile(relay.fileSource(deviceId, threadId, reference.source, info.version), info, abort.signal);
          if (!abort.signal.aborted) setDocument(buildPreviewDocument(html, nextChannel, state.current));
        } else {
          const value = await relay.openPreview(deviceId, threadId, reference.source, nextChannel, state.current, abort.signal);
          serverSource=value;
          if (!abort.signal.aborted) {
            setUrl(value);
            renewal = setInterval(() => {
              void relay.renewPreview(value).catch(error => {
                if (!abort.signal.aborted) { setError(fileError(error)); clearInterval(renewal); }
              });
            }, 30000);
          }
          else void relay.closePreview(value).catch(()=>{});
        }
        if (!abort.signal.aborted) setLoading(false);
      } catch (error) { if (!abort.signal.aborted) { setLoading(false); setError(fileError(error)); } }
    })();
    return () => { alive.current = false; active.current = ''; abort.abort(); clearInterval(renewal); if(serverSource) void relay.closePreview(serverSource).catch(()=>{}); };
  }, [enabled, deviceId, threadId, reference.kind, reference.source, key, revision]);
  const receive = useCallback((value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    if (message.channel !== active.current) return;
    if (message.type === 'height' && typeof message.height === 'number' && Number.isFinite(message.height)) setHeight(Math.min(480, Math.max(120, message.height)));
    if (message.type === 'state' && typeof message.id === 'string' && message.id.length <= 100) {
      const parsed = widgetState(message.state); if (!parsed) return;
      state.current = parsed;
      void persist().then(() => { if (alive.current && active.current === message.channel) surface.current?.send({ type: 'state-result', id: message.id, ok: true }); }).catch(() => { if (active.current === message.channel) surface.current?.send({ type: 'state-result', id: message.id, ok: false }); });
    }
    if (message.type === 'controls' && Array.isArray(message.controls)) {
      const next = previewControls(message.controls);
      setControls(next);
      for (const control of next) {
        const savedKey = controlKey(control);
        const value = restoredControlValue(control, tweaks.current[savedKey]);
        if (value === undefined) delete tweaks.current[savedKey];
        else tweaks.current[savedKey] = value;
        if (value !== undefined && value !== control.value) surface.current?.send({ type: 'tweak', id: control.id, value });
      }
    }
    if (message.type === 'follow-up' && typeof message.prompt === 'string') setFeedback(message.prompt.slice(0, 20000));
    if (message.type === 'selection' && typeof message.selector === 'string' && typeof message.tag === 'string' && typeof message.text === 'string') {
      setSelection({selector:message.selector.slice(0,1000),tag:message.tag.slice(0,60),text:message.text.slice(0,300)}); setAnnotating(false); setTweaking(true);
    }
  }, [persist]);
  const change = (control: TweakControl, value: string | number | boolean) => {
    tweaks.current[controlKey(control)] = value; surface.current?.send({ type: 'tweak', id: control.id, value });
    setControls(previous => previous.map(item => item.id === control.id ? { ...item, value } : item));
    void persist().catch(() => relay.showNotice('参数已调整，但未能保存预览状态'));
  };
  const sendFeedback = async () => {
    if (sending || feedback === null) return;
    setSending(true);
    try {
      const note = selection ? `${feedback}\n\n所选元素：${JSON.stringify(selection)}` : feedback;
      const prompt = previewFeedback(reference, note, state.current, controls);
      const result = await relay.sendCommand(deviceId, { type: 'turn.queue', threadId, text: prompt });
      if (result.status !== 'succeeded') throw new Error(result.code);
      setFeedback(null); relay.showNotice('预览反馈已发送到当前会话');
    } catch (error) { relay.showNotice(error instanceof Error ? error.message : '反馈发送失败'); }
    finally { setSending(false); }
  };
  const content = <View style={[ps.card, expanded && ps.fullCard]}>
    <View style={ps.header}><Text style={ps.title} numberOfLines={1}>{reference.title}</Text><View style={ps.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel="分享网页" onPress={() => setSharing(true)} style={ps.icon}><Share2 size={16} color={c.muted}/></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="刷新预览" onPress={() => { setEnabled(true); setRevision(value => value + 1); }} style={ps.icon}><RefreshCw size={16} color={c.muted} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="调整预览参数" onPress={() => setTweaking(value => !value)} style={ps.icon}><SlidersHorizontal size={16} color={tweaking ? c.accent : c.muted} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={annotating ? '取消元素标注' : '标注预览元素'} onPress={() => { surface.current?.send({type:'annotate',enabled:!annotating}); setAnnotating(!annotating); }} style={ps.icon}><Crosshair size={16} color={annotating ? c.accent : c.muted} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="反馈给 Codex" onPress={() => setFeedback('')} style={ps.icon}><MessageSquare size={16} color={c.muted} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起全屏预览' : '展开全屏预览'} onPress={() => { setEnabled(true); setExpanded(value => !value); setRevision(value => value + 1); }} style={ps.icon}>{expanded ? <Minimize2 size={16} color={c.muted} /> : <Maximize2 size={16} color={c.muted} />}</Pressable>
      {enabled && <Pressable accessibilityRole="button" accessibilityLabel="关闭预览" onPress={() => { setEnabled(false); setExpanded(false); }} style={ps.icon}><X size={16} color={c.muted}/></Pressable>}
    </View></View>
    {annotating && <View style={ps.annotation}><Text style={ps.link}>点击预览中的元素，选择要调整的位置。</Text></View>}
    {selection && <View style={ps.annotation}><Text style={ps.muted}>已选择 {selection.tag}：{selection.text || selection.selector}</Text><Pressable accessibilityRole="button" onPress={() => setFeedback('')}><Text style={ps.link}>反馈这个元素</Text></Pressable></View>}
    <View style={expanded && ps.fullPreview}>
      {!enabled ? <View style={ps.status}><Pressable accessibilityRole="button" accessibilityLabel={`打开预览 ${reference.title}`} onPress={() => setEnabled(true)}><Text style={ps.link}>打开预览</Text></Pressable><Text style={ps.muted}>点击后加载并运行网页</Text></View> : loading ? <View style={[ps.status, expanded && ps.fullStatus]}><ActivityIndicator color={c.accent} /><Text style={ps.muted}>正在从电脑加载预览…</Text></View> : error ? <View style={[ps.status, expanded && ps.fullStatus]}><Text style={ps.error}>{error}</Text><Pressable accessibilityRole="button" onPress={() => setRevision(value => value + 1)}><Text style={ps.link}>重试</Text></Pressable></View> : <PreviewSurface key={channel} surfaceRef={surface} document={document} url={url} channel={channel} height={height} expanded={expanded} title={reference.title} onMessage={receive} />}
    </View>
    {tweaking && <ScrollView style={[ps.tweakScroll, expanded && ps.fullTweaks]} contentContainerStyle={ps.tweaks}><Text style={ps.group}>Tweak · 参数调节</Text>{!controls.length && <Text style={ps.muted}>这个预览没有提供可调参数。可以通过“反馈给 Codex”描述希望增加的控件。</Text>}{controls.map(control => <View key={control.id} style={ps.control}>
      <View style={ps.controlHead}><Text style={ps.label}>{control.group} · {control.label}</Text><Text style={ps.muted}>{control.kind === 'toggle' ? '' : String(control.value)}</Text></View>
      {control.kind === 'slider' ? <PreviewRange label={control.label} value={Number(control.value)} min={control.min ?? 0} max={control.max ?? 100} step={control.step ?? 1} onChange={value => change(control, value)} /> : control.kind === 'toggle' ? <Switch accessibilityLabel={control.label} value={!!control.value} onValueChange={value => change(control, value)} /> : control.kind === 'select' ? <View style={ps.options}>{control.options?.map(option => <Pressable key={option.value} accessibilityRole="button" accessibilityState={{ selected: option.value === control.value }} onPress={() => change(control, option.value)} style={[ps.option, option.value === control.value && ps.selected]}><Text style={ps.label}>{option.label}</Text></Pressable>)}</View> : <PreviewColor label={control.label} value={String(control.value)} onChange={value => change(control,value)} />}
    </View>)}{!!controls.length && <View style={ps.options}><Pressable accessibilityRole="button" onPress={() => { controls.forEach(control => change(control, control.initial)); }} style={ps.option}><Text style={ps.label}>恢复初始参数</Text></Pressable><Pressable accessibilityRole="button" onPress={() => setFeedback('请将当前参数调整应用到源文件。')} style={ps.option}><Text style={ps.link}>将调整反馈给 Codex</Text></Pressable></View>}</ScrollView>}
  </View>;
  return <>
    {sharing&&!expanded&&<PreviewShareDialog key={key} reference={reference} deviceId={deviceId} threadId={threadId} onClose={()=>setSharing(false)}/>}
    {!expanded && content}
    <Modal visible={expanded} animationType="fade" onRequestClose={() => { setExpanded(false); setRevision(value => value + 1); }}><SafeAreaProvider style={ps.full}><SafeAreaView style={ps.full} edges={['top', 'bottom']}>{expanded && content}{sharing&&expanded&&<PreviewShareDialog key={key} reference={reference} deviceId={deviceId} threadId={threadId} onClose={()=>setSharing(false)}/>}</SafeAreaView></SafeAreaProvider></Modal>
    <Modal visible={feedback !== null} transparent animationType="fade" onRequestClose={() => { if (!sending) setFeedback(null); }}><View style={ps.backdrop}><View style={ps.dialog}><View style={ps.header}><Text style={ps.title}>反馈给 Codex</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭反馈" disabled={sending} onPress={() => setFeedback(null)} style={ps.icon}><X size={18} color={c.muted} /></Pressable></View><ScrollView><TextInput accessibilityLabel="预览反馈内容" multiline value={feedback ?? ''} onChangeText={setFeedback} placeholder="描述希望修改的地方…" style={[ps.field, ps.feedback]} /><Text style={ps.muted}>会附上当前交互选择和参数调整，发送到当前会话。</Text>{controls.some(control => control.value !== control.initial) && <Text style={ps.context}>{controls.filter(control => control.value !== control.initial).map(control => `${control.label}：${control.initial} → ${control.value}`).join('\n')}</Text>}</ScrollView><Pressable accessibilityRole="button" disabled={sending || !feedback?.trim() && !controls.some(control => control.value !== control.initial)} onPress={() => void sendFeedback()} style={[ps.send, sending && { opacity: .5 }]}><Text style={ps.sendText}>{sending ? '正在发送…' : '发送反馈'}</Text></Pressable></View></View></Modal>
  </>;
}
const usePsStyles = themedStyles(c => StyleSheet.create({
  card: { width: '100%', borderWidth: 1, borderColor: c.line, borderRadius: 10, overflow: 'hidden', backgroundColor: c.surface, marginVertical: 10 },
  header: { minHeight: 45, paddingHorizontal: 10, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderColor: c.line },
  title: { color: c.text, fontSize: 13, fontWeight: '600', flex: 1, minWidth: 0 }, actions: { flexDirection: 'row', flexShrink: 0 }, icon: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  status: { padding: 22, gap: 12, alignItems: 'center' }, annotation: {padding:10,gap:6,backgroundColor:c.soft}, muted: { color: c.muted, fontSize: 12 }, error: { color: c.danger, fontSize: 13 }, link: { color: c.accent, fontSize: 13 },
  tweakScroll: { flexGrow: 0, flexShrink: 0 }, fullTweaks: { maxHeight: '40%', flexShrink: 1 }, tweaks: { borderTopWidth: 1, borderColor: c.line, padding: 14, gap: 12 }, group: { fontSize: 13, fontWeight: '600', color: c.text }, control: { gap: 6 }, controlHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, label: { color: c.text, fontSize: 12, flexShrink: 1 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, option: { borderWidth: 1, borderColor: c.line, borderRadius: 6, padding: 10 }, selected: { backgroundColor: c.soft, borderColor: c.accent },
  field: { borderWidth: 1, borderColor: c.line, borderRadius: 7, padding: 10, color: c.text, fontSize: 14 }, feedback: { minHeight: 110, textAlignVertical: 'top', marginVertical: 14 }, context: { fontSize: 12, color: c.text, marginTop: 10 },
  full: { flex: 1, minHeight: 0, backgroundColor: c.surface }, fullCard: { flex: 1, minHeight: 0, marginVertical: 0, borderWidth: 0, borderRadius: 0 }, fullPreview: { flex: 1, minHeight: 0, minWidth: 0 }, fullStatus: { flex: 1, justifyContent: 'center' }, backdrop: { flex: 1, backgroundColor: '#0005', justifyContent: 'center', alignItems: 'center', padding: 20 }, dialog: { width: '100%', maxWidth: 560, maxHeight: '85%', borderRadius: 12, padding: 14, backgroundColor: c.surface }, send: { padding: 12, borderRadius: 7, backgroundColor: c.accent, alignItems: 'center', marginTop: 16 }, sendText: { color: c.onAccent, fontSize: 14, fontWeight: '600' },
}));
