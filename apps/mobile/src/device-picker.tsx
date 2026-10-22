import { useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Check, ChevronDown, Monitor, Search, Settings2, Trash2, X } from 'lucide-react-native';
import { relay, type RelayView } from './relay';
import { useTheme } from './styles';
import { confirmAction } from './runtime';

export function DevicePicker({ devices, deviceId, selectDevice }: { devices: RelayView['devices']; deviceId: string; selectDevice: (id: string) => void }) {
  const { c, s } = useTheme();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [managing, setManaging] = useState(false), [busyId, setBusyId] = useState(''), [error, setError] = useState('');
  const pending = useRef(false);
  const { width, height } = useWindowDimensions();
  const selected = devices.find(device => device.id === deviceId);
  const filtered = devices.filter(device => device.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const close = () => setOpen(false);
  const remove = async (device: RelayView['devices'][number]) => {
    if (pending.current || device.online) return;
    pending.current = true; setBusyId(device.id); setError('');
    try {
      if (!await confirmAction('删除离线设备？', `将删除“${device.name}”（${device.id.slice(0, 8)}）在服务器上的会话缓存、图片、附件及分享链接。电脑上的文件和 Codex 会话不受影响；设备以后重新连接会自动同步回来。`)) return;
      await relay.removeDevice(device.id);
    } catch (value) { setError(value instanceof Error ? value.message : '删除失败，请重试'); }
    finally { pending.current = false; setBusyId(''); }
  };
  return <View style={s.devicePicker}>
    <Pressable accessibilityRole="button" accessibilityLabel={selected ? `切换 PC Agent，当前：${selected.name}，${selected.online ? '在线' : '离线'}` : '暂无 PC Agent'} aria-expanded={open} disabled={!devices.length} onPress={() => { setSearch(''); setError(''); setManaging(false); setOpen(true); }} style={({ pressed }) => [s.deviceTrigger, pressed && s.pressed]}>
      <Monitor size={18} color={c.muted} />
      <View style={s.deviceLabel}><Text style={s.deviceText} numberOfLines={2}>{selected?.name ?? '等待 PC Agent 登录'}</Text>{selected && <View style={s.devicePresence}><View style={[s.dot, selected.online && s.dotOnline]} /><Text style={s.deviceStatus}>{selected.online ? '在线' : '离线'}</Text></View>}</View>
      {!!devices.length && <ChevronDown size={16} color={c.muted} />}
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <View style={s.deviceOverlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭设备选择" style={StyleSheet.absoluteFill} onPress={close} />
        <View accessibilityViewIsModal style={[s.deviceDialog, { width: Math.min(440, width - 32), maxHeight: height - 64 }]}>
          <View style={s.deviceDialogHeader}><View style={s.deviceLabel}><Text style={s.modalTitle}>{managing ? '管理 PC Agent' : '切换 PC Agent'}</Text><Text style={s.sub}>{devices.length} 台设备 · {devices.filter(device => device.online).length} 台在线</Text></View><Pressable accessibilityRole="button" accessibilityLabel={managing ? '完成设备管理' : '管理设备'} disabled={!!busyId} onPress={() => { setManaging(!managing); setError(''); }} style={s.iconButton}>{managing ? <Check size={20} color={c.accent} /> : <Settings2 size={20} color={c.text} />}</Pressable><Pressable accessibilityRole="button" accessibilityLabel="关闭设备列表" onPress={close} style={s.iconButton}><X size={20} color={c.text} /></Pressable></View>
          {managing && <Text style={[s.sub, { marginHorizontal: 18, marginBottom: 12 }]}>仅可删除离线设备，重新连接后会自动同步回来。该设备的旧分享链接将失效。</Text>}
          {!!error && <Text accessibilityRole="alert" style={[s.error, { marginHorizontal: 18, marginBottom: 12 }]}>{error}</Text>}
          <View style={s.deviceSearch}><Search size={17} color={c.muted} /><TextInput accessibilityLabel="搜索设备" style={[s.searchInput, { outlineStyle: 'solid', outlineWidth: 0 }]} value={search} onChangeText={setSearch} placeholder="搜索设备" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} /></View>
          <FlatList testID="device-options" data={filtered} keyExtractor={device => device.id} style={s.deviceOptions} contentContainerStyle={s.deviceOptionsContent} keyboardShouldPersistTaps="handled" renderItem={({ item }) => <View style={[s.deviceOption, item.id === deviceId && s.deviceSelected]}><Pressable accessibilityRole="button" accessibilityLabel={`选择设备 ${item.name}，${item.online ? '在线' : '离线'}`} disabled={managing || !!busyId} accessibilityState={{ selected: item.id === deviceId }} onPress={() => { close(); if (item.id !== deviceId) selectDevice(item.id); }} style={({ pressed }) => [{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }, pressed && s.pressed]}>
            <Monitor size={18} color={item.id === deviceId ? c.accent : c.muted} />
            <View style={s.deviceLabel}><Text style={[s.deviceText, item.id === deviceId && s.deviceTextSelected]}>{item.name}</Text><View style={s.devicePresence}><View style={[s.dot, item.online && s.dotOnline]} /><Text style={s.deviceStatus}>{item.online ? '在线' : '离线'}</Text></View>{managing && <Text style={s.deviceStatus}>{({win32: 'Windows', darwin: 'macOS', linux: 'Linux'} as Record<string, string>)[item.platform] ?? item.platform} · {item.id.slice(0, 8)}{item.last_seen_at && Number.isFinite(Number(item.last_seen_at)) ? `\n最后在线：${new Date(Number(item.last_seen_at)).toLocaleString()}` : ''}</Text>}</View>
            {item.id === deviceId && <Check size={18} color={c.accent} />}
          </Pressable>{managing && (item.online ? <Text style={s.deviceStatus}>在线不可删除</Text> : <Pressable accessibilityRole="button" accessibilityLabel={`删除离线设备 ${item.name}（${item.id.slice(0, 8)}）`} disabled={!!busyId} onPress={() => void remove(item)} style={[s.iconButton, !!busyId && s.disabled]}>{busyId === item.id ? <ActivityIndicator size="small" color={c.danger} /> : <Trash2 size={19} color={c.danger} />}</Pressable>)}</View>} ListEmptyComponent={<Text style={s.empty}>{devices.length ? '没有匹配的设备' : '暂无设备'}</Text>} />
        </View>
      </View>
    </Modal>
  </View>;
}
