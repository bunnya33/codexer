import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, Copy } from 'lucide-react-native';
import { copyText } from './runtime';
import { useTheme } from './styles';
import { themedStyles } from './theme';

export function ConversationId({ threadId }: { threadId: string }) {
  const { c } = useTheme();
  const styles = useLocalStyles();
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const revision = useRef(0);
  useEffect(() => {
    setStatus('idle');
    return () => { revision.current++; };
  }, [threadId]);

  async function copy() {
    const current = ++revision.current;
    setStatus('copying');
    try {
      await copyText(threadId);
      if (revision.current === current) setStatus('copied');
    } catch {
      if (revision.current === current) setStatus('failed');
    }
  }

  return <View style={styles.field}>
    <View style={styles.row}>
      <View style={styles.content}>
        <Text style={styles.label}>会话 ID</Text>
        <Text selectable testID="conversation-id" style={styles.value}>{threadId}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="复制会话 ID" disabled={status === 'copying'} onPress={() => void copy()} style={styles.copy}>
        {status === 'copied' ? <Check size={15} color={c.accent} /> : <Copy size={15} color={c.accent} />}
        <Text style={styles.copyText}>{status === 'copied' ? '已复制' : '复制'}</Text>
      </Pressable>
    </View>
    {status === 'failed' && <Text accessibilityRole="alert" style={styles.error}>复制失败，请长按或选择会话 ID 手动复制</Text>}
  </View>;
}

const useLocalStyles = themedStyles(c => StyleSheet.create({
  field: { padding: 12, gap: 8, borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.soft },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  content: { flex: 1, minWidth: 0, gap: 4 },
  label: { fontSize: 12, color: c.muted },
  value: { fontSize: 13, lineHeight: 20, color: c.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : Platform.OS === 'windows' ? 'Consolas' : 'monospace' },
  copy: { minHeight: 40, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, flexShrink: 0 },
  copyText: { fontSize: 13, color: c.accent },
  error: { fontSize: 12, lineHeight: 18, color: c.danger },
}));
