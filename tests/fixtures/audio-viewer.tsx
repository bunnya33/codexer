import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { FileViewerProvider } from '../../apps/mobile/src/file-viewer';
import { Markdown } from '../../apps/mobile/src/markdown';
import { relay } from '../../apps/mobile/src/relay';

type Config = { url: string; username: string; password: string; deviceId: string; threadId: string; paths: string[] };
const config = (window as unknown as { audioConfig: Config }).audioConfig;
const root = createRoot(document.getElementById('root')!);
const render = (threadId = config.threadId) => root.render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
    <FileViewerProvider deviceId={config.deviceId} threadId={threadId}>
      <Markdown>{config.paths.map((path, index) => `[播放音频 ${index + 1}](<${path}>)`).join('\n\n')}</Markdown>
    </FileViewerProvider>
  </SafeAreaProvider>,
);
const ready = relay.connect(config.url, config.username, config.password).then(() => render());
Object.assign(window, { audioFixture: { ready, switchThread: render, close: () => { root.unmount(); relay.disconnect(); } } });
