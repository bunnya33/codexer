import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronRight, ChevronsUpDown } from 'lucide-react-native';
import type { ModelOption } from '../../../../packages/protocol/src/index';
import { effortLabel, modelLabel } from '../../../../packages/client-shared/src/models';
import { useTheme } from '../styles';
import { EffortRail } from './effort-rail';

export const referenceEffortLabel = (value: string) => value === 'max' ? 'Max' : value === 'ultra' ? 'Ultra' : effortLabel(value);

export function QuickModelPanel({ options, model, effort, onEffort, onCommit = onEffort, onAdvanced, disabled = false, effortDisabled = false }: {
  options: ModelOption[]; model: string; effort: string; onEffort: (effort: string) => void; onCommit?: (effort: string) => void; onAdvanced: () => void; disabled?: boolean; effortDisabled?: boolean;
}) {
  const { c, theme } = useTheme();
  const values = options.find(option => option.model === model)?.supportedReasoningEfforts ?? [];
  const change = (index: number) => { if (values[index]) onEffort(values[index]!); };
  return <View testID="quick-model-panel" style={{ height: 112 }}>
    <Pressable testID="quick-model-title" accessibilityRole="button" accessibilityLabel="打开模型高级设置" disabled={disabled} onPress={onAdvanced} style={styles.quickTitle}>
      <Text style={{ color: c.text, fontSize: 20, fontWeight: '500' }}>{modelLabel(model, options)} <Text style={{ color: c.muted, fontWeight: '400' }}>{referenceEffortLabel(effort)}</Text></Text><ChevronRight size={18} strokeWidth={2.3} color={c.muted} />
    </Pressable>
    <View testID="quick-model-capsule" style={{ height: 68, borderRadius: 34, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: theme.dark ? '#303033' : '#fff' }}>
      {values.length ? <EffortRail key={model} labels={values.map(referenceEffortLabel)} value={Math.max(0, values.indexOf(effort))} disabled={disabled || effortDisabled} onChange={change} onCommit={index => { if (values[index]) onCommit(values[index]!); }} />
        : <Text style={{ color: c.muted, fontSize: 12, padding: 10 }}>此模型没有可调整的推理强度</Text>}
    </View>
  </View>;
}

export function AdvancedModelPanel({ options, model, effort, onModel, onEffort, disabled = false, modelDisabled = false, effortDisabled = false }: {
  options: ModelOption[]; model: string; effort: string; onModel: (model: string) => void; onEffort: (effort: string) => void; disabled?: boolean; modelDisabled?: boolean; effortDisabled?: boolean;
}) {
  const { c } = useTheme();
  const [menu, setMenu] = useState<'models' | 'efforts' | null>(null);
  useEffect(() => {
    if (!menu || Platform.OS !== 'web') return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setMenu(null); } };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [menu]);
  const values = options.find(option => option.model === model)?.supportedReasoningEfforts ?? [];
  const choices = menu === 'models' ? options.map(option => ({ value: option.model, title: modelLabel(option.model, options) })) : values.map(value => ({ value, title: referenceEffortLabel(value) }));
  return <View style={{ gap: 22, paddingTop: 5 }}>
    {!!menu && <Pressable accessibilityRole="button" accessibilityLabel="关闭设置选项" onPress={() => setMenu(null)} style={{ position: 'absolute', top: -2000, bottom: -2000, left: -2000, right: -2000, zIndex: 2 }} />}
    <View style={[styles.group, { backgroundColor: c.surface, zIndex: menu ? 3 : 0 }]}>
      {(['models', 'efforts'] as const).map((kind, index) => <View key={kind} style={{ position: 'relative' }}>
        {!!index && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginLeft: 13 }} />}
        <Pressable accessibilityRole="button" accessibilityLabel={kind === 'models' ? '选择模型' : '选择推理强度'} disabled={disabled || (kind === 'models' ? modelDisabled : effortDisabled) || !(kind === 'models' ? options.length : values.length)} accessibilityState={{ expanded: menu === kind }} onPress={() => setMenu(menu === kind ? null : kind)} style={styles.settingRow}>
          <Text style={{ color: c.text, fontSize: 14, flex: 1 }}>{kind === 'models' ? '模型' : '智能'}</Text><Text style={{ color: c.text, fontSize: 14 }}>{kind === 'models' ? modelLabel(model, options) : referenceEffortLabel(effort)}</Text><ChevronsUpDown size={12} color={c.muted} strokeWidth={1.5} />
        </Pressable>
        {menu === kind && <View testID="reference-setting-menu" style={[styles.dropdown, { backgroundColor: c.glass, borderColor: c.line, shadowColor: c.shadow }]}>
          <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">{choices.map((choice, itemIndex) => <View key={choice.value}>
            {kind === 'models' && itemIndex === 2 && <Text style={{ color: c.faint, backgroundColor: c.line, fontSize: 10, paddingHorizontal: 13, paddingVertical: 5 }}>其他模型</Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={choice.title} disabled={disabled} accessibilityState={{ selected: choice.value === (kind === 'models' ? model : effort) }} onPress={() => { kind === 'models' ? onModel(choice.value) : onEffort(choice.value); setMenu(null); }} style={[styles.option, { borderBottomColor: c.line, borderBottomWidth: itemIndex === choices.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
              <View style={{ width: 15 }}>{choice.value === (kind === 'models' ? model : effort) && <Check size={13} color={c.text} strokeWidth={2} />}</View><Text style={{ color: c.text, fontSize: 14 }}>{choice.title}</Text>
            </Pressable>
          </View>)}</ScrollView>
        </View>}
      </View>)}
    </View>
    <View style={[styles.group, { backgroundColor: c.surface }]}><View style={styles.settingRow}><Text style={{ color: c.text, flex: 1, fontSize: 14 }}>速度</Text><Text style={{ color: c.muted, fontSize: 14 }}>标准</Text><ChevronsUpDown size={12} color={c.muted} strokeWidth={1.5} /></View></View>
    <Text style={{ color: c.faint, fontSize: 11, lineHeight: 17, paddingHorizontal: 10 }}>“快速”将在连接器支持后提供。</Text>
  </View>;
}

const styles = StyleSheet.create({
  quickTitle: { height: 28, marginBottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  group: { borderRadius: 10 }, settingRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 13 },
  dropdown: { position: 'absolute', bottom: 38, right: 5, width: 190, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden', zIndex: 5, shadowOffset: { width: 0, height: 4 }, shadowOpacity: .16, shadowRadius: 23, elevation: 15 },
  option: { minHeight: 37, paddingHorizontal: 8, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 2 },
});
