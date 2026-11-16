import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let script = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{Disclosure}from'./apps/mobile/src/interaction/disclosure';
    const root=createRoot(document.getElementById('root'));
    window.render=open=>flushSync(()=>root.render(<Disclosure open={open}><p>需要保留的处理详情</p></Disclosure>));
    window.layout=height=>flushSync(()=>window.measure?.({nativeEvent:{layout:{height}}}));
    window.tick=milliseconds=>flushSync(()=>{window.now+=milliseconds;for(const animation of [...window.animations])animation.tick()});
    window.stop=()=>flushSync(()=>root.unmount());
    window.render(true);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'native-animation-clock', setup(builder) {
      builder.onResolve({ filter: /^(react-native|\.\/motion)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path === './motion' ? 'export const useInteractionMotion=()=>window.motion;' : `
        import React from'react';
        export const View=props=>{if(props.onLayout)window.measure=props.onLayout;return <div>{props.children}</div>};
        const AnimatedView=props=>{window.viewport=props.style;return <div data-open={props.pointerEvents}>{props.children}</div>};
        export const Easing={cubic:value=>value,inOut:easing=>easing};
        export const Animated={View:AnimatedView,Value:class{constructor(value){this.value=value}setValue(value){this.value=value}},timing:(value,options)=>{
          const animation={start(callback){window.starts++;animation.from=value.value;animation.at=window.now;animation.callback=callback;window.animations.add(animation);if(!options.duration)animation.tick()},
            stop(){if(window.animations.delete(animation))animation.callback?.({finished:false})},
            tick(){const progress=Math.min(1,(window.now-animation.at)/Math.max(1,options.duration));value.value=animation.from+(options.toValue-animation.from)*progress;if(progress===1||!options.duration){value.value=options.toValue;window.animations.delete(animation);animation.callback?.({finished:true})}}};return animation;
        }};
      ` }));
    } }] }); script = result.outputFiles[0]!.text;
});

function fixture(motion = true) {
  const errors: unknown[] = [];
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(w) {
    Object.assign(w, { now: 0, starts: 0, motion, animations: new Set() });
    w.addEventListener('error', event => errors.push(event.error));
  } });
  dom.window.eval(script);
  const app = dom.window as unknown as { starts: number; viewport: { height?: { value: number }; maxHeight?: { value: number } }; render(open: boolean): void; layout(height: number): void; tick(milliseconds: number): void; stop(): void };
  const height = () => app.viewport.height?.value ?? app.viewport.maxHeight?.value ?? 0;
  return { app, height, text: () => dom.window.document.body.textContent, close() { app.stop(); dom.window.close(); expect(errors).toEqual([]); } };
}

it('finishes closing within one animation despite repeated constrained native layout notifications', () => {
  const f = fixture();
  try {
    f.app.layout(600); f.app.tick(300);
    f.app.render(false); const starts = f.app.starts;
    for (let frame = 0; frame < 20 && f.text(); frame++) {
      f.app.tick(16);
      // Native layout can report the progressively clipped content height.
      // Feeding that back into a closing animation must not restart it.
      if (f.text()) f.app.layout(Math.ceil(f.height()));
    }
    expect(f.text()).toBe('');
    expect(f.app.starts).toBe(starts);
  } finally { f.close(); }
});

it('reopens an interrupted close and measures later content growth while expanded', () => {
  const f = fixture();
  try {
    f.app.layout(600); f.app.tick(300);
    f.app.render(false); f.app.tick(80); f.app.layout(Math.ceil(f.height()));
    f.app.render(true); f.app.tick(300);
    expect(f.text()).toBe('需要保留的处理详情'); expect(f.height()).toBe(600);
    f.app.layout(820); f.app.tick(300); expect(f.height()).toBe(820);
    f.app.render(false); f.app.tick(300); expect(f.text()).toBe('');
  } finally { f.close(); }
});

it('measures newly mounted content and closes without an animation delay with reduced motion', async () => {
  const f = fixture(false);
  try {
    f.app.layout(600); expect(f.height()).toBe(600);
    f.app.render(false); await vi.waitFor(() => expect(f.text()).toBe(''));
    f.app.render(true); await vi.waitFor(() => expect(f.text()).toBe('需要保留的处理详情')); f.app.layout(720);
    expect(f.text()).toBe('需要保留的处理详情'); expect(f.height()).toBe(720);
    f.app.render(false); await vi.waitFor(() => expect(f.text()).toBe(''));
  } finally { f.close(); }
});
