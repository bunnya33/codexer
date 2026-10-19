import { themedStyles } from './theme';
import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, Image, Paperclip, Plus } from 'lucide-react-native';
import { ComposerPopover } from './composer-popover';
import { useTheme } from './styles';

export function AttachmentMenu({ enabled, imagesEnabled, filesEnabled, filesSupported, onImages, onCamera, onFiles }: {
  enabled: boolean; imagesEnabled: boolean; filesEnabled: boolean; filesSupported: boolean; onImages: () => void; onCamera: () => void; onFiles: () => void;
}) {
  const { c, s } = useTheme();
  const styles = useLocalStyles();
  const anchor = useRef<View>(null), [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const select = (action: () => void) => {
    setOpen(false);
    // iOS must dismiss the React Native modal before presenting a system picker.
    if (Platform.OS === 'ios') pending.current = action;
    else action();
  };
  return <>
    <View ref={anchor} collapsable={false}><Pressable accessibilityRole="button" accessibilityLabel="添加附件" accessibilityState={{ expanded: open }} disabled={!enabled} onPress={() => setOpen(value => !value)} style={({ pressed }) => [s.iconButton, pressed && s.pressed, !enabled && s.disabled]}><Plus size={23} color={c.text} strokeWidth={1.8} /></Pressable></View>
    <ComposerPopover anchor={anchor} open={open && enabled} onClose={() => setOpen(false)} onDismiss={() => { const action = pending.current; pending.current = null; action?.(); }} align="start" width={260}>
      {([...(Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? [{ label: '相机', accessible: '拍照添加图片', icon: Camera, action: onCamera, enabled: imagesEnabled }] : []),
        { label: '照片', accessible: '添加图片', icon: Image, action: onImages, enabled: imagesEnabled },
        { label: '文件', accessible: '添加文件', icon: Paperclip, action: onFiles, enabled: filesEnabled }]).map(item => <Pressable key={item.label} accessibilityRole="menuitem" accessibilityLabel={item.accessible} disabled={!item.enabled} onPress={() => select(item.action)} style={({ pressed }) => [styles.option, pressed && s.pressed, !item.enabled && s.disabled]}><View style={styles.icon}><item.icon size={21} color={c.text} strokeWidth={1.8} /></View><Text style={styles.label}>{item.label}</Text></Pressable>)}
      <Text style={styles.hint}>{filesSupported ? '最多 4 个文件，每个 20 MB' : '更新电脑连接器后可添加文件'}</Text>
    </ComposerPopover>
  </>;
}
const useLocalStyles = themedStyles(c => StyleSheet.create({
  option: { minHeight: 56, paddingHorizontal: 10, gap: 14, flexDirection: 'row', alignItems: 'center', borderRadius: 14 },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.code, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 16, color: c.text }, hint: { paddingHorizontal: 10, paddingVertical: 8, color: c.muted, fontSize: 12, lineHeight: 18 },
}));
