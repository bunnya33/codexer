import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectBrowser} from '../../apps/mobile/src/project-browser';
import {relay} from '../../apps/mobile/src/relay';

declare global {
  interface Window {
    __projectFiles: typeof relay.projectFiles;
  }
}
relay.projectFiles = (...args) => window.__projectFiles(...args);
relay.projectFileSource = (_device, _project, _root, path) => ({uri: `https://fixture.test/files/${path}`, headers: {}});
function Fixture() {
  const [open, setOpen] = useState(true);
  return <ProjectBrowser open={open} onClose={() => setOpen(false)} deviceId="device" project={{id: 'project', name: 'Demo', roots: ['/demo'], position: 0, updatedAt: 1}} online supported/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
