import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ActivityIndicator, Animated, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ArrowUp, Check, ListChecks, Menu, MoreHorizontal, Paperclip, Play, Plus, Square, SquarePen, X } from 'lucide-react-native';
import type { PermissionSettings } from '../../../../packages/protocol/src/index';
import { useTheme } from '../styles';
import { MarqueeTitle } from '../marquee-title';
import { TaskStatusDot } from '../task-status-dot';
import { ComposerInput } from '../composer';
import type { ComposerProps } from '../composer';
import { ChromeButton } from './primitives';
import { useInteractionMotion } from './motion';
import { chromePermissionLabels, PermissionSymbol } from './control-symbols';

export type ConversationPhase = 'idle' | 'running' | 'interrupted' | 'completed';
export type ComposerAction = 'send' | 'steer' | 'stop' | 'continue';
export type ChromeAttachment = { id: string; name: string; uri?: string; detail?: string; loading?: boolean; error?: string; uploaded?: boolean };

export function composerAction(phase: ConversationPhase, hasContent: boolean): ComposerAction {
  if (phase === 'running') return hasContent ? 'steer' : 'stop';
  if (phase === 'interrupted' && !hasContent) return 'continue';
  return 'send';
}
export const actionLabels: Record<ComposerAction, string> = { send: '发送消息', steer: '发送引导消息', stop: '停止当前任务', continue: '继续任务' };

export function ConversationChromeHeader({ title, subtitle, usage, running, onDrawer, onNew, onOptions, optionsAnchor }: {
  title: string; subtitle: string; usage: string; running: boolean; onDrawer: () => void; onNew: () => void; onOptions: () => void; optionsAnchor: RefObject<View | null>;
}) {
  const { c } = useTheme();
  return <View style={[styles.header, { backgroundColor: c.surface }]}>
    <ChromeButton Icon={Menu} label="打开项目列表" onPress={onDrawer} />
    <View style={styles.headerText}><View style={styles.titleRow}>{running && <TaskStatusDot running label="任务进行中" />}<MarqueeTitle text={title} /></View>
      <Text numberOfLines={1} style={[styles.subtitle, { color: c.muted }]}>{subtitle}</Text>
      <Text testID="chrome-thread-usage" numberOfLines={1} style={[styles.usage, { color: c.faint }]}>{usage}</Text>
    </View>
    <ChromeButton Icon={SquarePen} label="新建示例会话" onPress={onNew} />
    <View ref={optionsAnchor} collapsable={false}><ChromeButton Icon={MoreHorizontal} label="会话选项" onPress={onOptions} /></View>
  </View>;
}

export function ConversationChromeComposer({ text, onChangeText, phase, busy = false, disabledAction = false, attachments, onRemoveAttachment, onAttachmentPress, plan, modelLabel, effortLabel,
  onSubmit, onAttachments, onModel, onPermissions, onClearPlan, attachmentAnchor, modelAnchor, composerAnchor, permission, keepExpanded, onFocus,
  attachmentsEnabled = true, modelEnabled = true, permissionsEnabled = true, planEnabled = true, onRetryAttachment, inputLabel = '消息内容', attachmentsLabel = '添加附件和模式', ...media }: {
  text: string; onChangeText: (text: string) => void; phase: ConversationPhase; busy?: boolean; disabledAction?: boolean; attachments: ChromeAttachment[]; keepExpanded?: boolean;
  onRemoveAttachment: (id: string) => void; onAttachmentPress: (item: ChromeAttachment) => void;
  plan: boolean; modelLabel: string; effortLabel: string; permission: PermissionSettings['mode']; onSubmit: (action: ComposerAction) => void;
  onAttachments: () => void; onModel: () => void; onPermissions: () => void; onClearPlan: () => void;
  attachmentAnchor: RefObject<View | null>; modelAnchor: RefObject<View | null>; composerAnchor?: RefObject<View | null>; onFocus?: () => void;
  attachmentsEnabled?: boolean; modelEnabled?: boolean; permissionsEnabled?: boolean; planEnabled?: boolean; onRetryAttachment?: (id: string) => void;
  inputLabel?: string; attachmentsLabel?: string;
} & Pick<ComposerProps, 'onImages' | 'onImageError' | 'onFiles'> & Partial<Pick<ComposerProps, 'imagesEnabled' | 'filesEnabled' | 'imageSlots'>>) {
  const { c } = useTheme();
  const motion = useInteractionMotion();
  const [focused, setFocused] = useState(false);
  const [composerWidth, setComposerWidth] = useState(0);
  const [modelWidth, setModelWidth] = useState(0);
  const expansion = useRef(new Animated.Value(0)).current;
  // Leave a readable input beside the wider model entry, or use the expanded layout.
  const compactRight = Math.max(93, modelWidth + 49);
  const expanded = focused || !!text || !!attachments.length || plan || !!keepExpanded || composerWidth > 0 && composerWidth - 88 - compactRight < 96;
  const hasContent = !!text.trim() || !!attachments.length;
  const action = composerAction(phase, hasContent);
  const disabled = busy || disabledAction || action === 'send' && !hasContent;
  const ActionIcon = action === 'stop' ? Square : action === 'continue' ? Play : ArrowUp;
  useEffect(() => {
    const animation = Animated.timing(expansion, { toValue: expanded ? 1 : 0, duration: motion ? 180 : 0, useNativeDriver: false });
    animation.start(); return () => animation.stop();
  }, [expanded, motion, expansion]);
  const submit = () => { if (!disabled) onSubmit(action); };
  return <View style={styles.composerDock}>
    <Animated.View ref={composerAnchor} collapsable={false} testID="chrome-composer" onLayout={event => setComposerWidth(event.nativeEvent.layout.width)} style={[styles.composer, { backgroundColor: c.composer,
      paddingBottom: expansion.interpolate({ inputRange: [0, 1], outputRange: [4, 49] }),
    }]}>
      {!!attachments.length && <ScrollView horizontal style={styles.attachments} contentContainerStyle={{ gap: 8, padding: 5 }} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {attachments.map(item => <View key={item.id} style={[styles.attachment, { backgroundColor: c.surface }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`预览 ${item.name}`} onPress={() => onAttachmentPress(item)} style={styles.attachmentBody}>
            {item.uri ? <Image source={{ uri: item.uri }} resizeMode="cover" style={styles.thumbnail} /> : <Paperclip size={23} color={c.muted} />}
            <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ fontSize: 12, color: c.text }}>{item.name}</Text><Text style={{ fontSize: 10, color: c.muted, marginTop: 3 }}>{item.detail || '图片'}</Text></View>
          </Pressable>
          {item.loading ? <ActivityIndicator size="small" color={c.muted} /> : item.error ? <Pressable accessibilityRole="button" accessibilityLabel={`重试上传 ${item.name}`} disabled={!onRetryAttachment || !attachmentsEnabled} onPress={() => onRetryAttachment?.(item.id)}><Text numberOfLines={2} style={{ fontSize: 10, color: c.danger, maxWidth: 70 }}>{item.error} · 重试</Text></Pressable> : item.uploaded ? <Check size={13} color={c.success} /> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={`移除 ${item.name}`} disabled={busy} onPress={() => onRemoveAttachment(item.id)} hitSlop={5} style={styles.remove}><X size={15} color={c.muted} /></Pressable>
        </View>)}
      </ScrollView>}
      <Animated.View style={{ marginLeft: expansion.interpolate({ inputRange: [0, 1], outputRange: [88, 7] }), marginRight: expansion.interpolate({ inputRange: [0, 1], outputRange: [compactRight, 7] }) }}>
        <ComposerInput imagesEnabled filesEnabled imageSlots={Math.max(0, 20 - attachments.filter(item => item.uri).length)} {...media} testID="chrome-input" accessibilityLabel={inputLabel} value={text} onChangeText={onChangeText} maxLength={32000} multiline editable={!busy}
          onFocus={() => { setFocused(true); onFocus?.(); }} onBlur={() => setFocused(false)}
          placeholder={phase === 'running' ? '跟进' : '发消息…'} placeholderTextColor={c.muted} textAlignVertical="top"
          style={[styles.input, { color: c.text }]}
          onSubmitEditing={Platform.OS === 'windows' ? submit : undefined}
          onKeyPress={event => {
            const key = event.nativeEvent as { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
            if (Platform.OS === 'web' && key.key === 'Enter' && !key.shiftKey && !key.isComposing && key.keyCode !== 229) { event.preventDefault(); submit(); }
          }} />
      </Animated.View>
      <View style={styles.toolbar} pointerEvents="box-none">
        <View ref={attachmentAnchor} collapsable={false}><ChromeButton Icon={Plus} label={attachmentsLabel} onPress={onAttachments} disabled={!attachmentsEnabled || busy} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`会话权限：${chromePermissionLabels[permission]}`} accessibilityState={{ disabled: !permissionsEnabled }} disabled={!permissionsEnabled} onPress={onPermissions} style={[styles.symbolButton, !permissionsEnabled && { opacity: .35 }]}><PermissionSymbol mode={permission} size={23} /></Pressable>
        {expanded && plan && <Pressable accessibilityRole="button" accessibilityLabel="退出方案模式" disabled={!planEnabled || busy} onPress={onClearPlan} style={[styles.planChip, { backgroundColor: c.soft, opacity: planEnabled ? 1 : .4 }]}><ListChecks size={15} color={c.accent} /><Text style={{ color: c.accent, fontSize: 12 }}>方案</Text><X size={12} color={c.muted} /></Pressable>}
        <View style={{ flex: 1, minWidth: 0 }} pointerEvents="none" />
        <View ref={modelAnchor} collapsable={false} style={styles.modelAnchor} onLayout={event => setModelWidth(event.nativeEvent.layout.width)}>
          <Pressable testID="chrome-model-entry" accessibilityRole="button" accessibilityLabel={`模型与推理强度：${modelLabel}，${effortLabel}`} accessibilityState={{ disabled: !modelEnabled }} disabled={!modelEnabled} onPress={onModel} style={[styles.modelButton, !modelEnabled && { opacity: .35 }]}>
            <Text numberOfLines={2} style={[styles.modelName, { color: c.text }, plan && { fontSize: composerWidth > 0 && composerWidth < 320 ? 12 : 14 }]}>{modelLabel}{!!effortLabel && <Text style={[styles.modelEffort, { color: c.muted }]}> {effortLabel}</Text>}</Text>
          </Pressable>
        </View>
        <Pressable testID="chrome-submit" accessibilityRole="button" accessibilityLabel={actionLabels[action]} accessibilityState={{ disabled }} disabled={disabled} onPress={submit}
          style={({ pressed }) => [styles.submit, { backgroundColor: disabled ? c.ring : c.solid, opacity: pressed ? 0.78 : 1 }]}>
          {busy ? <ActivityIndicator size="small" color={c.onSolid} /> : <ActionIcon size={action === 'stop' ? 14 : 19} color={c.onSolid} fill={action === 'stop' || action === 'continue' ? c.onSolid : 'none'} strokeWidth={2.1} />}
        </Pressable>
      </View>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 4, minHeight: 76, flexDirection: 'row', alignItems: 'center' },
  headerText: { flex: 1, minWidth: 0, paddingLeft: 3, paddingRight: 4, gap: 3 }, titleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  subtitle: { fontSize: 11, lineHeight: 15 }, usage: { fontSize: 10, lineHeight: 14 },
  composerDock: { paddingHorizontal: 12, paddingBottom: 9, paddingTop: 5 },
  composer: { borderRadius: 27, paddingTop: 4, minHeight: 54 }, input: { borderWidth: 0, fontSize: 16, lineHeight: 23, paddingHorizontal: 4, paddingVertical: 9 },
  toolbar: { position: 'absolute', left: 0, right: 7, bottom: 4, height: 44, flexDirection: 'row', alignItems: 'center' },
  submit: { width: 34, height: 34, marginLeft: 4, marginRight: 3, borderRadius: 18, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  symbolButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  modelAnchor: { flexShrink: 1, minWidth: 0 },
  modelButton: { minHeight: 44, minWidth: 0, paddingHorizontal: 7, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5 },
  modelName: { fontSize: 15, lineHeight: 19, fontWeight: '500', flexShrink: 1 }, modelEffort: { fontWeight: '400' },
  planChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 5, height: 27, borderRadius: 14 },
  attachments: { flexGrow: 0, maxHeight: 72, marginHorizontal: 8, marginBottom: 3 },
  attachment: { width: 185, borderRadius: 15, flexDirection: 'row', alignItems: 'center', padding: 6 },
  attachmentBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 42 }, thumbnail: { width: 44, height: 44, borderRadius: 9 }, remove: { width: 25, height: 30, alignItems: 'center', justifyContent: 'center' },
});
