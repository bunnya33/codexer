import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ProjectCreate } from '../../apps/mobile/src/project-create';
import type { DeviceCatalog, RemoteCommand } from '../../packages/protocol/src/index';

const catalog: DeviceCatalog = { protocolVersion: 1, deviceId: 'fixture', generatedAt: 1, projects: [], threads: [], projectCreation: { parents: [{ id: 'local-parent', path: '/authorized/projects' }] } };
function Fixture() {
  const [open, setOpen] = useState(true), [authorized, setAuthorized] = useState(true);
  const [payload, setPayload] = useState<RemoteCommand['payload'] | null>(null);
  return <SafeAreaProvider><View>
    <Pressable accessibilityRole="button" accessibilityLabel="打开授权表单" onPress={() => { setAuthorized(true); setOpen(true); }}><Text>打开授权表单</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="打开未授权表单" onPress={() => { setAuthorized(false); setOpen(true); }}><Text>打开未授权表单</Text></Pressable>
    <Text testID="created-payload">{JSON.stringify(payload)}</Text>
    {open && <ProjectCreate key={String(authorized)} catalog={authorized ? catalog : { ...catalog, projectCreation: { parents: [] } }} online create={async value => { if (value.mode === 'new') throw new Error('project-folder-exists'); setPayload(value); setOpen(false); }} close={() => setOpen(false)}/>}
  </View></SafeAreaProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
