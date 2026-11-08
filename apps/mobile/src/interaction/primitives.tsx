import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { useTheme } from '../styles';

export function ChromeButton({ Icon, label, onPress, selected, disabled, size = 21, testID }: {
  Icon: LucideIcon; label: string; onPress: () => void; selected?: boolean; disabled?: boolean; size?: number; testID?: string;
}) {
  const { c } = useTheme();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.icon, selected && { backgroundColor: c.soft }, pressed && { backgroundColor: c.soft }, disabled && { opacity: 0.35 }]}>
    <Icon size={size} color={selected ? c.accent : c.text} strokeWidth={1.7} />
  </Pressable>;
}

export function MenuRow({ Icon, title, detail, selected, onPress, disabled, danger, accessory, accessibilityLabel }: {
  Icon?: LucideIcon; title: string; detail?: string; selected?: boolean; onPress: () => void; disabled?: boolean; danger?: boolean; accessory?: ReactNode;
  accessibilityLabel?: string;
}) {
  const { c } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.soft }, disabled && { opacity: 0.4 }]}>
    {!!Icon && <Icon size={21} color={danger ? c.taskRunning : c.text} strokeWidth={1.6} />}
    <View style={{ flex: 1, minWidth: 0 }}><Text style={[styles.title, { color: danger ? c.taskRunning : c.text }]}>{title}</Text>
      {!!detail && <Text style={[styles.detail, { color: c.muted }]}>{detail}</Text>}</View>
    {accessory}{selected && <Check size={18} strokeWidth={2} color={c.text} />}
  </Pressable>;
}

const styles = StyleSheet.create({
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  row: { minHeight: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 13, borderRadius: 14 },
  title: { fontSize: 15, lineHeight: 21, includeFontPadding: false },
  detail: { fontSize: 12, lineHeight: 18, marginTop: 3, includeFontPadding: false },
});
