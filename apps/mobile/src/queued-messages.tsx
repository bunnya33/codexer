import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CornerDownRight, ListEnd, Pencil, Trash2 } from 'lucide-react-native';
import type { RemoteThread } from '../../../packages/protocol/src/index';
import { c, s } from './styles';

type QueueItem = NonNullable<RemoteThread['queuedMessages']>[number];
type Actions = {
  enabled: boolean; canSteer: boolean;
  onSteer: (id: string) => void; onRemove: (id: string) => void; onEdit: (id: string) => void;
};

function QueueRow({ item, ...actions }: Actions & { item: QueueItem }) {
  const editable = actions.enabled && item.status !== 'sending';
  return <View style={styles.row}>
    <ListEnd size={16} color={c.muted} />
    <Text numberOfLines={1} style={styles.text}>{item.text || [item.imageCount ? `${item.imageCount} 张图片` : '', item.fileCount ? `${item.fileCount} 个文件` : ''].filter(Boolean).join(' · ')}</Text>
    {item.status === 'sending' ? <><ActivityIndicator size="small" color={c.muted} /><Text style={styles.status}>发送中</Text></>
      : item.status === 'failed' && <Text style={styles.status}>未确认</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel="引导这条消息" disabled={!actions.enabled || !actions.canSteer || item.status !== 'queued'}
      onPress={() => actions.onSteer(item.id)} style={({ pressed }) => [styles.steer, pressed && s.pressed, (!actions.enabled || !actions.canSteer || item.status !== 'queued') && s.disabled]}>
      <CornerDownRight size={16} color={c.muted} /><Text style={styles.actionText}>引导</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="移除待发送消息" disabled={!editable} onPress={() => actions.onRemove(item.id)} style={[styles.icon, !editable && s.disabled]}>
      <Trash2 size={16} color={c.muted} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="编辑待发送消息" disabled={!editable} onPress={() => actions.onEdit(item.id)} style={({ pressed }) => [styles.steer, pressed && s.pressed, !editable && s.disabled]}>
      <Pencil size={15} color={c.muted} /><Text style={styles.actionText}>编辑</Text>
    </Pressable>
  </View>;
}

export function QueuedMessages({ items, ...actions }: Actions & { items: QueueItem[] }) {
  if (!items.length) return null;
  return <ScrollView style={styles.queue} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" nestedScrollEnabled>{items.map(item => <QueueRow key={item.id} item={item} {...actions} />)}</ScrollView>;
}

const styles = StyleSheet.create({
  queue: { maxHeight: 180, flexGrow: 0, borderBottomWidth: 1, borderColor: '#eceeee' }, content: { paddingHorizontal: 10, paddingTop: 3 },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }, text: { flex: 1, minWidth: 0, color: c.text, fontSize: 13 }, status: { fontSize: 11, color: c.muted },
  steer: { minHeight: 32, paddingHorizontal: 5, flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8 }, actionText: { color: c.muted, fontSize: 13 },
  icon: { width: 30, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
