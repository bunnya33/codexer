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
    window.emit=emit;window.manager={initialize:async()=>{},getSnapshot:()=>snapshot,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},
      start:async id=>{window.calls.push('start:'+id);window.items=window.items.map(i=>i.id===id?{...i,state:'downloading'}:i);emit()},
      pause:async id=>{window.calls.push('pause:'+id);window.items=window.items.map(i=>i.id===id?{...i,state:'paused'}:i);emit()},
      remove:async id=>{window.calls.push('remove:'+id);await window.removeGate?.();if(window.failRemove===id)throw Error('delete-failed');window.items=window.items.filter(i=>i.id!==id);emit()},pauseAll:async()=>window.calls.push('pauseAll')};
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
          export const Pressable=({children,onPress,disabled,accessibilityLabel,accessibilityRole,accessibilityState})=><button role={accessibilityRole} aria-label={accessibilityLabel} aria-selected={accessibilityState?.selected} aria-checked={accessibilityState?.checked} disabled={disabled} onClick={onPress}>{children}</button>;`,
        'lucide-react-native': 'export const Download=()=>null;export const Check=()=>null;',
        './downloads-mobile': 'export const mobileDownloads={initialize:(...a)=>window.manager.initialize(...a),getSnapshot:()=>window.manager.getSnapshot(),subscribe:f=>window.manager.subscribe(f),start:id=>window.manager.start(id),pause:id=>window.manager.pause(id),remove:id=>window.manager.remove(id),pauseAll:()=>window.manager.pauseAll()};const listeners=new Set();let unread=true;export const downloadCompletionNotice={initialize:async()=>{},getSnapshot:()=>unread,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},markRead:async()=>{unread=false;for(const f of listeners)f()}};export const openDownload=async item=>{window.calls.push("open:"+item.id);return window.installResult};export const shareDownload=async item=>window.calls.push("share:"+item.id);',
        './relay': 'export const relay={getSnapshot:()=>window.connection,subscribe:fn=>{window.connectionChanged=fn;return()=>{}}};',
        './runtime': 'export const confirmAction=async(title,message)=>{window.confirmations.push({title,message});return window.confirmed};',
        './styles': 'export const useTheme=()=>({c:{},s:{iconButton:{}}});',
        './review-reader': 'import React from "react";export const ReviewReader=({open,children,title,onClose})=>open?<section aria-label={title}><button onClick={onClose}>关闭列表</button>{children}</section>:null;',
      }[args.path]! }));
    } }] }); script = result.outputFiles[0]!.text;
});
async function fixture(platform: string) {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(w) { Object.assign(w, { platform, calls: [], confirmations: [], connection: { phase: 'locked', url: '', userId: null }, confirmed: false, installResult: 'permission-required' }); } });
  dom.window.eval(script);
  const app = dom.window as unknown as { calls: string[]; search(text: string): void; confirmed: boolean; stop(): void; phase(phase: string): void; connectionChanged(): void; connection: { phase: string; url: string; userId: string | null }; installResult: string; confirmations: {title:string;message:string}[]; failRemove?: string; removeGate?: () => Promise<void>; emit(): void; items: {id:string;name:string;state:string;size:number;received:number;transferred:number;createdAt:number;error:string}[] };
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

it.each(['ios', 'android'])('selects multiple %s downloads and deletes all only after one confirmation', async platform => {
  const f = await fixture(platform);
  try {
    await f.click('编辑下载列表');
    expect(f.dom.window.document.querySelector('[aria-label="删除选中的 0 个文件"]')?.hasAttribute('disabled')).toBe(true);
    expect(f.dom.window.document.querySelector('[aria-label="删除 report.pdf"]')).toBeNull();
    await f.click('选择 FrogCoder.apk');
    expect(f.dom.window.document.querySelector('[aria-label="选择 FrogCoder.apk"]')?.getAttribute('aria-checked')).toBe('true');
    await f.click('选择 report.pdf');
    await f.click('取消全选当前列表');
    expect(f.dom.window.document.body.textContent).toContain('已选 0 个文件');
    await f.click('全选当前列表');
    await f.click('删除选中的 2 个文件');
    expect(f.app.calls.filter(call => call.startsWith('remove:'))).toEqual([]);
    expect(f.dom.window.document.body.textContent).toContain('已选 2 个文件');
    f.app.confirmed = true;
    await f.click('删除选中的 2 个文件');
    expect(f.app.calls.filter(call => call.startsWith('remove:'))).toEqual(['remove:apk', 'remove:pdf']);
    expect(f.app.confirmations).toHaveLength(2); // one cancelled dialog, one confirmed batch
    expect(f.app.confirmations[1]?.message).toContain('2 个文件');
    expect(f.dom.window.document.body.textContent).toContain('暂无下载文件');
    expect(f.dom.window.document.querySelector('[aria-label="编辑下载列表"]')?.hasAttribute('disabled')).toBe(true);
  } finally { f.close(); }
});

it('selects only the visible search/filter results and clears selection when the scope changes', async () => {
  const f = await fixture('ios');
  try {
    await f.click('编辑下载列表');
    await f.click('全选当前列表');
    f.app.search('missing');
    expect(f.dom.window.document.body.textContent).toContain('已选 0 个文件');
    expect(f.dom.window.document.querySelector('[aria-label="全选当前列表"]')?.hasAttribute('disabled')).toBe(true);
    f.app.search('report');
    await f.click('全选当前列表');
    expect(f.dom.window.document.body.textContent).toContain('已选 1 个文件');
    f.app.search('');
    expect(f.dom.window.document.body.textContent).toContain('已选 0 个文件');
    await f.click('全选当前列表');
    await f.click('已完成');
    expect(f.dom.window.document.body.textContent).toContain('已选 0 个文件');
    await f.click('全选当前列表'); f.app.confirmed = true;
    await f.click('删除选中的 1 个文件');
    expect(f.app.calls.filter(call => call.startsWith('remove:'))).toEqual(['remove:apk']);
    await f.click('全部');
    expect(f.dom.window.document.querySelector('[data-testid="download-pdf"]')).not.toBeNull();
  } finally { f.close(); }
});

it('keeps failed deletions selected for retry and still deletes the other selected files', async () => {
  const f = await fixture('android');
  try {
    await f.click('编辑下载列表'); await f.click('全选当前列表');
    f.app.confirmed = true; f.app.failRemove = 'apk';
    await f.click('删除选中的 2 个文件');
    expect(f.app.calls.filter(call => call.startsWith('remove:'))).toEqual(['remove:apk', 'remove:pdf']);
    expect(f.dom.window.document.body.textContent).toContain('已删除 1 个文件，1 个删除失败');
    expect(f.dom.window.document.querySelector('[aria-label="选择 FrogCoder.apk"]')?.getAttribute('aria-checked')).toBe('true');
    f.app.failRemove = undefined;
    await f.click('删除选中的 1 个文件');
    expect(f.dom.window.document.body.textContent).toContain('暂无下载文件');
  } finally { f.close(); }
});

it('drops vanished selections and lets editing finish if another list removes every file', async () => {
  const f = await fixture('ios');
  try {
    await f.click('编辑下载列表'); await f.click('全选当前列表');
    f.app.items = []; f.app.emit();
    await f.click('完成编辑');
    expect(f.dom.window.document.body.textContent).toContain('暂无下载文件');
    expect(f.dom.window.document.querySelector('[aria-label="选择 FrogCoder.apk"]')).toBeNull();
    expect(f.dom.window.document.querySelector('[aria-label="编辑下载列表"]')?.hasAttribute('disabled')).toBe(true);
  } finally { f.close(); }
});

it('locks batch actions during deletion and leaves newly arrived downloads unselected', async () => {
  const f = await fixture('ios');
  let release!: () => void;
  try {
    await f.click('编辑下载列表'); await f.click('全选当前列表');
    f.app.items.push({ id: 'new', name: 'new.zip', size: 10, received: 2, transferred: 2, state: 'downloading', createdAt: 3, error: '' }); f.app.emit();
    await f.click('选择 report.pdf'); // keep only the APK selected
    expect(f.dom.window.document.querySelector('[aria-label="选择 new.zip"]')?.getAttribute('aria-checked')).toBe('false');
    f.app.confirmed = true; f.app.removeGate = () => new Promise<void>(resolve => { release = resolve; });
    await f.click('删除选中的 1 个文件');
    await f.click('删除选中的 1 个文件');
    expect(f.app.calls.filter(call => call.startsWith('remove:'))).toEqual(['remove:apk']);
    expect(f.app.confirmations).toHaveLength(1);
    expect(f.dom.window.document.querySelector('[aria-label="完成编辑"]')?.hasAttribute('disabled')).toBe(true);
    expect(f.dom.window.document.querySelector('[aria-label="选择 report.pdf"]')?.hasAttribute('disabled')).toBe(true);
    release(); await new Promise(done => setTimeout(done, 10));
    expect(f.dom.window.document.querySelector('[data-testid="download-apk"]')).toBeNull();
    expect(f.dom.window.document.querySelector('[data-testid="download-new"]')).not.toBeNull();
    expect(f.dom.window.document.querySelector('[data-testid="download-pdf"]')).not.toBeNull();
    await f.click('编辑下载列表'); await f.click('选择 new.zip');
    f.app.confirmed = false; await f.click('删除选中的 1 个文件');
    expect(f.app.confirmations.at(-1)?.message).toContain('先停止下载');
    await f.click('完成编辑'); await f.click('编辑下载列表');
    expect(f.dom.window.document.body.textContent).toContain('已选 0 个文件');
  } finally { release?.(); f.close(); }
});
