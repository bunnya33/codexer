import { createRoot } from 'react-dom/client';
import App from '../../apps/mobile/App';
import { relay } from '../../apps/mobile/src/relay';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
Object.assign(window, { selectionApp: { relay, close: () => root.unmount() } });
