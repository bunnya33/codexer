import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../styles';

// Title menus use compact rows with trailing symbols, unlike attachment menus.
export function ContextMenuRow({ title, Icon, onPress, disabled, danger, accessibilityLabel }: {
  title: string; Icon: LucideIcon; onPress: () => void; disabled?: boolean; danger?: boolean; accessibilityLabel?: string;
}) {
  const { c } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} disabled={disabled}
    accessibilityState={{ disabled }} onPress={onPress}
    style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.soft : c.glass }, disabled && { opacity: .4 }]}>
    <Text style={[styles.label, { color: danger ? c.danger : c.text }]}>{title}</Text>
    <Icon size={18} strokeWidth={1.65} color={danger ? c.danger : c.text} />
  </Pressable>;
}

export function ContextMenuGroup({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return <View style={{ gap: StyleSheet.hairlineWidth, backgroundColor: c.line }}>{children}</View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 44, paddingHorizontal: 15, paddingVertical: 10, gap: 16, flexDirection: 'row', alignItems: 'center', backgroundColor: 'transparent' },
  label: { flex: 1, fontSize: 15, lineHeight: 21, includeFontPadding: false },
});
