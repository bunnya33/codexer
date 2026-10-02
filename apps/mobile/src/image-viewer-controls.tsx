import { Pressable, Text, View } from 'react-native';
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import type { ImageDirection, ImageGallery } from '../../../packages/client-shared/src/images';
import { s } from './styles';

export function ImageViewerHeader({ name, onClose }: { name?: string; onClose: () => void }) {
  return <View style={s.viewerHeader}>
    <Text style={s.viewerTitle} numberOfLines={1}>{name}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="关闭图片" onPress={onClose} style={s.viewerClose}><X size={22} color="#fff" /></Pressable>
  </View>;
}

export function ImageViewerNavigation({ gallery, onNavigate }: { gallery: ImageGallery; onNavigate: (direction: ImageDirection) => void }) {
  if (gallery.images.length < 2) return null;
  return <View style={s.viewerNavigation}>
    <Pressable accessibilityRole="button" accessibilityLabel="上一张图片" disabled={gallery.index === 0}
      onPress={() => onNavigate(-1)} style={[s.viewerClose, gallery.index === 0 && s.disabled]}><ChevronLeft size={24} color="#fff" /></Pressable>
    <Text accessibilityLiveRegion="polite" style={s.viewerPosition}>{gallery.index + 1} / {gallery.images.length}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="下一张图片" disabled={gallery.index === gallery.images.length - 1}
      onPress={() => onNavigate(1)} style={[s.viewerClose, gallery.index === gallery.images.length - 1 && s.disabled]}><ChevronRight size={24} color="#fff" /></Pressable>
  </View>;
}
