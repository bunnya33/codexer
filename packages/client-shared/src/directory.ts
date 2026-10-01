import type { DeviceCatalog, DeviceSnapshot } from '../../protocol/src/index.js';

export type DirectoryThread = { type: 'thread'; id: string; title: string; active: boolean; nested: boolean };
export type DirectoryProject = { type: 'project'; id: string; name: string; expanded: boolean; active: boolean; threads: DirectoryThread[] };
export type DirectoryRow = { type: 'section'; id: string; title: string } | DirectoryProject | DirectoryThread;

export function buildDirectoryRows({catalog, snapshot, deviceId, expandedProjects, search}: {
  catalog?: DeviceCatalog; snapshot?: DeviceSnapshot; deviceId: string; expandedProjects: readonly string[]; search: string;
}): DirectoryRow[] {
  if (!catalog) return [];
  const query = search.trim().toLowerCase();
  const available = catalog.threads.filter(thread => !thread.archived);
  const groups = [...[...catalog.projects].sort((a, b) => a.position - b.position).map(project => ({id: project.id, name: project.name})), {id: 'unassigned', name: '未归类会话'}];
  const row = (thread: DeviceCatalog['threads'][number], nested: boolean): DirectoryThread => ({type: 'thread', id: thread.id, title: thread.title || '未命名会话', active: snapshot?.threads[thread.id]?.status === 'active', nested});
  const result: DirectoryRow[] = [{type: 'section', id: 'projects', title: '项目'}];
  for (const group of groups) {
    const members = available.filter(thread => (thread.projectId ?? 'unassigned') === group.id);
    const matching = members.filter(thread => !query || `${thread.title} ${group.name} ${thread.cwd ?? ''}`.toLowerCase().includes(query)).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!members.length && group.id === 'unassigned' || query && !matching.length && !group.name.toLowerCase().includes(query)) continue;
    // Keep child data while collapsed so its height can animate instead of removing rows at once.
    result.push({type: 'project', id: group.id, name: group.name, expanded: expandedProjects.includes(`${deviceId}:${group.id}`) || !!query,
      active: members.some(thread => snapshot?.threads[thread.id]?.status === 'active'), threads: matching.map(thread => row(thread, true))});
  }
  const matches = available.filter(thread => !query || `${thread.title} ${thread.cwd ?? ''}`.toLowerCase().includes(query)).sort((a, b) => b.updatedAt - a.updatedAt);
  const recent = query ? matches : matches.slice(0, 30);
  if (recent.length) result.push({type: 'section', id: 'recent', title: query ? '匹配会话' : '最近'});
  result.push(...recent.map(thread => row(thread, false)));
  return result;
}
