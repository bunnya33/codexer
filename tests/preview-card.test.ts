import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

let javascript = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {PreviewCard} from './apps/mobile/src/preview-card';
    const root=createRoot(document.getElementById('root'));
    window.mount=()=>flushSync(()=>root.render(<>{Array.from({length:25},(_,i)=><PreviewCard key={i} deviceId="pc" threadId="thread" reference={{kind:'server',source:'http://localhost:5173/'+i,title:'Page '+i}}/>)}</>));
    window.unmount=()=>flushSync(()=>root.unmount()); window.mount();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, outdir: '.local/preview-card-test', platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx','.web.ts','.web.js','.tsx','.ts','.jsx','.js','.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: {'react-native':'react-native-web'},
    define: {'process.env.NODE_ENV':'"production"', __DEV__:'false', global:'globalThis', 'process.env':'{}'}, plugins: [{ name: 'preview-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/relay$/ }, () => ({path:'relay',namespace:'fixture'}));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({contents:'export const relay=window.fixtureRelay;'}));
    } }],
  });
  javascript = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
});

function fixture(delayed = false) {
  const opened: {source:string;channel:string;signal:AbortSignal;uri:string}[] = [], closed:string[] = [], errors:unknown[] = [];
  let complete: (()=>void) | undefined;
  const dom = new JSDOM('<div id="root"></div>', {url:'http://preview.test',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(window) {
    window.matchMedia = (()=>({matches:false,addListener(){},removeListener(){}})) as any;
    window.addEventListener('error',event=>errors.push(event.error));
    Object.assign(window,{fixtureRelay:{
      previewStateKey: (_device:string,_thread:string,source:string)=>source,
      openPreview: (_device:string,_thread:string,source:string,channel:string,_state:unknown,signal:AbortSignal)=>{
        const uri='http://preview.test/v1/previews/'+String(opened.length).padStart(64,'0')+'/';opened.push({source,channel,signal,uri});
        return delayed?new Promise<string>(resolve=>{complete=()=>resolve(uri);}):Promise.resolve(uri);
      }, closePreview: async (source:string)=>{closed.push(source);}, renewPreview: async()=>{},
    }});
  }});
  dom.window.eval(javascript);
  const click = (label:string) => {
    const button=dom.window.document.querySelector(`[role="button"][aria-label="${label}"]`);
    if(!button)throw new Error('Missing button: '+label);
    button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
  };
  return {dom,opened,closed,errors,click,complete:()=>complete!(),unmount:()=>{(dom.window as any).unmount();}};
}

it('mounts 25 cards without running pages, keeps one active frame, bounds height and releases on close',async()=>{
  const app=fixture();try{
    expect(app.opened).toEqual([]);expect(app.dom.window.document.querySelectorAll('iframe')).toHaveLength(0);
    app.click('打开预览 Page 0');await vi.waitFor(()=>expect(app.dom.window.document.querySelectorAll('iframe')).toHaveLength(1));
    const frame=app.dom.window.document.querySelector('iframe')!;
    app.dom.window.dispatchEvent(new app.dom.window.MessageEvent('message',{source:frame.contentWindow as unknown as Window,data:{channel:app.opened[0]!.channel,type:'height',height:2400}}));
    await vi.waitFor(()=>expect(frame.style.height).toBe('480px'));
    app.click('打开预览 Page 1');await vi.waitFor(()=>expect(app.closed).toContain(app.opened[0]!.uri));
    expect(app.opened).toHaveLength(2);expect(app.dom.window.document.querySelectorAll('iframe')).toHaveLength(1);
    app.click('关闭预览');await vi.waitFor(()=>expect(app.closed).toContain(app.opened[1]!.uri));
    expect(app.dom.window.document.querySelectorAll('iframe')).toHaveLength(0);expect(app.errors).toEqual([]);
  }finally{app.unmount();app.dom.window.close();}
});

it('aborts a pending open when unmounted and releases a late capability',async()=>{
  const app=fixture(true);try{
    app.click('打开预览 Page 0');await vi.waitFor(()=>expect(app.opened).toHaveLength(1));
    app.unmount();expect(app.opened[0]!.signal.aborted).toBe(true);app.complete();
    await vi.waitFor(()=>expect(app.closed).toEqual([app.opened[0]!.uri]));expect(app.errors).toEqual([]);
  }finally{app.dom.window.close();}
});
