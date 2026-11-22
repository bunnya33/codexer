import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react-native';
import type { ImageDirection, ImageGallery, ImagePreview } from '../../../packages/client-shared/src/images';
import { saveConversationImage } from './image-download';
import { imageSaveError } from './image-download-source';
import { useTheme } from './styles';

export function ImageViewerHeader({ image, onClose }: { image?: ImagePreview; onClose: () => void }) {
  const { s } = useTheme();
  const pending = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => () => { pending.current?.abort(); }, []);

  const save = async () => {
    if (!image?.source.headers || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    setFeedback('');
    try {
      const message = await saveConversationImage(image, controller.signal);
      if (!controller.signal.aborted && message) setFeedback(message);
    } catch (error) {
      if (!controller.signal.aborted) setFeedback(imageSaveError(error));
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  return <View style={s.viewerHeader}>
    <View style={{ flex: 1, paddingRight: 8 }}>
      <Text style={s.viewerTitle} numberOfLines={1}>{image?.name}</Text>
      {!!feedback && <Text accessibilityLiveRegion="polite" style={s.viewerSaveFeedback}>{feedback}</Text>}
    </View>
    {image?.source.headers && <Pressable accessibilityRole="button" accessibilityLabel="保存图片"
      accessibilityState={{ busy: saving, disabled: saving }} disabled={saving} onPress={() => void save()} style={s.viewerClose}>
      {saving ? <ActivityIndicator color="#fff" size="small" /> : <Download size={22} color="#fff" />}
    </Pressable>}
    <Pressable accessibilityRole="button" accessibilityLabel="关闭图片" onPress={onClose} style={s.viewerClose}><X size={22} color="#fff" /></Pressable>
  </View>;
}

export function ImageViewerNavigation({ gallery, onNavigate }: { gallery: ImageGallery; onNavigate: (direction: ImageDirection) => void }) {
  const { s } = useTheme();
  if (gallery.images.length < 2) return null;
  return <View style={s.viewerNavigation}>
    <Pressable accessibilityRole="button" accessibilityLabel="上一张图片" disabled={gallery.index === 0}
      onPress={() => onNavigate(-1)} style={[s.viewerClose, gallery.index === 0 && s.disabled]}><ChevronLeft size={24} color="#fff" /></Pressable>
    <Text accessibilityLiveRegion="polite" style={s.viewerPosition}>{gallery.index + 1} / {gallery.images.length}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="下一张图片" disabled={gallery.index === gallery.images.length - 1}
      onPress={() => onNavigate(1)} style={[s.viewerClose, gallery.index === gallery.images.length - 1 && s.disabled]}><ChevronRight size={24} color="#fff" /></Pressable>
  </View>;
}
