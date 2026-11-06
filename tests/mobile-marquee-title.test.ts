import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

let javascript = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `import{useState}from'react';import{createRoot}from'react-dom/client';import{MarqueeTitle}from'./apps/mobile/src/marquee-title';
    function App(){const[text,setText]=useState('长标题');window.changeTitle=setText;return <MarqueeTitle text={text}/>;}
    const root=createRoot(document.getElementById('root'));window.closeTitle=()=>root.unmount();root.render(<App/>);`, resolveDir: resolve('.'), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { 'react-native': 'react-native-web' },
    nodePaths: [resolve('apps/mobile/node_modules')], resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    plugins: [{ name: 'animation-host', setup(build) {
      build.onResolve({ filter: /^react-native$/ }, () => ({ path: 'native', namespace: 'animation-host' }));
      build.onLoad({ filter: /.*/, namespace: 'animation-host' }, () => ({ loader: 'tsx', resolveDir: resolve('.'), contents: `
        import * as RN from 'react-native-web'; export * from 'react-native-web';
        export function View(props){if(props.testID==='conversation-title')window.measureViewport=width=>props.onLayout({nativeEvent:{layout:{width}}});return <RN.View {...props} onLayout={undefined}/>;}
        export function ScrollView(props){window.measureText=props.onContentSizeChange;return <RN.ScrollView {...props} onContentSizeChange={undefined}/>;}
        export const AppState={currentState:'active',addEventListener:(_,listener)=>{window.changeAppState=listener;return{remove(){}};}};
        export const AccessibilityInfo={isReduceMotionEnabled:async()=>false,addEventListener:(_,listener)=>{window.changeMotion=listener;return{remove(){}};}};
        export const Animated={...RN.Animated,delay:duration=>({kind:'pause',duration}),timing:(_,config)=>({kind:'move',...config}),sequence:steps=>({steps}),loop:sequence=>({start(){window.animations.push(sequence.steps);},stop(){window.stopped++;}})};
      ` }));
    } }], define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' }, loader: { '.css': 'empty' } });
  javascript = result.outputFiles[0]!.text;
});

type AnimationStep = { kind: string; duration: number; toValue?: number };
type Host = { animations: AnimationStep[][]; stopped: number; measureViewport(width: number): void; measureText(width: number): void; changeTitle(text: string): void; changeMotion(reduced: boolean): void; changeAppState(state: string): void; closeTitle(): void };
async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://fixture.test', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    Object.assign(window, { animations: [], stopped: 0, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  } });
  dom.window.eval(javascript);
  const host = dom.window as unknown as Host;
  await vi.waitFor(() => expect(host.measureText).toBeTypeOf('function'));
  return { dom, host, measure(viewport: number, content: number) { host.measureViewport(viewport); host.measureText(content); }, close() { host.closeTitle(); dom.window.close(); } };
}

it('continues one character beyond the right edge, pauses one second there and two seconds at the start', async () => {
  const f = await fixture();
  try {
    f.measure(200, 500);
    await vi.waitFor(() => expect(f.host.animations.length).toBe(1));
    expect(f.host.animations[0]).toMatchObject([
      { kind: 'pause', duration: 2000 }, { kind: 'move', toValue: -315 },
      { kind: 'pause', duration: 1000 }, { kind: 'move', toValue: 0, duration: 0 },
    ]);
    const title = f.dom.window.document.querySelector('[data-testid="conversation-title"]')!;
    expect(title.querySelector('[data-testid="title-fade-left"] linearGradient')).not.toBeNull();
    expect(title.querySelector('[data-testid="title-fade-right"] linearGradient')).not.toBeNull();
  } finally { f.close(); }
});

it('does not animate titles that fit, removes edge fades after resizing, and resets after a title change', async () => {
  const f = await fixture();
  try {
    f.measure(200, 190);
    await new Promise(done => setTimeout(done, 30));
    expect(f.host.animations).toEqual([]);
    expect(f.dom.window.document.querySelector('[data-testid="title-fade-right"]')).toBeNull();
    f.measure(200, 500);
    await vi.waitFor(() => expect(f.host.animations.length).toBe(1));
    f.host.measureViewport(600);
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('[data-testid="title-fade-right"]')).toBeNull());
    expect(f.host.stopped).toBeGreaterThan(0);
    f.host.changeTitle('短标题');
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('[data-testid="conversation-title-text"]')?.textContent).toBe('短标题'));
    expect(f.host.animations.length).toBe(1);
  } finally { f.close(); }
});

it('stops motion for the background and reduced-motion preference, restarting with the initial pause', async () => {
  const f = await fixture();
  try {
    f.measure(200, 500);
    await vi.waitFor(() => expect(f.host.animations.length).toBe(1));
    f.host.changeAppState('background');
    await vi.waitFor(() => expect(f.host.stopped).toBe(1));
    f.host.changeAppState('active');
    await vi.waitFor(() => expect(f.host.animations.length).toBe(2));
    expect(f.host.animations[1]?.[0]).toEqual({ kind: 'pause', duration: 2000 });
    f.host.changeMotion(true);
    await vi.waitFor(() => expect(f.host.stopped).toBe(2));
    expect(f.host.animations.length).toBe(2);
  } finally { f.close(); }
});
