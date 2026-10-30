import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {HeadlessAdapter} from '../packages/codex-adapter/src/headless.js';
import {normalizeThread} from '../packages/codex-adapter/src/normalize.js';

const fixture = vi.hoisted(() => ({version: 'old', failInitialize: false, rejectResume: false, children: [] as Array<{kill: ReturnType<typeof vi.fn>; stdout: PassThrough; received: string[]}>}));
vi.mock('../packages/codex-adapter/src/binary.js', () => ({resolveCodexRuntime: async () => ({binary: fixture.version, fingerprint: fixture.version})}));
vi.mock('node:child_process', () => ({spawn: vi.fn(() => {
  const child = Object.assign(new EventEmitter(), {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), received: [] as string[]});
  child.kill.mockImplementation(() => {queueMicrotask(() => child.emit('close', 0)); return true;});
  child.stdin.on('data', value => {
    const request = JSON.parse(String(value));
    child.received.push(request.method);
    if (!request.id) return;
    const result = request.method === 'thread/read' ? {thread: {id: 'thread-test', cwd: '/test', status: {type: 'idle'}, preview: 'Test'}}
      : request.method === 'thread/turns/list' || request.method === 'thread/list' ? {data: [], nextCursor: null} : {};
    const response = fixture.failInitialize && request.method === 'initialize' ? {error: {message: 'incomplete installation'}}
      : fixture.rejectResume && request.method === 'thread/resume' ? {error: {message: 'thread synthetic already has an active writer'}} : {result};
    queueMicrotask(() => child.stdout.write(JSON.stringify({id: request.id, ...response}) + '\n'));
  });
  fixture.children.push(child);
  return child;
})}));
const adapters: HeadlessAdapter[] = [];
beforeEach(() => {fixture.version = 'old'; fixture.failInitialize = false; fixture.rejectResume = false; fixture.children = [];});
afterEach(async () => {for (const adapter of adapters.splice(0)) await adapter.stop();});
async function connected() {
  const adapter = new HeadlessAdapter(); adapters.push(adapter);
  await adapter.connect();
  adapter.watched.set('thread-test', normalizeThread({id: 'thread-test', threadRuntimeStatus: {type: 'idle'}, turns: []}, 0));
  return adapter;
}

it('normalizes a rejected active writer into an actionable conflict without retrying the message', async () => {
  const adapter = await connected(); fixture.rejectResume = true;
  await expect((adapter as any).rpc.request('thread/resume', {threadId: 'synthetic'})).rejects.toMatchObject({code: 'thread-writer-busy', uncertain: false});
  expect(fixture.children[0]!.received.filter(method => method === 'thread/resume')).toHaveLength(1);
  expect(fixture.children[0]!.received).not.toContain('turn/start');
});

it('switches only the owned idle server and preserves selected settings and subscriptions', async () => {
  const adapter = await connected();
  const settings = new Map([['thread-test', {model: 'chosen-model', effort: 'high'}]]);
  Object.assign(adapter, {settings});
  fixture.version = 'new';
  await expect(adapter.refreshRuntime()).resolves.toBe('refreshed');
  expect(fixture.children).toHaveLength(2);
  expect(fixture.children[0]!.kill).toHaveBeenCalledOnce();
  expect(fixture.children[1]!.received).toContain('thread/read');
  expect(fixture.children[1]!.received).not.toContain('thread/resume');
  await vi.waitFor(() => expect(adapter.getThread('thread-test')?.settings?.model).toBe('chosen-model'));
  expect(settings.get('thread-test')).toMatchObject({model: 'chosen-model', effort: 'high'});
  expect(adapter.connected).toBe(true);
  await expect(adapter.refreshRuntime()).resolves.toBe('unchanged');
  expect(fixture.children).toHaveLength(2);
});

it.each(['active', 'starting', 'request', 'new-thread', 'sub-agent'])('defers a changed runtime while %s retains live state', async kind => {
  const adapter = await connected();
  if (kind === 'active') Object.assign(adapter, {busyTurns: new Set(['turn'])});
  if (kind === 'starting') Object.assign(adapter, {pendingStarts: 1});
  if (kind === 'request') Object.assign(adapter, {requests: new Map([['request', {}]])});
  if (kind === 'new-thread') Object.assign(adapter, {newThreads: new Map([['empty', {}]])});
  if (kind === 'sub-agent') adapter.watched.get('thread-test')!.subAgents = [{threadId: 'child', status: 'running', statusSource: 'thread'}];
  fixture.version = 'new';
  await expect(adapter.refreshRuntime(true)).resolves.toBe('deferred');
  expect(fixture.children).toHaveLength(1);
  expect(fixture.children[0]!.kill).not.toHaveBeenCalled();
});

it('keeps the old server alive if the updated runtime fails to initialize', async () => {
  const adapter = await connected();
  fixture.version = 'broken'; fixture.failInitialize = true;
  await expect(adapter.refreshRuntime()).rejects.toThrow('initialize-rejected');
  expect(fixture.children[0]!.kill).not.toHaveBeenCalled();
  expect(adapter.connected).toBe(true);
  fixture.version = 'repaired'; fixture.failInitialize = false;
  await expect(adapter.refreshRuntime()).resolves.toBe('refreshed');
  expect(fixture.children[0]!.kill).toHaveBeenCalledOnce();
});

it('starts an unavailable owned service on an explicit refresh without eagerly starting it during automatic checks', async () => {
  const adapter = new HeadlessAdapter(); adapters.push(adapter);
  await expect(adapter.refreshRuntime()).resolves.toBe('unchanged');
  expect(fixture.children).toHaveLength(0);
  await expect(adapter.refreshRuntime(true)).resolves.toBe('refreshed');
  expect(adapter.connected).toBe(true);
  expect(fixture.children).toHaveLength(1);
});
