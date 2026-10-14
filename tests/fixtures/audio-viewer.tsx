import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { FileViewerProvider } from '../../apps/mobile/src/file-viewer';
import { Markdown } from '../../apps/mobile/src/markdown';
import { relay } from '../../apps/mobile/src/relay';
import { PreviewContext } from '../../apps/mobile/src/preview-context';
import { TurnView } from '../../apps/mobile/src/conversation';

type Config = { url: string; username: string; password: string; deviceId: string; threadId: string; paths: string[]; inline?: boolean; body?: string };
const config = (window as unknown as { audioConfig: Config }).audioConfig;
const root = createRoot(document.getElementById('root')!);
const render = (threadId = config.threadId) => root.render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
    <FileViewerProvider deviceId={config.deviceId} threadId={threadId}>
      <PreviewContext.Provider value={{ deviceId: config.deviceId, threadId }}>
        {config.inline ? <TurnView turn={{ id: 'turn', status: 'completed', truncated: false, items: [{
          id: 'answer', type: 'agentMessage', phase: 'final_answer', truncated: false,
          text: config.body ?? config.paths.map((path, index) => `![试听 ${index + 1}](<${path}>)\n\n[下载音频 ${index + 1}](<${path}>)`).join('\n\n'),
          // Existing history may still contain the former image registration.
          images: config.paths.map((path, index) => ({ id: `old-image-${index}`, name: path.split('/').at(-1)!, source: path })),
        }] }} active={false} deviceId={config.deviceId} threadId={threadId} onImage={() => {}} questionRequestIds={[]} />
          : <Markdown>{config.paths.map((path, index) => `[播放音频 ${index + 1}](<${path}>)`).join('\n\n')}</Markdown>}
      </PreviewContext.Provider>
    </FileViewerProvider>
  </SafeAreaProvider>,
);
const ready = relay.connect(config.url, config.username, config.password).then(() => render());
Object.assign(window, { audioFixture: { ready, switchThread: render, close: () => { root.unmount(); relay.disconnect(); } } });
