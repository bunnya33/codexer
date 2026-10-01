import { useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { X, ZoomIn, ZoomOut } from 'lucide-react-native';
import { useImageUrl } from './relay-image.web';
import type { RemoteImageSource } from './relay-image';
import { s } from './styles';

type Preview = { source: RemoteImageSource; name: string };
function ZoomImage({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  const image = useImageUrl(preview.source);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, distance: 0, zoom: 1 });
  const changeZoom = (next: number) => { const value = Math.max(1, Math.min(5, next)); setZoom(value); if (value === 1) setOffset({ x: 0, y: 0 }); };
  return <View style={s.viewerImagePress}>
    {image.error ? <Text style={{ color: '#fff', textAlign: 'center' }}>图片暂不可用</Text> : !image.uri ? <ActivityIndicator /> : <div style={{ height: '100%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none', cursor: zoom > 1 ? 'grab' : 'zoom-in' }}
      onWheel={event => { event.preventDefault(); changeZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)); }}
      onPointerDown={event => {
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size === 1) gesture.current = { moved: false, distance: 0, zoom };
        if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; gesture.current = { moved: true, zoom, distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) }; }
      }}
      onPointerMove={event => {
        const prior = pointers.current.get(event.pointerId);
        if (!prior) return;
        const dx = event.clientX - prior.x, dy = event.clientY - prior.y;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (Math.abs(dx) + Math.abs(dy) > 3) gesture.current.moved = true;
        if (pointers.current.size >= 2 && gesture.current.distance > 0) { const [a, b] = [...pointers.current.values()]; changeZoom(gesture.current.zoom * Math.hypot(a!.x - b!.x, a!.y - b!.y) / gesture.current.distance); }
        else if (zoom > 1) setOffset(current => ({ x: current.x + dx, y: current.y + dy }));
      }}
      onPointerUp={event => { pointers.current.delete(event.pointerId); if (!pointers.current.size && !gesture.current.moved) onClose(); }}
      onPointerCancel={event => { pointers.current.delete(event.pointerId); gesture.current.moved = true; }}>
      <img alt={preview.name} src={image.uri} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, userSelect: 'none' }} />
    </div>}
    <View style={{ position: 'absolute', bottom: 20, alignSelf: 'center', flexDirection: 'row', gap: 12, backgroundColor: '#273030', borderRadius: 8 }}><Pressable accessibilityRole="button" accessibilityLabel="缩小图片" onPress={() => changeZoom(zoom / 1.4)} style={s.viewerClose}><ZoomOut color="#fff" size={20} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="放大图片" onPress={() => changeZoom(zoom * 1.4)} style={s.viewerClose}><ZoomIn color="#fff" size={20} /></Pressable></View>
  </View>;
}
export function ImageViewer({ preview, onClose }: { preview: Preview | null; onClose: () => void }) {
  return <Modal visible={!!preview} animationType="fade" onRequestClose={onClose}><View style={s.viewer}><View style={s.viewerHeader}><Text style={s.viewerTitle} numberOfLines={1}>{preview?.name}</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭图片" onPress={onClose} style={s.viewerClose}><X size={22} color="#fff" /></Pressable></View>{preview && <ZoomImage key={preview.source.uri} preview={preview} onClose={onClose} />}</View></Modal>;
}
