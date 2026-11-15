import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { FileViewerProvider } from '../../apps/mobile/src/file-viewer';
import { useFileLink } from '../../apps/mobile/src/file-link-context';
import { relay } from '../../apps/mobile/src/relay';
type File = { name: string; size: number };
declare global { interface Window { documentFiles: Record<string, File> } }
relay.fileInfo = async (_device, _thread, path) => ({ ...window.documentFiles[path]!, version: 'a'.repeat(64), previewMaxBytes: 32 * 1024 * 1024 });
relay.fileSource = (_device, _thread, path) => ({ uri: `http://127.0.0.1:4188/v1/devices/pc/threads/thread/files/content?path=${encodeURIComponent(path)}&version=${'a'.repeat(64)}`, headers: { authorization: 'Bearer fixture-only' } });
function Links() {
  const open = useFileLink();
  return <View style={{ padding: 24, gap: 20 }}>{Object.keys(window.documentFiles).map(path => <Pressable key={path} accessibilityRole="button" accessibilityLabel={`打开 ${path}`} onPress={() => open?.(path)}><Text>{path}</Text></Pressable>)}</View>;
}
function Fixture() {
  const [thread, setThread] = useState('thread');
  return <><Pressable accessibilityRole="button" accessibilityLabel="切换会话" onPress={() => setThread(value => value === 'thread' ? 'other' : 'thread')}><Text>切换会话</Text></Pressable><FileViewerProvider deviceId="pc" threadId={thread}><Links /></FileViewerProvider></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
