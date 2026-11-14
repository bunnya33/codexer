import { beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const scripts: Record<string, string> = {};
const uri = 'file:///app/screen-awake-v1.json';
const wait = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 10 });
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }

beforeAll(async () => {
  for (const platform of ['ios', 'android']) {
    const result = await build({
      stdin: { contents: `
        import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
        import {ScreenAwakeProvider,ScreenAwakeSettings} from './apps/mobile/src/screen-awake';
        const root=createRoot(document.getElementById('root'));window.stop=()=>flushSync(()=>root.unmount());
        flushSync(()=>root.render(<ScreenAwakeProvider><ScreenAwakeSettings/></ScreenAwakeProvider>));
      `, resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
      resolveExtensions: [`.${platform}.tsx`, '.tsx', '.ts', '.js', '.json'],
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'native-screen-fixture', setup(builder) {
        builder.onResolve({ filter: /^(react-native|expo-keep-awake|expo-file-system\/legacy|lucide-react-native|@react-native-community\/slider|\.\/styles)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: {
          'react-native': `import React from 'react';
            export const AppState={currentState:window.phase,addEventListener:(_,listener)=>{window.changePhase=listener;return{remove(){window.changePhase=()=>{}}}}};
            export const StyleSheet={hairlineWidth:1};
            export const View=({children,accessibilityRole})=><div role={accessibilityRole}>{children}</div>;
            export const Text=({children,accessibilityRole,accessibilityLabel})=><span role={accessibilityRole} aria-label={accessibilityLabel}>{children}</span>;
            export const Pressable=({children,onPress,disabled,accessibilityLabel,accessibilityRole,accessibilityState})=><button disabled={disabled} onClick={onPress} role={accessibilityRole} aria-label={accessibilityLabel} aria-checked={accessibilityState?.checked}>{children}</button>;
            export const Switch=({value,onValueChange,accessibilityLabel})=><input type="checkbox" role="switch" aria-label={accessibilityLabel} checked={value} onChange={e=>onValueChange(e.target.checked)}/>;`,
          'expo-keep-awake': 'export const activateKeepAwakeAsync=()=>window.activate();export const deactivateKeepAwake=()=>window.deactivate();',
          'expo-file-system/legacy': 'export const documentDirectory="file:///app/";export const readAsStringAsync=(...a)=>window.read(...a);export const writeAsStringAsync=(...a)=>window.write(...a);',
          'lucide-react-native': 'export const Check=()=>null;export const Minus=()=>null;export const Plus=()=>null;',
          '@react-native-community/slider': `import React from 'react';export default function Slider(p){return <input type="range" aria-label={p.accessibilityLabel} min={p.minimumValue} max={p.maximumValue} step={p.step} value={p.value} onChange={e=>{p.onValueChange(+e.target.value);p.onSlidingComplete(+e.target.value)}}/>;}`,
          './styles': 'export const useTheme=()=>({c:{surface:"white",text:"black",accent:"blue",muted:"gray",settingsLine:"gray",danger:"red"}});',
        }[args.path]! }));
      } }],
    });
    scripts[platform] = result.outputFiles[0]!.text;
  }
});

async function fixture(platform: string, options: { saved?: string; disk?: Map<string, string>; readGate?: Promise<void>; activationGate?: Promise<void>; writeGate?: Promise<void>; failWrite?: boolean; failActivation?: boolean } = {}) {
  const disk = options.disk ?? new Map<string, string>();
  if (options.saved) disk.set(uri, options.saved);
  let awake = false, calls = 0, now = 0, timerId = 1_000_000;
  const timers = new Map<number, { at: number; run: () => void }>(), nativeCalls: string[] = [];
  const read = vi.fn(async () => { const value = disk.get(uri); await options.readGate; if (value === undefined) throw Error('missing'); return value; });
  const write = vi.fn(async (key: string, value: string) => { if (++calls === 1) await options.writeGate; if (options.failWrite) throw Error('disk'); disk.set(key, value); });
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(window) {
    const realSet = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
    window.setTimeout = ((run: () => void, delay: number) => { if (delay >= 60_000) { const id = ++timerId; timers.set(id, { at: now + delay, run }); return id; } return realSet(run, delay); }) as typeof window.setTimeout;
    window.clearTimeout = (id?: number) => { if (id !== undefined && timers.delete(id)) return; realClear(id); };
    Object.assign(window, { phase: 'active', read, write,
      activate: async () => { nativeCalls.push('activate'); await options.activationGate; if (options.failActivation) throw Error('native'); awake = true; },
      deactivate: async () => { nativeCalls.push('deactivate'); awake = false; },
    });
  } });
  dom.window.eval(scripts[platform]!);
  const app = dom.window as unknown as { changePhase(value: string): void; stop(): void };
  const switchInput = () => dom.window.document.querySelector<HTMLInputElement>('[role="switch"]')!;
  await wait(() => expect(switchInput()).not.toBeNull());
  const click = async (label: string) => {
    const target = [...dom.window.document.querySelectorAll<HTMLElement>('button,input')].find(el => el.getAttribute('aria-label') === label || el.textContent === label);
    expect(target, label).toBeDefined(); target!.click();
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  return { dom, disk, read, write, nativeCalls, awake: () => awake, timers, click, switchInput,
    async phase(value: string) { app.changePhase(value); await new Promise(resolve => setTimeout(resolve, 10)); },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) { const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].run(); }
      now = until; await new Promise(resolve => setTimeout(resolve, 10));
    },
    async close() { app.stop(); await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); },
  };
}

describe.each(['ios', 'android'])('%s screen wake preference', platform => {
  it('defaults to always awake, releases in background and on unmount, and restores on return', async () => {
    const f = await fixture(platform);
    try {
      await wait(() => expect(f.awake()).toBe(true)); expect(f.timers.size).toBe(0);
      await f.phase('background'); await wait(() => expect(f.awake()).toBe(false));
      await f.phase('active'); await wait(() => expect(f.awake()).toBe(true));
    } finally { await f.close(); }
    expect(f.awake()).toBe(false);
  });

  it('waits for saved preferences and remembers disabling across a restart', async () => {
    const read = gate(), disk = new Map([[uri, '{"enabled":false,"minutes":null}']]);
    const f = await fixture(platform, { disk, readGate: read.promise });
    try {
      expect(f.awake()).toBe(false); expect(f.nativeCalls).not.toContain('activate');
      read.release(); await wait(() => expect(f.switchInput().checked).toBe(false));
      await f.phase('background'); await f.phase('active'); expect(f.awake()).toBe(false);
      await f.click('屏幕常亮'); await wait(() => expect(f.awake()).toBe(true));
      await f.click('屏幕常亮'); await wait(() => expect(JSON.parse(disk.get(uri)!).enabled).toBe(false));
    } finally { read.release(); await f.close(); }
    const again = await fixture(platform, { disk });
    try { await wait(() => expect(again.switchInput().checked).toBe(false)); expect(again.nativeCalls).not.toContain('activate'); }
    finally { await again.close(); }
  });

  it.each([1, 30])('releases exactly at the %i-minute deadline and can restart explicitly', async minutes => {
    const f = await fixture(platform, { saved: JSON.stringify({ enabled: true, minutes }) });
    try {
      await wait(() => expect(f.awake()).toBe(true));
      await f.advance(minutes * 60_000 - 1); expect(f.awake()).toBe(true);
      await f.advance(1); await wait(() => expect(f.awake()).toBe(false));
      expect(f.dom.window.document.body.textContent).toContain('本次常亮已结束');
      await f.click('重新计时'); await wait(() => expect(f.awake()).toBe(true));
      await f.advance(minutes * 60_000); await wait(() => expect(f.awake()).toBe(false));
    } finally { await f.close(); }
  });

  it('starts a fresh timer after foregrounding and cancels the previous timer', async () => {
    const f = await fixture(platform, { saved: '{"enabled":true,"minutes":1}' });
    try {
      await wait(() => expect(f.awake()).toBe(true)); await f.advance(30_000);
      await f.phase('inactive'); expect(f.awake()).toBe(false); expect(f.timers.size).toBe(0);
      await f.advance(90_000); await f.phase('active'); await wait(() => expect(f.awake()).toBe(true));
      await f.advance(59_999); expect(f.awake()).toBe(true);
      await f.advance(1); await wait(() => expect(f.awake()).toBe(false));
    } finally { await f.close(); }
  });

  it('keeps a delayed native activation from leaving the screen awake after disabling', async () => {
    const activation = gate(), f = await fixture(platform, { activationGate: activation.promise });
    try {
      await wait(() => expect(f.nativeCalls).toContain('activate'));
      await f.click('屏幕常亮'); activation.release();
      await wait(() => expect(f.nativeCalls.at(-1)).toBe('deactivate')); expect(f.awake()).toBe(false);
    } finally { activation.release(); await f.close(); }
  });

  it('preserves a new user choice over a late disk read and serializes setting writes', async () => {
    const read = gate(), write = gate(), f = await fixture(platform, { saved: '{"enabled":true,"minutes":30}', readGate: read.promise, writeGate: write.promise });
    try {
      await f.click('屏幕常亮'); read.release();
      await wait(() => expect(f.switchInput().checked).toBe(false));
      await f.click('屏幕常亮'); await f.click('定时常亮'); await f.click('减少常亮时间');
      write.release(); await wait(() => expect(JSON.parse(f.disk.get(uri)!)).toEqual({ enabled: true, minutes: 9 }));
      expect(f.awake()).toBe(true); expect(f.timers.size).toBe(1);
    } finally { read.release(); write.release(); await f.close(); }
  });

  it('allows each minute while keeping adjustments within 1–30', async () => {
    const f = await fixture(platform, { saved: '{"enabled":true,"minutes":30}' });
    try {
      await wait(() => expect(f.awake()).toBe(true));
      await f.click('增加常亮时间'); expect(JSON.parse(f.disk.get(uri)!).minutes).toBe(30);
      await f.click('减少常亮时间'); await wait(() => expect(JSON.parse(f.disk.get(uri)!).minutes).toBe(29));
      const range = f.dom.window.document.querySelector<HTMLInputElement>('input[type="range"]')!;
      expect([range.min, range.max, range.step]).toEqual(['1', '30', '1']);
    } finally { await f.close(); }
  });

  it('shows save and native failures instead of claiming the setting succeeded', async () => {
    const f = await fixture(platform, { failWrite: true, failActivation: true });
    try {
      await wait(() => expect(f.dom.window.document.body.textContent).toContain('无法保持屏幕常亮'));
      await f.click('屏幕常亮'); await wait(() => expect(f.dom.window.document.body.textContent).toContain('未能保存'));
      expect(f.awake()).toBe(false);
    } finally { await f.close(); }
  });

  it.each(['invalid-json', '{"enabled":"invalid","minutes":999}'])('recovers from invalid saved settings: %s', async saved => {
    const f = await fixture(platform, { saved });
    try { await wait(() => expect(f.awake()).toBe(true)); expect(f.switchInput().checked).toBe(true); }
    finally { await f.close(); }
  });
});
