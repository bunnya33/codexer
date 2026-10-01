import { expect, it } from 'vitest';
import { buildDirectoryRows } from '../packages/client-shared/src/directory.js';
import type { DirectoryProject } from '../packages/client-shared/src/directory.js';
import type { DeviceCatalog } from '../packages/protocol/src/index.js';
import { snapshot } from './helpers.js';

const catalog: DeviceCatalog = {protocolVersion: 1, deviceId: 'device-test', generatedAt: 1, projects: [{id: 'empty', name: 'Empty project', roots: ['/empty'], position: 0, updatedAt: 1}, {id: 'work', name: 'Work', roots: ['/work'], position: 1, updatedAt: 1}],
  threads: [{id: 'thread-test', title: 'Running chat', cwd: '/work', projectId: 'work', updatedAt: 2, archived: false}, {id: 'idle', title: 'Idle chat', cwd: '/work', projectId: 'work', updatedAt: 1, archived: false}]};
const projects = (rows: ReturnType<typeof buildDirectoryRows>) => rows.filter((row): row is DirectoryProject => row.type === 'project');

it('retains empty projects and collapsed child data, and aggregates running conversations without a count field', () => {
  const rows = buildDirectoryRows({catalog, snapshot: snapshot(), deviceId: 'device-test', expandedProjects: [], search: ''});
  expect(projects(rows)).toMatchObject([{id: 'empty', expanded: false, active: false, threads: []}, {id: 'work', expanded: false, active: true, threads: [{id: 'thread-test', active: true}, {id: 'idle', active: false}]}]);
  expect(projects(rows).some(project => 'count' in project)).toBe(false);
});
it('isolates expansion by device, supports empty project search, and keeps running state while filtering visible chats', () => {
  const options = {catalog, snapshot: snapshot(), deviceId: 'device-test', expandedProjects: ['other-device:work'], search: ''};
  expect(projects(buildDirectoryRows(options))[1]!.expanded).toBe(false);
  expect(projects(buildDirectoryRows({...options, expandedProjects: ['device-test:work']}))[1]!.expanded).toBe(true);
  expect(projects(buildDirectoryRows({...options, search: 'Empty project'}))).toMatchObject([{id: 'empty', expanded: true, threads: []}]);
  expect(projects(buildDirectoryRows({...options, search: 'Idle chat'}))).toMatchObject([{id: 'work', expanded: true, active: true, threads: [{id: 'idle', active: false}]}]);
});
it('ignores archived conversations when determining project activity and retains the recent list', () => {
  const rows = buildDirectoryRows({catalog: {...catalog, threads: catalog.threads.map(thread => thread.id === 'thread-test' ? {...thread, archived: true} : thread)}, snapshot: snapshot(), deviceId: 'device-test', expandedProjects: [], search: ''});
  expect(projects(rows)[1]).toMatchObject({active: false, threads: [{id: 'idle'}]});
  expect(rows.filter(row => row.type === 'thread')).toMatchObject([{id: 'idle', nested: false}]);
});
