import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let script = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{ConversationKeyboard}from'./apps/mobile/src/conversation-keyboard.ios';
    function Draft(){const[text,setText]=useState('保留的草稿');window.edit=value=>flushSync(()=>setText(value));useEffect(()=>{window.mounts++;return()=>window.unmounts++},[]);return <textarea value={text} readOnly/>}
    const root=createRoot(document.getElementById('root'));
    window.emit=(name,event)=>flushSync(()=>{if(name==='keyboardDidShow')window.metrics=event.endCoordinates;if(name==='keyboardDidHide')window.metrics=undefined;for(const fn of window.events[name]??[])fn(event)});
    window.phase=next=>flushSync(()=>{window.appPhase=next;for(const fn of window.states)fn(next)});
    window.layout=()=>flushSync(()=>window.onLayout());
    window.flushFrames=()=>flushSync(()=>{const frames=[...window.frames.values()];window.frames.clear();for(const fn of frames)fn()});
    window.flushMeasures=()=>flushSync(()=>{const callbacks=window.measures.splice(0);for(const fn of callbacks)fn(...window.rect)});
    window.stop=()=>flushSync(()=>root.unmount());
    flushSync(()=>root.render(<ConversationKeyboard><Draft/></ConversationKeyboard>));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'ios-keyboard-ports', setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'native', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'jsx', resolveDir: process.cwd(), contents: `
        import React,{forwardRef,useImperativeHandle}from'react';
        export const AppState={get currentState(){return window.appPhase},addEventListener:(_,fn)=>{window.states.push(fn);return{remove(){window.states=window.states.filter(f=>f!==fn)}}}};
        export const Keyboard={metrics:()=>window.metrics,addListener:(name,fn)=>{(window.events[name]??=[]).push(fn);return{remove(){window.events[name]=window.events[name].filter(f=>f!==fn)}}}};
        export const View=forwardRef((props,ref)=>{window.onLayout=props.onLayout;window.padding=props.style.paddingBottom;useImperativeHandle(ref,()=>({measureInWindow:fn=>{if(window.deferMeasure)window.measures.push(fn);else fn(...window.rect)}}));return <div>{props.children}</div>});
      ` }));
    } }] }); script = result.outputFiles[0]!.text;
});

type Metrics = { screenX: number; screenY: number; width: number; height: number };
const docked: Metrics = { screenX: 0, screenY: 508, width: 390, height: 336 };
function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(w) {
    Object.assign(w, { appPhase: 'active', events: {}, states: [], frames: new Map(), frameId: 0, rect: [0, 59, 390, 751], measures: [], padding: 0, mounts: 0, unmounts: 0,
      requestAnimationFrame: (fn: () => void) => { const id = ++(w as any).frameId; (w as any).frames.set(id, fn); return id; }, cancelAnimationFrame: (id: number) => (w as any).frames.delete(id) });
  } });
  dom.window.eval(script);
  const app = dom.window as unknown as { padding: number; rect: number[]; metrics?: Metrics; deferMeasure?: boolean; mounts: number; unmounts: number; frames: Map<number, () => void>; measures: (() => void)[]; events: Record<string, unknown[]>; states: unknown[]; edit(value: string): void; emit(name: string, event: {endCoordinates: Metrics; isEventFromThisApp?: boolean}): void; phase(next: string): void; layout(): void; flushFrames(): void; flushMeasures(): void; stop(): void };
  const keyboard = (metrics: Metrics = docked, name = 'keyboardDidShow', local = true) => app.emit(name, {endCoordinates: metrics, isEventFromThisApp: local});
  app.flushFrames();
  return { dom, app, keyboard, close() { app.stop(); dom.window.close(); } };
}

it('recomputes the keyboard overlap after a background without remounting or clearing the draft', () => {
  const f = fixture();
  try {
    f.app.edit('第一行\n第二行，保留中文草稿');
    const input = f.dom.window.document.querySelector('textarea')!; input.setSelectionRange(3, 6);
    f.keyboard(); expect(f.app.padding).toBe(302);
    f.app.phase('inactive'); f.app.phase('background'); expect(f.app.padding).toBe(0);
    f.keyboard({ ...docked, screenY: 0, height: 844 }); // transient frame while another app owns the keyboard
    expect(f.app.padding).toBe(0);
    f.app.phase('active'); f.app.flushFrames(); expect(f.app.padding).toBe(0);
    f.keyboard(); expect(f.app.padding).toBe(302);
    expect(f.dom.window.document.querySelector('textarea')).toBe(input);
    expect(input.value).toBe('第一行\n第二行，保留中文草稿'); expect(input.selectionStart).toBe(3); expect(input.selectionEnd).toBe(6);
    expect(f.app.mounts).toBe(1); expect(f.app.unmounts).toBe(0);
  } finally { f.close(); }
  expect(Object.values(f.app.events).flat()).toEqual([]); expect(f.app.states).toEqual([]); expect(f.app.frames.size).toBe(0);
});

it('recovers from missing show events via current metrics and handles frame changes, hiding and rotation', () => {
  const f = fixture();
  try {
    f.keyboard(); f.app.phase('background'); f.app.metrics = { ...docked, screenY: 488, height: 356 };
    f.app.phase('active'); f.app.flushFrames(); expect(f.app.padding).toBe(322);
    f.keyboard({ ...docked, screenY: 548, height: 296 }, 'keyboardWillChangeFrame'); expect(f.app.padding).toBe(262);
    f.app.rect = [0, 0, 844, 369]; f.app.layout(); expect(f.app.padding).toBe(0);
    f.keyboard({ screenX: 0, screenY: 180, width: 844, height: 210 }, 'keyboardDidChangeFrame'); expect(f.app.padding).toBe(189);
    f.keyboard(docked, 'keyboardWillHide'); expect(f.app.padding).toBe(0);
  } finally { f.close(); }
});

it('ignores foreign, undocked, floating and invalid frames instead of collapsing the conversation', () => {
  const f = fixture();
  try {
    f.keyboard(docked, 'keyboardWillShow', false); expect(f.app.padding).toBe(0);
    for (const metrics of [{ ...docked, screenY: 0 }, { ...docked, screenY: NaN }, { ...docked, width: 0 }, { ...docked, height: 0 }, { ...docked, height: 100 }, { ...docked, screenX: 40, width: 250 }]) {
      f.keyboard(metrics); expect(f.app.padding).toBe(0);
    }
    f.keyboard(); expect(f.app.padding).toBe(302);
  } finally { f.close(); }
});

it('rejects late native measurements from before backgrounding or a newer keyboard event', () => {
  const f = fixture();
  try {
    f.app.deferMeasure = true; f.keyboard(); f.app.phase('background'); f.app.flushMeasures(); expect(f.app.padding).toBe(0);
    f.app.deferMeasure = false; f.app.phase('active'); f.app.flushFrames(); expect(f.app.padding).toBe(302);
    f.app.deferMeasure = true; f.keyboard(); f.app.deferMeasure = false;
    f.keyboard(docked, 'keyboardWillHide'); f.app.flushMeasures(); expect(f.app.padding).toBe(0);
  } finally { f.close(); }
});
