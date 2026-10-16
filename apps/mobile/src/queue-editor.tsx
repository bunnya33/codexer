import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { X } from 'lucide-react-native';
import type { QueuedMessageDetails } from '../../../packages/protocol/src/index';
import { relay } from './relay';
import { c, s } from './styles';

export function queueError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return ({ 'queue-item-unavailable': '这条消息已发送或已移除，请检查会话记录。', 'queue-item-changed': '这条消息已在其他地方修改，请重新打开后编辑。', 'empty-input': '请输入消息或保留图片附件。' } as Record<string, string>)[code] ?? code;
}

export function QueueEditor({ deviceId, threadId, queueId, onClose }: { deviceId: string; threadId: string; queueId: string; onClose: () => void }) {
  const [original, setOriginal] = useState<QueuedMessageDetails | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void relay.queuedMessage(deviceId, threadId, queueId).then(message => { if (active) { setOriginal(message); setText(message.text); } })
      .catch(failure => { if (active) setError(queueError(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [deviceId, threadId, queueId]);
  const save = async () => {
    if (!original || saving || !text.trim() && !original.images.length) return;
    setSaving(true); setError('');
    try {
      const result = await relay.sendCommand(deviceId, { type: 'turn.queue.update', threadId, queueId, text, expectedText: original.text });
      if (result.status !== 'succeeded') throw new Error(result.code);
      if (mounted.current) onClose();
    } catch (failure) { if (mounted.current) setError(queueError(failure)); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭编辑消息" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.card}>
        <View style={s.modalHeader}><Text style={s.modalTitle}>编辑消息</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭编辑" onPress={onClose} style={s.iconButton}><X size={19} color={c.muted} /></Pressable></View>
        {loading ? <ActivityIndicator style={styles.loading} color={c.accent} /> : original && <>
          <TextInput accessibilityLabel="编辑待发送消息" value={text} onChangeText={setText} editable={!saving} multiline maxLength={32000} autoFocus style={styles.input} />
          {!!original.images.length && <Text style={s.sub}>保留 {original.images.length} 张图片附件</Text>}
          <Pressable accessibilityRole="button" accessibilityLabel="保存消息" disabled={saving || !text.trim() && !original.images.length} onPress={() => void save()} style={[s.primary, styles.save, (saving || !text.trim() && !original.images.length) && s.disabled]}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>保存消息</Text>}
          </Pressable>
        </>}
        {!!error && <Text accessibilityRole="alert" selectable style={s.error}>{error}</Text>}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#0003', justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 560, maxHeight: '85%', backgroundColor: c.surface, borderRadius: 20, paddingHorizontal: 18, paddingBottom: 18, gap: 8 },
  input: { minHeight: 140, maxHeight: 300, color: c.text, fontSize: 15, lineHeight: 23, padding: 12, borderWidth: 1, borderColor: c.line, borderRadius: 12, textAlignVertical: 'top' },
  save: { marginTop: 6 }, loading: { paddingVertical: 32 },
});
