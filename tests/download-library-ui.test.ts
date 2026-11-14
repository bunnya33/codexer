import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let script = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{DownloadLibraryButton,DownloadLifecycle}from'./apps/mobile/src/download-library-mobile';
    window.items=[{id:'apk',name:'FrogCoder.apk',size:100,received:100,transferred:100,state:'completed',createdAt:1,error:''},{id:'pdf',name:'report.pdf',size:100,received:50,transferred:50,state:'paused',createdAt:2,error:'',remote:{}}];
    let snapshot={ready:true,items:window.items,error:''};const listeners=new Set();
    const emit=()=>{snapshot={...snapshot,items:[...window.items]};for(const f of listeners)f()};
    window.manager={initialize:async()=>{},getSnapshot:()=>snapshot,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},
      start:async id=>{window.calls.push('start:'+id);window.items=window.items.map(i=>i.id===id?{...i,state:'downloading'}:i);emit()},
      pause:async id=>{window.calls.push('pause:'+id);window.items=window.items.map(i=>i.id===id?{...i,state:'paused'}:i);emit()},
      remove:async id=>{window.calls.push('remove:'+id);window.items=window.items.filter(i=>i.id!==id);emit()},pauseAll:async()=>window.calls.push('pauseAll')};
    const root=createRoot(document.getElementById('root'));window.stop=()=>flushSync(()=>root.unmount());
    flushSync(()=>root.render(<><DownloadLifecycle/><DownloadLibraryButton compact/></>));
    window.search=value=>flushSync(()=>window.searchChange(value));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'download-ui-fixture', setup(builder) {
      builder.onResolve({ filter: /^(react-native|lucide-react-native|\.\/downloads-mobile|\.\/relay|\.\/runtime|\.\/styles|\.\/review-reader)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: {
        'react-native': `import React from 'react';export const Platform={get OS(){return window.platform}};
          export const AppState={addEventListener:(_,fn)=>{window.phase=fn;return{remove(){}}}};
          export const View=({children,testID})=><div data-testid={testID}>{children}</div>;export const ScrollView=View;
          export const Text=({children,accessibilityRole})=><span role={accessibilityRole}>{children}</span>;export const ActivityIndicator=()=>null;
          export const TextInput=p=>{window.searchChange=p.onChangeText;return <input aria-label={p.accessibilityLabel} value={p.value} readOnly/>};
          export const Pressable=({children,onPress,disabled,accessibilityLabel,accessibilityRole,accessibilityState})=><button role={accessibilityRole} aria-label={accessibilityLabel} aria-selected={accessibilityState?.selected} disabled={disabled} onClick={onPress}>{children}</button>;`,
        'lucide-react-native': 'export const Download=()=>null;',
        './downloads-mobile': 'export const mobileDownloads={initialize:(...a)=>window.manager.initialize(...a),getSnapshot:()=>window.manager.getSnapshot(),subscribe:f=>window.manager.subscribe(f),start:id=>window.manager.start(id),pause:id=>window.manager.pause(id),remove:id=>window.manager.remove(id),pauseAll:()=>window.manager.pauseAll()};const listeners=new Set();let unread=true;export const downloadCompletionNotice={initialize:async()=>{},getSnapshot:()=>unread,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},markRead:async()=>{unread=false;for(const f of listeners)f()}};export const openDownload=async item=>{window.calls.push("open:"+item.id);return window.installResult};export const shareDownload=async item=>window.calls.push("share:"+item.id);',
        './relay': 'export const relay={getSnapshot:()=>window.connection,subscribe:fn=>{window.connectionChanged=fn;return()=>{}}};',
        './runtime': 'export const confirmAction=async()=>window.confirmed;',
        './styles': 'export const useTheme=()=>({c:{},s:{iconButton:{}}});',
        './review-reader': 'import React from "react";export const ReviewReader=({open,children,title,onClose})=>open?<section aria-label={title}><button onClick={onClose}>关闭列表</button>{children}</section>:null;',
      }[args.path]! }));
    } }] }); script = result.outputFiles[0]!.text;
});
async function fixture(platform: string) {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(w) { Object.assign(w, { platform, calls: [], connection: { phase: 'locked', url: '', userId: null }, confirmed: false, installResult: 'permission-required' }); } });
  dom.window.eval(script);
  const app = dom.window as unknown as { calls: string[]; search(text: string): void; confirmed: boolean; stop(): void; phase(phase: string): void; connectionChanged(): void; connection: { phase: string; url: string; userId: string | null }; installResult: string };
  const click = async (label: string) => { const el = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.getAttribute('aria-label') === label || el.textContent === label); expect(el,label).toBeDefined(); el!.click(); await new Promise(done => setTimeout(done,10)); };
  expect(dom.window.document.querySelector('[data-testid="download-unread-dot"]')).not.toBeNull();
  await click('下载列表');
  expect(dom.window.document.querySelector('[data-testid="download-unread-dot"]')).toBeNull();
  return { dom, app, click, close() { app.stop(); dom.window.close(); } };
}

it.each(['ios','android'])('manages completed and paused local files from the %s list while signed out', async platform => {
  const f = await fixture(platform);
  try {
    expect(f.dom.window.document.body.textContent).toContain('FrogCoder.apk'); expect(f.dom.window.document.body.textContent).toContain('report.pdf');
    await f.click((platform==='android'?'安装':'打开')+' FrogCoder.apk'); expect(f.app.calls).toContain('open:apk');
    expect(f.dom.window.document.body.textContent).toContain('文件已保留');
    await f.click('分享／保存副本 FrogCoder.apk'); expect(f.app.calls).toContain('share:apk');
    f.app.search('report'); expect(f.dom.window.document.querySelector('[data-testid="download-apk"]')).toBeNull();
    await f.click('继续 report.pdf'); expect(f.app.calls).toContain('start:pdf');
    await f.click('暂停 report.pdf'); expect(f.app.calls).toContain('pause:pdf');
    await f.click('删除 report.pdf'); expect(f.app.calls).not.toContain('remove:pdf');
    f.app.confirmed=true; await f.click('删除 report.pdf'); expect(f.app.calls).toContain('remove:pdf');
    expect(f.dom.window.document.querySelector('[data-testid="download-pdf"]')).toBeNull();
  } finally { f.close(); }
});

it('pauses in-flight work when the app backgrounds or the signed-in account changes', async () => {
  const f = await fixture('android');
  try {
    f.app.phase('background'); await Promise.resolve(); expect(f.app.calls).toContain('pauseAll'); f.app.calls.length=0;
    f.app.connection={phase:'connected',url:'https://relay.test',userId:'another'};f.app.connectionChanged(); await Promise.resolve(); expect(f.app.calls).toContain('pauseAll');
  } finally { f.close(); }
});
