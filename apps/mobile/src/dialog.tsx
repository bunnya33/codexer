import { themedStyles } from './theme';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { useTheme } from './styles';

export function Dialog({ title, open = true, onClose, children, busy = false }: {
  title: string; open?: boolean; onClose: () => void; children: ReactNode; busy?: boolean;
}) {
  const { c, s } = useTheme();
  const styles = useLocalStyles();
  const close = () => { if (!busy) onClose(); };
  return <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
    <SafeAreaView style={styles.overlay}>
      <KeyboardAvoidingView style={styles.frame} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable accessibilityRole="button" accessibilityLabel={`关闭${title}弹窗`} style={StyleSheet.absoluteFill} onPress={close} />
        <View accessibilityViewIsModal accessibilityLabel={title} testID="dialog-card" style={styles.card}>
          <View style={s.modalHeader}><Text numberOfLines={1} style={[s.modalTitle, styles.title]}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel={`关闭${title}`} disabled={busy} onPress={close} style={s.iconButton}><X size={20} color={c.muted} /></Pressable></View>
          <ScrollView style={styles.content} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const useLocalStyles = themedStyles(c => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#0004' }, frame: { flex: 1, padding: 20, justifyContent: 'center', alignItems: 'center' },
  card: { width: '100%', maxWidth: 520, maxHeight: '90%', backgroundColor: c.surface, borderRadius: 24, paddingHorizontal: 20,
    shadowColor: c.shadow, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.12, shadowRadius: 28, elevation: 12 },
  title: { flex: 1 }, content: { flexGrow: 0, flexShrink: 1 }, body: { paddingBottom: 20, gap: 12 },
}));
