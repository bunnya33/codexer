import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ResumableZoom } from 'react-native-zoom-toolkit';
import type { ResumableZoomRefType } from 'react-native-zoom-toolkit';
import { StatusBar } from 'expo-status-bar';
import { imageSwipe } from '../../../packages/client-shared/src/images';
import type { ImageDirection, ImageGallery, ImagePreview } from '../../../packages/client-shared/src/images';
import { ImageViewerHeader, ImageViewerNavigation } from './image-viewer-controls';
import { s } from './styles';

export function ImageViewerImage({ preview, onClose, onNavigate }: { preview: ImagePreview; onClose: () => void; onNavigate?: (direction: ImageDirection) => void }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(!preview.svgXml);
  const [error, setError] = useState(false);
  const zoom = useRef<ResumableZoomRefType>(null);
  const canSwipe = useRef(false);
  return <View style={s.viewerImagePress} onLayout={event => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  }}>
    {size.width > 0 && size.height > 0 && <ResumableZoom ref={zoom} maxScale={5} panMode="clamp" scaleMode="clamp" pinchMode="clamp" onTap={onClose}
      onPanStart={() => { canSwipe.current = (zoom.current?.getState().scale ?? 1) <= 1.01; }}
      onPinchStart={() => { canSwipe.current = false; }}
      onPanEnd={event => {
        const direction = imageSwipe(event.translationX, event.translationY, zoom.current?.getState().scale ?? 1, !canSwipe.current);
        canSwipe.current = false;
        if (direction) onNavigate?.(direction);
      }}>
      {preview.svgXml ? <SvgXml xml={preview.svgXml} width={size.width} height={size.height} onError={() => setError(true)} />
        : <Image source={preview.source} style={{ width: size.width, height: size.height }} resizeMode="contain" onLoad={() => setLoading(false)} onError={() => { setLoading(false); setError(true); }} />}
    </ResumableZoom>}
    {(loading || error) && <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
      {error ? <Text accessibilityRole="alert" style={{ color: '#fff' }}>图片暂不可用或格式不受支持</Text> : <ActivityIndicator color="#fff" />}
    </View>}
  </View>;
}

export function ImageViewer({ preview, onClose, onNavigate }: { preview: ImageGallery | null; onClose: () => void; onNavigate: (direction: ImageDirection) => void }) {
  const image = preview?.images[preview.index];
  return <Modal visible={!!preview} transparent animationType="fade" onRequestClose={onClose}>
    <GestureHandlerRootView style={s.viewer}>
      <SafeAreaProvider style={s.viewer}>
        <SafeAreaView style={s.viewer} edges={['top', 'bottom']}>
          <StatusBar style="light" />
          <ImageViewerHeader name={image?.name} onClose={onClose} />
          {image && <ImageViewerImage key={image.source.uri} preview={image} onClose={onClose} onNavigate={onNavigate} />}
          {preview && <ImageViewerNavigation gallery={preview} onNavigate={onNavigate} />}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  </Modal>;
}
