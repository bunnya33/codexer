import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { Camera, Images, ListChecks, Paperclip, X } from 'lucide-react-native';
import type { ModelOption, ModelSettings, PermissionMode } from '../../../packages/protocol/src/index';
import { modelLabel } from '../../../packages/client-shared/src/models';
import type { ComposerProps } from './composer';
import { useTheme } from './styles';
import { ConversationChromeComposer } from './interaction/conversation-chrome';
import type { ChromeAttachment, ConversationPhase } from './interaction/conversation-chrome';
import { InteractionSurface } from './interaction/surface';
import { ModelSurface } from './interaction/model-surface';
import { AdvancedModelPanel, QuickModelPanel, referenceEffortLabel } from './interaction/model-panel';
import { ChromePermissionPanel } from './interaction/permission-panel';
import { ChromeButton, MenuRow } from './interaction/primitives';

type Props = {
  children: ReactNode;
  text: string; onChangeText: (value: string) => void; phase: ConversationPhase; busy: boolean; ready: boolean; submitDisabled: boolean;
  attachments: ChromeAttachment[]; onRemoveAttachment: (id: string) => void; onRetryAttachment: (id: string) => void; onAttachmentPress: (item: ChromeAttachment) => void;
  settings?: ModelSettings; options: ModelOption[]; modelEnabled: boolean; effortEnabled: boolean; permissionsEnabled: boolean; modeEnabled: boolean;
  onModel: (model: string) => Promise<boolean>; onEffort: (effort: string) => Promise<boolean>; onPermission: (mode: PermissionMode) => Promise<boolean>;
  onMode: (mode: 'default' | 'plan') => Promise<boolean>; onSubmit: () => void;
  preparedPlan?: string; onRemovePreparedPlan?: () => void;
  onMedia: () => void; onCamera: () => void; onFilesPick: () => void; imageLimit: number; videoLimitMB: number; filesSupported: boolean;
} & Pick<ComposerProps, 'onImages' | 'imagesEnabled' | 'onImageError' | 'onFiles' | 'filesEnabled' | 'imageSlots'>;

/** Shared production controls. Selection previews never issue runtime commands until committed. */
export function ConversationControls(props: Props) {
  const { c } = useTheme();
  const [panel, setPanelContent] = useState<'attachments' | 'model' | 'advanced' | 'permissions' | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [model, setModel] = useState(props.settings?.model ?? '');
  const [effort, setEffort] = useState(props.settings?.reasoningEffort ?? '');
  const lock = useRef(false), mounted = useRef(true);
  const host = useRef<View>(null), attachmentAnchor = useRef<View>(null), modelAnchor = useRef<View>(null), composerAnchor = useRef<View>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setModel(props.settings?.model ?? ''); setEffort(props.settings?.reasoningEffort ?? ''); }, [props.settings?.model, props.settings?.reasoningEffort]);
  useEffect(() => { if (!props.ready) setOpen(false); }, [props.ready]);
  const close = () => setOpen(false);
  const show = (next: NonNullable<typeof panel>) => { setError(''); setPanelContent(next); setOpen(true); };
  const save = async (operation: () => Promise<boolean>, rollback?: () => void) => {
    if (lock.current || props.busy || !props.ready) return false;
    lock.current = true; setSaving(true); setError('');
    try {
      const ok = await operation();
      if (!mounted.current) return ok;
      if (!ok) { rollback?.(); setError('更改未保存，请重试。'); }
      return ok;
    } catch {
      if (mounted.current) { rollback?.(); setError('更改未保存，请重试。'); }
      return false;
    } finally { lock.current = false; if (mounted.current) setSaving(false); }
  };
  const commitEffort = (next: string) => {
    if (next === props.settings?.reasoningEffort || !props.effortEnabled || saving) return;
    setEffort(next);
    void save(() => props.onEffort(next), () => setEffort(props.settings?.reasoningEffort ?? ''));
  };
  const commitModel = (next: string) => {
    if (next === props.settings?.model || !props.modelEnabled || saving) return;
    const option = props.options.find(item => item.model === next);
    setModel(next);
    setEffort(option?.supportedReasoningEfforts.includes(effort) ? effort : option?.defaultReasoningEffort ?? '');
    void save(() => props.onModel(next), () => { setModel(props.settings?.model ?? ''); setEffort(props.settings?.reasoningEffort ?? ''); });
  };
  const pending = saving || props.busy;
  const modelAvailable = props.modelEnabled || props.effortEnabled;
  const pick = (action: () => void) => { close(); action(); };
  const feedback = <>
    {saving && <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 8, padding: 12 }}><ActivityIndicator size="small" color={c.muted} /><Text style={{ color: c.muted, fontSize: 12 }}>正在保存…</Text></View>}
    {!!error && <Text accessibilityRole="alert" style={{ color: c.danger, fontSize: 12, padding: 12 }}>{error}</Text>}
  </>;
  return <View ref={host} collapsable={false} style={{ flex: 1 }}>
    <View style={{ flex: 1 }} pointerEvents={open ? 'none' : 'auto'} aria-hidden={open} accessibilityElementsHidden={open} importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}>
    {props.children}
    <View style={{ width: '100%', maxWidth: 900, alignSelf: 'center' }}>
    {!!props.preparedPlan && <View testID="prepared-plan" style={{ marginHorizontal: 16, marginBottom: 6, paddingLeft: 12, borderRadius: 14, backgroundColor: c.composer, flexDirection: 'row', alignItems: 'center', gap: 8 }}><ListChecks size={16} color={c.muted} /><Text numberOfLines={2} style={{ color: c.text, flex: 1, fontSize: 12 }}>准备执行：{props.preparedPlan}{props.phase === 'running' ? ' · 等待当前任务结束' : ''}</Text><ChromeButton Icon={X} label="移除待执行方案" onPress={() => props.onRemovePreparedPlan?.()} disabled={props.busy} size={16} /></View>}
    <ConversationChromeComposer inputLabel="给 Codex 发送消息" attachmentsLabel="添加附件" text={props.text} onChangeText={props.onChangeText} phase={props.phase} busy={props.busy} disabledAction={props.submitDisabled || saving}
      attachments={props.attachments} onRemoveAttachment={props.onRemoveAttachment} onRetryAttachment={props.onRetryAttachment} onAttachmentPress={props.onAttachmentPress}
      plan={props.settings?.collaborationMode === 'plan'} permission={props.settings?.permissions?.mode ?? 'ask'}
      modelLabel={modelLabel(model, props.options)} effortLabel={referenceEffortLabel(effort)}
      onSubmit={props.onSubmit} onAttachments={() => show('attachments')} onModel={() => show('model')} onPermissions={() => show('permissions')}
      onClearPlan={() => { void save(() => props.onMode('default')); }} attachmentAnchor={attachmentAnchor} modelAnchor={modelAnchor} composerAnchor={composerAnchor}
      attachmentsEnabled={props.ready && !saving} modelEnabled={props.ready && modelAvailable && !pending}
      permissionsEnabled={props.ready && props.permissionsEnabled && !pending} planEnabled={props.modeEnabled}
      onImages={props.onImages} onImageError={props.onImageError} imagesEnabled={props.imagesEnabled && !pending} imageSlots={props.imageSlots}
      onFiles={props.onFiles} filesEnabled={props.filesEnabled && !pending} />
    </View>
    </View>
    {panel !== 'model' && <InteractionSurface open={open} host={host} anchor={panel === 'attachments' ? attachmentAnchor : undefined}
      title={panel === 'advanced' ? '高级' : panel === 'permissions' ? '会话权限' : '附件和模式'} kind={panel === 'attachments' ? 'popover' : 'sheet'}
      variant={panel === 'advanced' ? 'settings' : panel === 'permissions' ? 'permissions' : 'attachment-menu'} onClose={close}>
      {panel === 'attachments' ? <>
        {['ios', 'android', 'web'].includes(Platform.OS) && <MenuRow Icon={Camera} title="相机" accessibilityLabel="拍照添加图片" disabled={!props.imagesEnabled} onPress={() => pick(props.onCamera)} />}
        <MenuRow Icon={Images} title="图片与视频" accessibilityLabel="添加图片与视频" disabled={!props.imagesEnabled && !props.filesEnabled} onPress={() => pick(props.onMedia)} />
        <MenuRow Icon={Paperclip} title="文件" accessibilityLabel="添加文件" disabled={!props.filesEnabled} onPress={() => pick(props.onFilesPick)} />
        <View style={{ height: 1, backgroundColor: c.line, marginVertical: 6 }} />
        <MenuRow Icon={ListChecks} title="方案模式" selected={props.settings?.collaborationMode === 'plan'} disabled={!props.modeEnabled || pending}
          detail={props.modeEnabled ? '先讨论和形成计划' : '会话空闲且连接器支持时可切换'} onPress={() => { void save(() => props.onMode(props.settings?.collaborationMode === 'plan' ? 'default' : 'plan')).then(ok => { if (ok && mounted.current) close(); }); }} />
        <Text style={{ color: c.muted, fontSize: 11, lineHeight: 17, padding: 12 }}>最多 {props.imageLimit} 张图片{props.filesSupported ? `；最多 4 个文件，视频每个 ${props.videoLimitMB} MB，其他文件每个 20 MB` : '；此连接器不支持文件和视频'}</Text>
      </> : panel === 'advanced' ? <AdvancedModelPanel options={props.options} model={model} effort={effort} onModel={commitModel} onEffort={commitEffort} disabled={pending} modelDisabled={!props.modelEnabled} effortDisabled={!props.effortEnabled} />
        : panel === 'permissions' && props.settings?.permissions ? <ChromePermissionPanel labelPrefix="权限：" settings={props.settings.permissions} mode={props.settings.permissions.mode} disabled={pending || !props.permissionsEnabled}
          onChange={mode => { void save(() => props.onPermission(mode)).then(ok => { if (ok && mounted.current) close(); }); }} /> : null}
      {feedback}
    </InteractionSurface>}
    {(panel === 'model' || panel === 'advanced') && <ModelSurface open={open && panel === 'model'} host={host} anchor={modelAnchor} composerAnchor={composerAnchor} onClose={close}>
      <View style={{ position: 'absolute', bottom: 112, left: 0, right: 0 }}>{feedback}</View>
      <QuickModelPanel options={props.options} model={model} effort={effort} onEffort={setEffort} onCommit={commitEffort} disabled={pending} effortDisabled={!props.effortEnabled} onAdvanced={() => show('advanced')} />
    </ModelSurface>}
  </View>;
}
