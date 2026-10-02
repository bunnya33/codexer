import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Check, ChevronDown, Monitor, Search, X } from 'lucide-react-native';
import type { RelayView } from './relay';
import { c, s } from './styles';

export function DevicePicker({ devices, deviceId, selectDevice }: { devices: RelayView['devices']; deviceId: string; selectDevice: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { width, height } = useWindowDimensions();
  const selected = devices.find(device => device.id === deviceId);
  const filtered = devices.filter(device => device.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const close = () => setOpen(false);
  return <View style={s.devicePicker}>
    <Pressable accessibilityRole="button" accessibilityLabel={selected ? `切换 PC Agent，当前：${selected.name}，${selected.online ? '在线' : '离线'}` : '暂无 PC Agent'} aria-expanded={open} disabled={!devices.length} onPress={() => { setSearch(''); setOpen(true); }} style={({ pressed }) => [s.deviceTrigger, pressed && s.pressed]}>
      <Monitor size={18} color={c.muted} />
      <View style={s.deviceLabel}><Text style={s.deviceText} numberOfLines={2}>{selected?.name ?? '等待 PC Agent 登录'}</Text>{selected && <View style={s.devicePresence}><View style={[s.dot, selected.online && s.dotOnline]} /><Text style={s.deviceStatus}>{selected.online ? '在线' : '离线'}</Text></View>}</View>
      {!!devices.length && <ChevronDown size={16} color={c.muted} />}
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <View style={s.deviceOverlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭设备选择" style={StyleSheet.absoluteFill} onPress={close} />
        <View accessibilityViewIsModal style={[s.deviceDialog, { width: Math.min(440, width - 32), maxHeight: height - 64 }]}>
          <View style={s.deviceDialogHeader}><View style={s.deviceLabel}><Text style={s.modalTitle}>切换 PC Agent</Text><Text style={s.sub}>{devices.length} 台设备 · {devices.filter(device => device.online).length} 台在线</Text></View><Pressable accessibilityRole="button" accessibilityLabel="关闭设备列表" onPress={close} style={s.iconButton}><X size={20} color={c.text} /></Pressable></View>
          <View style={s.deviceSearch}><Search size={17} color={c.muted} /><TextInput accessibilityLabel="搜索设备" style={s.searchInput} value={search} onChangeText={setSearch} placeholder="搜索设备" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} /></View>
          <FlatList testID="device-options" data={filtered} keyExtractor={device => device.id} style={s.deviceOptions} contentContainerStyle={s.deviceOptionsContent} keyboardShouldPersistTaps="handled" renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`选择设备 ${item.name}，${item.online ? '在线' : '离线'}`} accessibilityState={{ selected: item.id === deviceId }} onPress={() => { close(); if (item.id !== deviceId) selectDevice(item.id); }} style={({ pressed }) => [s.deviceOption, item.id === deviceId && s.deviceSelected, pressed && s.pressed]}>
            <Monitor size={18} color={item.id === deviceId ? c.accent : c.muted} />
            <View style={s.deviceLabel}><Text style={[s.deviceText, item.id === deviceId && s.deviceTextSelected]}>{item.name}</Text><View style={s.devicePresence}><View style={[s.dot, item.online && s.dotOnline]} /><Text style={s.deviceStatus}>{item.online ? '在线' : '离线'}</Text></View></View>
            {item.id === deviceId && <Check size={18} color={c.accent} />}
          </Pressable>} ListEmptyComponent={<Text style={s.empty}>{devices.length ? '没有匹配的设备' : '暂无设备'}</Text>} />
        </View>
      </View>
    </Modal>
  </View>;
}
