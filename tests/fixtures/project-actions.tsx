import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ProjectActions } from '../../apps/mobile/src/project-actions';
import type { CommandResult, DeviceCatalog, RemoteCommand } from '../../packages/protocol/src/index';

const mode = new URLSearchParams(window.location.search).get('mode');
const base: DeviceCatalog = { protocolVersion: 1, deviceId: 'device', generatedAt: 1, projects: [{ id: 'project', name: 'Demo', roots: ['/projects/demo'], position: 0, updatedAt: 1 }], threads: [], ...(mode !== 'old' ? { projectDeletion: true } : {}) };
const archived = { id: 'hidden', title: 'Archived', cwd: '/projects/demo', projectId: 'project', archived: true, updatedAt: 1 };
function Fixture() {
  const [open, setOpen] = useState(true), [calls, setCalls] = useState<RemoteCommand['payload'][]>([]);
  const [catalog, setCatalog] = useState<DeviceCatalog>(mode === 'archived' ? { ...base, threads: [archived] } : base);
  const [created, setCreated] = useState(false);
  return <SafeAreaProvider><View>
    <Text testID="calls">{JSON.stringify(calls)}</Text><Text testID="created">{String(created)}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="添加归档会话" onPress={() => setCatalog({ ...base, threads: [archived] })}><Text>添加归档会话</Text></Pressable>
    {open && <ProjectActions projectId="project" name="Demo" catalog={catalog} online={mode !== 'offline'} close={() => setOpen(false)} createThread={() => { setCreated(true); setOpen(false); }} send={async payload => {
      setCalls(current => [...current, payload]);
      const response: CommandResult = { commandId: 'command', deviceId: 'device', status: 'succeeded', code: 'acknowledged' };
      if (payload.type === 'project.delete.prepare') return { ...response, result: { projectId: 'project', token: 'd3820d62-6dc2-4b14-8e57-6b7c66b8802c', expiresAt: Date.now() + 300000, name: 'Demo', roots: ['/projects/demo'], directoryDeletion: mode !== 'protected', ...(mode === 'protected' ? { directoryReason: 'project-directory-shared' } : {}) } };
      if (mode === 'stale') return { ...response, status: 'failed', code: 'project-deletion-stale' };
      return { ...response, result: { projectId: 'project', directoryDeleted: payload.deleteDirectory && mode !== 'partial' } };
    }}/>}
  </View></SafeAreaProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
