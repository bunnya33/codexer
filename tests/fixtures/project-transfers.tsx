import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ProjectTransfers } from '../../apps/mobile/src/project-transfers';
import { relay } from '../../apps/mobile/src/relay';
import type { ProjectTransfer } from '../../packages/protocol/src/project-transfers';
const mode = new URLSearchParams(window.location.search).get('mode');
const calls: unknown[] = []; (window as any).transferCalls = calls;
const now = Date.now();
const base: ProjectTransfer = {id: '58c099d1-d461-489e-87ae-c55aa8406355', sourceDeviceId: 'source', targetDeviceId: 'target', projectId: 'project', name: 'Demo', parentId: 'parent', parentPath: 'F:/Projects', relativePath: 'demo',
  options: {includeGit: true, includeLocalFiles: false, excludedDirectories: ['node_modules'], note: ''}, state: mode === 'received' ? 'completed' : 'ready', size: 1024, uploaded: 0, downloaded: mode === 'received' ? 1024 : 0, sha256: 'a'.repeat(64), files: 2, directories: 1, excluded: 1, excludedSamples: ['node_modules'], roots: [''], savedPath: mode === 'received' ? 'F:/Projects/demo' : '', targetProjectId: mode === 'received' ? 'received-project' : '', code: '', createdAt: now, updatedAt: now, expiresAt: now + 86400000};
let jobs: ProjectTransfer[] = ['ready', 'received', 'waiting', 'packing', 'scanning', 'stale', 'legacy', 'source-offline'].includes(mode ?? '') ? [{...base}] : [];
if (['waiting', 'packing', 'scanning', 'stale', 'legacy', 'source-offline'].includes(mode ?? '')) {
  jobs[0].state = 'preparing'; jobs[0].createdAt = now - 123000;
  if (mode !== 'legacy' && mode !== 'source-offline') jobs[0].preparation = {phase: mode === 'packing' ? 'packing' : mode === 'scanning' ? 'scanning' : 'waiting', reason: mode === 'packing' || mode === 'scanning' ? '' : 'project-active',
    blockers: mode === 'packing' || mode === 'scanning' ? [] : [{id: 'source-task', title: 'Creator build', reason: 'running'}], files: 20, directories: 3, processedFiles: 10, processedBytes: 512, totalBytes: 1024, updatedAt: mode === 'stale' ? now - 45000 : now};
}
const view = {...relay.getSnapshot(), phase: 'connected', url: 'https://fixture.test', userId: 'user', devices: [{id: 'source', name: 'Source PC', online: mode !== 'source-offline', platform: 'win32'}, {id: 'target', name: 'Target PC', online: mode !== 'offline', platform: 'win32'}],
  catalogs: {source: {projectTransfer: true}, target: {projectTransfer: true, projectCreation: {parents: [{id: 'parent', path: 'F:/Projects'}]}}}};
Object.assign(relay, {
  getSnapshot: () => view, subscribe: () => () => {},
  projectTransfers: async () => jobs,
  prepareProjectTransfer: async (payload: any) => {calls.push({prepare: payload}); const job = {...base, ...payload, name: 'Demo', state: 'preparing' as const, parentPath: 'F:/Projects'}; jobs = [job]; return job;},
  projectTransferAction: async (id: string, action: string) => {calls.push({id, action}); jobs = jobs.map(j => ({...j, state: action === 'start' ? 'uploading' : 'cancelled'})); return jobs.find(j => j.id === id);},
});
function Fixture() {
  const [open, setOpen] = useState(true);
  return <SafeAreaProvider><Pressable accessibilityRole="button" onPress={() => setOpen(true)}><Text>重新打开</Text></Pressable>
    {open && <ProjectTransfers source={mode === 'received' ? undefined : {deviceId: 'source', id: 'project', name: 'Demo'}} close={() => setOpen(false)}/>}
  </SafeAreaProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
