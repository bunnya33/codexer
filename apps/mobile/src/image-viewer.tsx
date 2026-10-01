import { useState } from 'react';
import { Image, Modal, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ResumableZoom } from 'react-native-zoom-toolkit';
import { StatusBar } from 'expo-status-bar';
import { X } from 'lucide-react-native';
import { s } from './styles';

type Preview = { source: { uri: string; headers?: Record<string, string> }; name: string };

function ZoomImage({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  return <View style={s.viewerImagePress} onLayout={event => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  }}>
    {size.width > 0 && size.height > 0 && <ResumableZoom key={preview.source.uri} maxScale={5} panMode="clamp" scaleMode="clamp" pinchMode="clamp" onTap={onClose}>
      <Image source={preview.source} style={{ width: size.width, height: size.height }} resizeMode="contain" />
    </ResumableZoom>}
  </View>;
}

export function ImageViewer({ preview, onClose }: { preview: Preview | null; onClose: () => void }) {
  return <Modal visible={!!preview} transparent animationType="fade" onRequestClose={onClose}>
    <GestureHandlerRootView style={s.viewer}>
      <SafeAreaProvider style={s.viewer}>
        <SafeAreaView style={s.viewer} edges={['top', 'bottom']}>
          <StatusBar style="light" />
          <View style={s.viewerHeader}>
            <Text style={s.viewerTitle} numberOfLines={1}>{preview?.name}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭图片" onPress={onClose} style={s.viewerClose}><X size={22} color="#fff" /></Pressable>
          </View>
          {preview && <ZoomImage preview={preview} onClose={onClose} />}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  </Modal>;
}
