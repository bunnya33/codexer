import { createRoot } from 'react-dom/client';
import { Pressable, Text, View } from 'react-native';
import { FileViewerProvider } from '../../apps/mobile/src/file-viewer';
import { useFileLink } from '../../apps/mobile/src/file-link-context';
import { relay } from '../../apps/mobile/src/relay';

declare global {
  interface Window { readerFiles: Record<string, string> }
}
relay.fileInfo = async (_device, _thread, path) => ({ name: path.split('/').at(-1)!, size: new TextEncoder().encode(window.readerFiles[path]).length, version: 'a'.repeat(64), previewMaxBytes: 32 * 1024 * 1024 });
relay.fileSource = (_device, _thread, path) => ({ uri: `http://127.0.0.1:4187/source-content?path=${encodeURIComponent(path)}`, headers: {} });

function Links() {
  const open = useFileLink();
  return <View style={{ padding: 24, gap: 16 }}>{Object.keys(window.readerFiles).map(path => <Pressable key={path} accessibilityRole="button" accessibilityLabel={`打开 ${path}`} onPress={() => open?.(path)}><Text>{path}</Text></Pressable>)}</View>;
}
createRoot(document.getElementById('root')!).render(<FileViewerProvider deviceId="pc" threadId="thread"><Links /></FileViewerProvider>);
