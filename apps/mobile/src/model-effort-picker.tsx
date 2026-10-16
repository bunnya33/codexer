import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronDown, ChevronRight } from 'lucide-react-native';
import type { ModelOption } from '../../../packages/protocol/src/index';
import { effortLabel, modelLabel } from '../../../packages/client-shared/src/models';
import { ComposerPopover } from './composer-popover';
import { EffortSlider } from './effort-slider';
import { c, s } from './styles';

export function ModelEffortPicker({ model, effort, options, enabled, busy, onModelChange, onEffortChange }: {
  model?: string | null; effort?: string | null; options: ModelOption[]; enabled: boolean; busy: boolean;
  onModelChange: (model: string) => Promise<void>; onEffortChange: (effort: string) => Promise<boolean>;
}) {
  const anchor = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<'effort' | 'model'>('effort');
  const [selectedEffort, setSelectedEffort] = useState(effort);
  const saving = useRef(false);
  const option = options.find(item => item.model === model);
  const efforts = option?.supportedReasoningEfforts ?? [];
  const index = Math.max(0, efforts.indexOf(selectedEffort ?? option?.defaultReasoningEffort ?? ''));
  useEffect(() => setSelectedEffort(effort), [effort, model, open]);
  useEffect(() => { if (!enabled) setOpen(false); }, [enabled]);
  const close = () => setOpen(false);
  const commit = async (next: number) => {
    const value = efforts[next];
    if (!value || value === effort || !enabled || busy || saving.current) return;
    saving.current = true;
    try { if (!await onEffortChange(value)) setSelectedEffort(effort); }
    finally { saving.current = false; }
  };
  return <>
    <View ref={anchor} collapsable={false} style={{ flexShrink: 1, minWidth: 0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`模型与推理强度：${modelLabel(model, options)}，${effortLabel(effort)}`} aria-expanded={open}
        disabled={!enabled || busy} onPress={() => { setPage('effort'); setOpen(!open); }} style={({ pressed }) => [styles.button, pressed && s.pressed, (!enabled || busy) && s.disabled]}>
        <Text numberOfLines={1} style={styles.model}>{modelLabel(model, options)}</Text><Text style={styles.effort}>{effortLabel(effort)}</Text><ChevronDown size={13} color={c.muted} />
      </Pressable>
    </View>
    <ComposerPopover anchor={anchor} open={open} onClose={close} width={page === 'effort' ? 304 : 320}>
      {page === 'effort' ? <View style={styles.strengthPanel}>
        <Text accessibilityLiveRegion="polite" style={styles.strength}>{effortLabel(selectedEffort)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="选择模型" onPress={() => setPage('model')} style={styles.modelLink}>
          <Text style={styles.modelLinkText}>{modelLabel(model, options)}</Text><ChevronRight size={14} color={c.muted} />
        </Pressable>
        {efforts.length ? <EffortSlider labels={efforts.map(effortLabel)} value={index} disabled={busy} onChange={next => setSelectedEffort(efforts[next])} onCommit={next => void commit(next)} />
          : <Text style={styles.unavailable}>此模型不支持调整推理强度</Text>}
      </View> : <>
        <Text style={styles.heading}>选择模型</Text>
        <ScrollView style={styles.models}>{[...new Set([model, ...options.map(item => item.model)].filter((name): name is string => !!name))].map(name =>
          <Pressable key={name} accessibilityRole="menuitem" accessibilityLabel={`选择模型 ${modelLabel(name, options)}`} accessibilityState={{ selected: model === name }} disabled={busy}
            onPress={() => { close(); void onModelChange(name); }} style={({ pressed }) => [styles.modelOption, pressed && s.pressed]}>
            <Text style={styles.optionText}>{modelLabel(name, options)}</Text>{model === name && <Check size={18} color={c.text} />}
          </Pressable>)}</ScrollView>
      </>}
    </ComposerPopover>
  </>;
}

const styles = StyleSheet.create({
  button: { height: 32, maxWidth: 250, paddingHorizontal: 8, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 5 },
  model: { flexShrink: 1, color: c.text, fontSize: 13 }, effort: { color: c.muted, fontSize: 13 },
  strengthPanel: { padding: 6, paddingBottom: 8 }, strength: { textAlign: 'center', color: '#2d88d4', fontSize: 21, fontWeight: '600', marginTop: 2 },
  modelLink: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 30, marginBottom: 4 }, modelLinkText: { color: c.muted, fontSize: 14 },
  unavailable: { color: c.muted, fontSize: 12, textAlign: 'center', paddingVertical: 14 },
  heading: { color: c.muted, fontSize: 13, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 8 },
  models: { flexGrow: 0, maxHeight: 360 }, modelOption: { minHeight: 42, paddingHorizontal: 10, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  optionText: { flex: 1, color: c.text, fontSize: 15 },
});
