import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

const scope = (userId = 'user-a', url = 'http://relay.test') => JSON.stringify([url, userId]);
const uri = 'file:///app/control-selections-v1.json';
const selected = { deviceId: 'pc-b', threadId: 'older-pc-b' };
let source = '';
beforeAll(async () => {
  const result = await build({
    stdin: { contents: `import{useState}from'react';import{createRoot}from'react-dom/client';import{useConversationSelection}from'./apps/mobile/src/conversation-selection';
      function App(){const[view,setView]=useState(window.fixtureView);window.updateView=patch=>setView(v=>({...v,...patch}));const selection=useConversationSelection(view);window.selection=selection;return <output data-device={selection.deviceId} data-thread={selection.threadId}/>;}
      const root=createRoot(document.getElementById('root'));window.stopPanel=()=>root.unmount();root.render(<App/>);`, resolveDir: resolve('.'), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    // Deliberately resolve the real native storage, not selection-storage.web.ts.
    resolveExtensions: ['.tsx', '.ts', '.js', '.json'],
    plugins: [{ name: 'native-filesystem', setup(builder) {
      builder.onResolve({ filter: /^expo-file-system\/legacy$/ }, () => ({ path: 'filesystem', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const documentDirectory="file:///app/";export const readAsStringAsync=window.fixtureRead;export const writeAsStringAsync=window.fixtureWrite;' }));
    } }],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  source = result.outputFiles[0]!.text;
});
const wait = (fn: () => void) => vi.waitFor(fn, { timeout: 3000, interval: 10 });
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function fixture(options: { disk?: Map<string, string>; readGate?: Promise<void>; firstWriteGate?: Promise<void>; failWrite?: boolean; offline?: boolean; userId?: string; url?: string } = {}) {
  const disk = options.disk ?? new Map<string, string>(), errors: unknown[] = [], writes: string[] = [];
  let pending = 0, failWrite = options.failWrite ?? false, calls = 0;
  const read = vi.fn(async (path: string) => { const text = disk.get(path); await options.readGate; if (text === undefined) throw Error('missing'); return text; });
  const write = vi.fn(async (path: string, value: string) => {
    pending++; const number = ++calls;
    try { if (number === 1) await options.firstWriteGate; if (failWrite) throw Error('disk-unavailable'); disk.set(path, value); writes.push(value); }
    finally { pending--; }
  });
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://fixture.test', runScripts: 'dangerously', beforeParse(w) {
    w.addEventListener('error', e => errors.push(e.error));
    Object.assign(w, { fixtureRead: read, fixtureWrite: write, fixtureView: {
      userId: options.userId ?? 'user-a', url: options.url ?? 'http://relay.test', devicesReady: true,
      devices: [{ id: 'pc-a', online: true }, { id: 'pc-b', online: !options.offline }],
      catalogs: Object.fromEntries(['pc-a', 'pc-b'].map(id => [id, { threads: [{ id: `recent-${id}`, updatedAt: 20 }, { id: `older-${id}`, updatedAt: 10 }] }])),
    } });
  } });
  dom.window.eval(source);
  await wait(() => expect(dom.window.document.querySelector('output')).not.toBeNull());
  const app = dom.window as unknown as { selection: { deviceId: string; threadId: string; selectDevice(id: string): void; selectThread(id: string): void }; updateView(patch: Record<string, unknown>): void; stopPanel(): void };
  return { app, disk, read, write, writes, errors, dom, setWriteFailure(value: boolean) { failWrite = value; },
    async flushed() { await wait(() => expect(pending).toBe(0)); },
    close() { app.stopPanel(); dom.window.close(); },
  };
}

it('restores a chosen device and conversation after native storage and module restart, including offline devices', async () => {
  const first = await fixture(); let disk: Map<string, string>;
  try {
    await wait(() => expect(first.app.selection.deviceId).toBe('pc-a'));
    first.app.selection.selectDevice('pc-b');
    await wait(() => expect(first.app.selection.deviceId).toBe('pc-b'));
    first.app.selection.selectThread('older-pc-b');
    await wait(() => expect(JSON.parse(first.disk.get(uri)!)[scope()]).toEqual(selected));
    await first.flushed(); disk = first.disk;
  } finally { first.close(); }
  const second = await fixture({ disk, offline: true });
  try {
    await wait(() => expect(second.app.selection).toMatchObject(selected));
    expect(second.writes.every(value => JSON.parse(value)[scope()].deviceId === 'pc-b')).toBe(true);
    expect(second.errors).toEqual([]);
  } finally { second.close(); }
});

it('waits for native disk reads instead of loading and persisting the default device first', async () => {
  const read = gate(), disk = new Map([[uri, JSON.stringify({ [scope()]: selected })]]);
  const f = await fixture({ disk, readGate: read.promise });
  try {
    expect(f.app.selection.deviceId).toBe(''); expect(f.write).not.toHaveBeenCalled();
    read.release(); await wait(() => expect(f.app.selection).toMatchObject(selected));
    await f.flushed(); expect(f.writes.every(value => JSON.parse(value)[scope()].deviceId === 'pc-b')).toBe(true);
  } finally { read.release(); f.close(); }
});

it('keeps a newer manual choice when the saved preference arrives late and serializes rapid writes', async () => {
  const read = gate(), write = gate(), disk = new Map([[uri, JSON.stringify({ [scope()]: selected })]]);
  const f = await fixture({ disk, readGate: read.promise, firstWriteGate: write.promise });
  try {
    f.app.selection.selectDevice('pc-a');
    await wait(() => expect(f.app.selection.deviceId).toBe('pc-a'));
    f.app.selection.selectThread('older-pc-a');
    await wait(() => expect(f.app.selection.threadId).toBe('older-pc-a'));
    read.release(); await wait(() => expect(f.write).toHaveBeenCalledTimes(1));
    f.app.selection.selectDevice('pc-b'); await wait(() => expect(f.app.selection.deviceId).toBe('pc-b'));
    f.app.selection.selectThread('older-pc-b'); await wait(() => expect(f.app.selection.threadId).toBe('older-pc-b'));
    write.release(); await wait(() => expect(JSON.parse(disk.get(uri)!)[scope()]).toEqual(selected));
    await f.flushed(); expect(f.errors).toEqual([]);
  } finally { read.release(); write.release(); f.close(); }
});

it('isolates server and account preferences and ignores restoration for a former login', async () => {
  const read = gate(), disk = new Map([[uri, JSON.stringify({ [scope()]: selected, [scope('user-b', 'http://other.test')]: selected })]]);
  const f = await fixture({ disk, readGate: read.promise });
  try {
    f.app.updateView({ userId: 'user-b' });
    await wait(() => expect(f.app.selection.deviceId).toBe(''));
    read.release(); await wait(() => expect(f.app.selection.deviceId).toBe('pc-a'));
    await wait(() => expect(JSON.parse(disk.get(uri)!)[scope('user-b')].deviceId).toBe('pc-a'));
    expect(JSON.parse(disk.get(uri)!)[scope()]).toEqual(selected);
    expect(JSON.parse(disk.get(uri)!)[scope('user-b', 'http://other.test')]).toEqual(selected);
    f.app.updateView({ userId: null }); await wait(() => expect(f.app.selection.deviceId).toBe(''));
    f.app.updateView({ userId: 'user-a' }); await wait(() => expect(f.app.selection).toMatchObject(selected));
    expect(f.errors).toEqual([]);
  } finally { read.release(); f.close(); }
});

it('falls back after a confirmed device removal and persists the replacement', async () => {
  const f = await fixture({ disk: new Map([[uri, JSON.stringify({ [scope()]: selected })]]) });
  try {
    await wait(() => expect(f.app.selection).toMatchObject(selected));
    f.app.updateView({ devices: [{ id: 'pc-a', online: true }] });
    await wait(() => expect(JSON.parse(f.disk.get(uri)!)[scope()]).toEqual({ deviceId: 'pc-a', threadId: 'recent-pc-a' }));
  } finally { f.close(); }
});

it('tolerates corrupt preferences and retries persistence after a disk error', async () => {
  const f = await fixture({ disk: new Map([[uri, '{corrupt']]), failWrite: true });
  try {
    await wait(() => expect(f.app.selection.deviceId).toBe('pc-a'));
    await wait(() => expect(f.write).toHaveBeenCalled()); await f.flushed();
    f.setWriteFailure(false); f.app.selection.selectDevice('pc-b');
    await wait(() => expect(JSON.parse(f.disk.get(uri)!)[scope()].deviceId).toBe('pc-b'));
    expect(f.errors).toEqual([]);
  } finally { f.close(); }
});
