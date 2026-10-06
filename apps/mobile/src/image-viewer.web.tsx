import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { ZoomIn, ZoomOut } from 'lucide-react-native';
import { imageSwipe } from '../../../packages/client-shared/src/images';
import type { ImageDirection, ImageGallery, ImagePreview } from '../../../packages/client-shared/src/images';
import { ImageViewerHeader, ImageViewerNavigation } from './image-viewer-controls';
import { useImageUrl } from './relay-image.web';
import { s } from './styles';

export function ImageViewerImage({ preview, onClose, onNavigate }: { preview: ImagePreview; onClose: () => void; onNavigate?: (direction: ImageDirection) => void }) {
  const image = useImageUrl(preview.source);
  const [decodeError, setDecodeError] = useState(false);
  useEffect(() => setDecodeError(false), [image.uri]);
  const [zoom, setZoom] = useState(1);
  const zoomValue = useRef(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, multiTouch: false, canSwipe: true, startX: 0, startY: 0, distance: 0, zoom: 1 });
  const changeZoom = (next: number) => {
    const value = Math.max(1, Math.min(5, next));
    zoomValue.current = value;
    setZoom(value);
    if (value === 1) setOffset({ x: 0, y: 0 });
  };
  return <View style={s.viewerImagePress}>
    <div data-testid="image-gesture-surface" style={{ height: '100%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none', cursor: zoom > 1 ? 'grab' : 'default' }}
      onWheel={event => { event.preventDefault(); gesture.current.canSwipe = false; changeZoom(zoomValue.current * (event.deltaY < 0 ? 1.15 : 1 / 1.15)); }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size === 1) gesture.current = { moved: false, multiTouch: false, canSwipe: zoomValue.current <= 1.01, startX: event.clientX, startY: event.clientY, distance: 0, zoom: zoomValue.current };
        if (pointers.current.size >= 2) {
          const [a, b] = [...pointers.current.values()];
          gesture.current = { ...gesture.current, moved: true, multiTouch: true, canSwipe: false, zoom: zoomValue.current, distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
        }
      }}
      onPointerMove={event => {
        const prior = pointers.current.get(event.pointerId);
        if (!prior) return;
        const dx = event.clientX - prior.x, dy = event.clientY - prior.y;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (Math.hypot(event.clientX - gesture.current.startX, event.clientY - gesture.current.startY) > 6) gesture.current.moved = true;
        if (pointers.current.size >= 2 && gesture.current.distance > 0) {
          const [a, b] = [...pointers.current.values()];
          changeZoom(gesture.current.zoom * Math.hypot(a!.x - b!.x, a!.y - b!.y) / gesture.current.distance);
        } else if (zoomValue.current > 1.01) setOffset(current => ({ x: current.x + dx, y: current.y + dy }));
      }}
      onPointerUp={event => {
        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.delete(event.pointerId);
        if (pointers.current.size) return;
        const dx = event.clientX - gesture.current.startX, dy = event.clientY - gesture.current.startY;
        const direction = imageSwipe(dx, dy, zoomValue.current, gesture.current.multiTouch || !gesture.current.canSwipe);
        if (direction) onNavigate?.(direction);
        else if (!gesture.current.moved && !gesture.current.multiTouch && Math.hypot(dx, dy) <= 6) onClose();
      }}
      onPointerCancel={event => { pointers.current.delete(event.pointerId); gesture.current.moved = true; gesture.current.canSwipe = false; }}
      onLostPointerCapture={event => {
        if (pointers.current.delete(event.pointerId)) { gesture.current.moved = true; gesture.current.canSwipe = false; }
      }}>
      {image.error || decodeError ? <Text accessibilityRole="alert" style={{ color: '#fff', textAlign: 'center' }}>图片暂不可用或格式不受支持</Text> : !image.uri ? <ActivityIndicator color="#fff" />
        : <img alt={preview.name} src={image.uri} draggable={false} onError={() => setDecodeError(true)} style={{ width: '100%', height: '100%', objectFit: 'contain', transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, userSelect: 'none' }} />}
    </div>
    <View style={{ position: 'absolute', bottom: 20, alignSelf: 'center', flexDirection: 'row', gap: 12, backgroundColor: '#273030', borderRadius: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="缩小图片" onPress={() => changeZoom(zoomValue.current / 1.4)} style={s.viewerClose}><ZoomOut color="#fff" size={20} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="放大图片" onPress={() => changeZoom(zoomValue.current * 1.4)} style={s.viewerClose}><ZoomIn color="#fff" size={20} /></Pressable>
    </View>
  </View>;
}
export function ImageViewer({ preview, onClose, onNavigate }: { preview: ImageGallery | null; onClose: () => void; onNavigate: (direction: ImageDirection) => void }) {
  const image = preview?.images[preview.index];
  const visible = !!preview;
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onNavigate(event.key === 'ArrowLeft' ? -1 : 1); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, onNavigate]);
  return <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
    <View style={s.viewer}>
      <ImageViewerHeader name={image?.name} onClose={onClose} />
      {image && <ImageViewerImage key={image.source.uri} preview={image} onClose={onClose} onNavigate={onNavigate} />}
      {preview && <ImageViewerNavigation gallery={preview} onNavigate={onNavigate} />}
    </View>
  </Modal>;
}
