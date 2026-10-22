import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

let source = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {ServerResourcesPanel} from './apps/admin/src/server-resources';const root=createRoot(document.getElementById('root'));window.stopPanel=()=>root.unmount();window.expired=0;root.render(<ServerResourcesPanel onUnauthorized={()=>window.expired++}/>);`, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  source = result.outputFiles[0]!.text;
});
const sample = (cpuSampling = false) => ({ capturedAt: Date.now(), cpuSampling, sampleWindowSeconds: cpuSampling ? null : 30, host: { platform: 'linux', logicalCpus: 4, cpuPercent: cpuSampling ? null : 25, memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3, usedBytes: 2 * 1024 ** 3, usedPercent: 25 } }, process: { cpuPercent: cpuSampling ? null : 1, rssBytes: 64 * 1024 ** 2, heapBytes: 16 * 1024 ** 2, goroutines: 22, uptimeSeconds: 1000 }, disks: [{ mount: '/', label: '系统分区 / 数据目录分区', filesystem: 'ext4', totalBytes: 100 * 1024 ** 3, usedBytes: 30 * 1024 ** 3, availableBytes: 70 * 1024 ** 3, usedPercent: 30 }] });
async function fixture(respond: (call: number, init: RequestInit) => Response | Promise<Response>) {
  let calls = 0, visible = true, id = 100000;
  const signals: AbortSignal[] = [], timers = new Map<number, { ms: number; run: () => void }>(), errors: unknown[] = [];
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://admin.test', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    Object.assign(w, { AbortController, AbortSignal, fetch: async (_path: string, init: RequestInit) => { signals.push(init.signal!); return respond(++calls, init); } });
    Object.defineProperty(w.document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
    const original = w.setTimeout.bind(w), clear = w.clearTimeout.bind(w);
    w.setTimeout = ((run: () => void, ms: number) => { if ([2000, 30000, 60000].includes(ms)) { timers.set(++id, { ms, run }); return id; } return original(run, ms); }) as typeof w.setTimeout;
    w.clearTimeout = ((key: number) => { timers.delete(key); clear(key); }) as typeof w.clearTimeout;
    w.addEventListener('error', e => errors.push(e.error));
  } });
  dom.window.eval(source);
  const wait = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 10 });
  await wait(() => expect(calls).toBe(1));
  const text = () => dom.window.document.body.textContent!;
  const refresh = () => (dom.window.document.querySelector('[aria-label="刷新服务器状态"]') as HTMLButtonElement).click();
  const tick = (ms: number) => { const entry = [...timers].find(([, timer]) => timer.ms === ms); expect(entry, `no ${ms}ms timer`).toBeDefined(); timers.delete(entry![0]); entry![1].run(); };
  return { dom, text, wait, refresh, tick, timers, signals, errors, calls: () => calls, visibility(value: boolean) { visible = value; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); }, close() { (dom.window as any).stopPanel(); dom.window.close(); } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('warms up CPU without invented zeros, then refreshes every 30s and renders host/process/disk data', async () => {
  const f = await fixture(call => json(sample(call === 1)));
  try {
    await f.wait(() => expect(f.text()).toContain('CPU 正在首次采样'));
    expect(f.text()).toContain('64 MiB'); expect(f.text()).toContain('70 GiB');
    f.tick(2000); await f.wait(() => expect(f.text()).not.toContain('CPU 正在首次采样'));
    expect(f.text()).not.toContain('CPU 正在首次采样');
    expect(f.dom.window.document.querySelector('[aria-label="Codexer CPU 使用率"]')?.getAttribute('aria-valuenow')).toBe('1');
    f.tick(30000); await f.wait(() => expect(f.calls()).toBe(3));
    await f.wait(() => expect(f.timers.size).toBe(1));
    expect(f.errors).toEqual([]);
  } finally { f.close(); }
});
it('pauses while hidden, resumes immediately and cleans up timers on leaving the dashboard', async () => {
  const f = await fixture(() => json(sample()));
  try {
    await f.wait(() => expect(f.timers.size).toBe(1));
    f.visibility(false); expect(f.timers.size).toBe(0);
    f.refresh(); expect(f.calls()).toBe(1);
    f.visibility(true); await f.wait(() => expect(f.calls()).toBe(2));
    await f.wait(() => expect(f.timers.size).toBe(1));
    const select = f.dom.window.document.querySelector('select')!;
    select.value = '60'; select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    await f.wait(() => expect([...f.timers.values()].map(t => t.ms)).toEqual([60000]));
    f.tick(60000); await f.wait(() => expect(f.calls()).toBe(4));
    (f.dom.window as any).stopPanel(); expect(f.timers.size).toBe(0);
    f.visibility(false); f.visibility(true); expect(f.calls()).toBe(4);
  } finally { f.close(); }
});
it('keeps last good data with a stale warning and recovers on manual refresh', async () => {
  const f = await fixture(call => { if (call === 2) throw new TypeError('offline'); return json(sample()); });
  try {
    await f.wait(() => expect(f.text()).toContain('25.0%'));
    f.refresh(); await f.wait(() => expect(f.text()).toContain('显示的是上次采样'));
    expect(f.text()).toContain('64 MiB');
    f.refresh(); await f.wait(() => expect(f.text()).not.toContain('显示的是上次采样'));
    expect(f.calls()).toBe(3);
  } finally { f.close(); }
});
it('does not overlap requests, aborts on unmount and forwards expired admin sessions', async () => {
  let finish!: (value: Response) => void;
  const f = await fixture(() => new Promise<Response>(done => { finish = done; }));
  try {
    f.refresh(); f.refresh(); expect(f.calls()).toBe(1);
    (f.dom.window as any).stopPanel(); expect(f.signals[0]?.aborted).toBe(true);
    finish(json(sample())); await new Promise(done => setTimeout(done, 10));
    expect(f.timers.size).toBe(0);
  } finally { f.close(); }
  const expired = await fixture(() => json({ error: 'unauthorized' }, 401));
  try { await expired.wait(() => expect((expired.dom.window as any).expired).toBe(1)); } finally { expired.close(); }
});
it('resumes immediately when a hidden in-flight request finishes after the tab becomes visible', async () => {
  let finish!: (value: Response) => void;
  const f = await fixture(call => call === 1 ? new Promise<Response>(done => { finish = done; }) : json(sample()));
  try {
    f.visibility(false); expect(f.signals[0]?.aborted).toBe(true);
    f.visibility(true); finish(json(sample()));
    await f.wait(() => expect(f.calls()).toBe(2));
    await f.wait(() => expect(f.text()).toContain('25.0%'));
  } finally { f.close(); }
});
