import {afterEach, expect, it, vi} from 'vitest';
import {HeadlessAdapter} from '../packages/codex-adapter/src/headless.js';
import {normalizeThread} from '../packages/codex-adapter/src/normalize.js';
import {agentErrorMessage} from '../packages/client-shared/src/agent-errors.js';
const adapters: HeadlessAdapter[] = [];
afterEach(async () => {for (const adapter of adapters.splice(0)) await adapter.stop(); vi.restoreAllMocks();});
function fixture() {
  const adapter = new HeadlessAdapter(); adapters.push(adapter);
  const ownedWriters = new Map([['owned', Date.now() - 10000]]);
  const request = vi.fn(async (method: string, params: any) => method === 'thread/read' ? {thread: {id: params.threadId, status: {type: 'idle'}}} : {status: 'unsubscribed'});
  const stop = vi.fn(async () => {});
  const refresh = vi.spyOn(adapter, 'refreshRuntime').mockImplementation(async () => {await stop(); ownedWriters.clear(); return 'refreshed';});
  Object.assign(adapter, {connected: true, ownedWriters, rpc: {request, stop}});
  adapter.watched.set('owned', normalizeThread({id: 'owned', threadRuntimeStatus: {type: 'idle'}, turns: []}, 0));
  adapter.watched.set('other', normalizeThread({id: 'other', threadRuntimeStatus: {type: 'idle'}, turns: []}, 0));
  return {adapter, ownedWriters, request, stop, refresh};
}
it('recycles only this server after confirming its owned writers are idle, keeping observation and history', async () => {
  const {adapter, request, ownedWriters, refresh} = fixture();
  await expect(adapter.releaseIdleWriters()).resolves.toEqual({released: 1, deferred: 0});
  expect(request.mock.calls).toEqual([['thread/read', {threadId: 'owned', includeTurns: false}]]);
  expect(ownedWriters.size).toBe(0); expect(adapter.getThread('owned')).not.toBeNull(); expect(adapter.getThread('other')).not.toBeNull(); expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
  await adapter.releaseIdleWriters(true); expect(request).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
});
it.each(['active', 'starting', 'operation', 'approval', 'refresh', 'sub-agent', 'new-thread'])('never force-releases while %s needs live state', async kind => {
  const {adapter, request} = fixture();
  if (kind === 'active') adapter.watched.get('owned')!.status = 'active';
  if (kind === 'starting') Object.assign(adapter, {pendingStarts: 1});
  if (kind === 'operation') Object.assign(adapter, {pendingOperations: 1});
  if (kind === 'approval') Object.assign(adapter, {requests: new Map([['approval', {}]])});
  if (kind === 'refresh') Object.assign(adapter, {refreshing: new Map([['owned', Promise.resolve(true)]])});
  if (kind === 'sub-agent') adapter.watched.get('owned')!.subAgents = [{threadId: 'child', status: 'running', statusSource: 'thread'}];
  if (kind === 'new-thread') Object.assign(adapter, {newThreads: new Map([['owned', {}]])});
  await expect(adapter.releaseIdleWriters(true)).resolves.toEqual({released: 0, deferred: 1}); expect(request).not.toHaveBeenCalled();
});
it('waits briefly after acquisition automatically, while explicit release can act immediately', async () => {
  const {adapter, request, ownedWriters} = fixture(); ownedWriters.set('owned', Date.now());
  expect(await adapter.releaseIdleWriters()).toEqual({released: 0, deferred: 1}); expect(request).not.toHaveBeenCalled();
  expect(await adapter.releaseIdleWriters(true)).toEqual({released: 1, deferred: 0});
});
it('rechecks official runtime state and refuses an externally observed active or unknown thread', async () => {
  const {adapter, request} = fixture();
  request.mockResolvedValue({thread: {id: 'owned', status: {type: 'active'}}} as any);
  expect(await adapter.releaseIdleWriters(true)).toEqual({released: 0, deferred: 1});
  request.mockResolvedValue({thread: {id: 'owned', status: {type: 'unknown'}}} as any);
  expect(await adapter.releaseIdleWriters(true)).toEqual({released: 0, deferred: 1});
  expect(request.mock.calls.every(([method]) => method === 'thread/read')).toBe(true);
});
it('retains ownership bookkeeping after failed replacement initialization without killing the old runtime', async () => {
  const {adapter, ownedWriters, stop, refresh} = fixture();
  refresh.mockRejectedValue(new Error('initialize-rejected'));
  await expect(adapter.releaseIdleWriters(true)).rejects.toThrow('initialize-rejected'); expect(ownedWriters.has('owned')).toBe(true); expect(stop).not.toHaveBeenCalled(); expect(adapter.connected).toBe(true);
});
it('explains a conflicting writer without advising destructive history reset', () => {
  expect(agentErrorMessage('thread-writer-busy')).toContain('其他 Codex 应用');
  expect(agentErrorMessage('thread-writer-busy')).toContain('不能抢占');
});
