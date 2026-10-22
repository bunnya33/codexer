import {beforeAll,expect,it} from 'vitest';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {JSDOM} from 'jsdom';
let javascript='';
beforeAll(async()=>{
  const result=await build({entryPoints:['tests/fixtures/preview-share.tsx'],bundle:true,write:false,outdir:'.local/share-ui',platform:'browser',format:'iife',jsx:'automatic',resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.jsx','.js','.json'],nodePaths:[resolve('apps/mobile/node_modules')],alias:{'react-native':'react-native-web'},define:{'process.env.NODE_ENV':'"production"',__DEV__:'false',global:'globalThis','process.env':'{}'},plugins:[{name:'share-fixture',setup(builder){
    builder.onResolve({filter:/^\.\/relay$/},args=>args.importer.endsWith('preview-share-dialog.tsx')?{path:'relay',namespace:'fixture'}:undefined);
    builder.onResolve({filter:/^\.\/runtime$/},args=>args.importer.endsWith('preview-share-dialog.tsx')?{path:'runtime',namespace:'fixture'}:undefined);
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='relay'?'export const relay=window.fixtureRelay;':'export const copyText=window.fixtureCopy; export const confirmAction=window.fixtureConfirm;',loader:'js'}));
  }}]});javascript=result.outputFiles.find(file=>file.path.endsWith('.js'))!.text;
});
async function waitFor(test:()=>boolean){const start=Date.now();while(!test()){if(Date.now()-start>3000)throw new Error('UI timeout');await new Promise(done=>setTimeout(done,10));}}
function fixture(failCreate=false){
  const calls:string[]=[],copied:string[]=[],errors:unknown[]=[];
  let share:{id:string;url:string;kind:'server';enabled:boolean}|null=null,confirmed=false;
  const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.test',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(window){
    window.matchMedia=(()=>({matches:false,addListener(){},removeListener(){}})) as any;
    window.addEventListener('error',event=>errors.push(event.error));
    Object.assign(window,{fixtureRelay:{previewShare:async()=>{calls.push('read');return share;},createPreviewShare:async(_device:string,_thread:string,_kind:string,_source:string,rotate:boolean)=>{calls.push('create:'+rotate);if(failCreate)throw new window.Error('device-offline');share={id:'fixed',url:'https://relay.test/share/'+(rotate?'b':'a').repeat(64),kind:'server',enabled:true};return share;},disablePreviewShare:async()=>{calls.push('disable');share={...share!,enabled:false};}},fixtureCopy:async(text:string)=>copied.push(text),fixtureConfirm:async()=>confirmed});
  }});
  dom.window.eval(javascript);
  const text=()=>dom.window.document.body.textContent??'';
  const click=async(label:string)=>{await waitFor(()=>Array.from(dom.window.document.querySelectorAll('[role="button"]')).some(element=>element.textContent===label&&element.getAttribute('aria-disabled')!=='true'));await new Promise(done=>setTimeout(done,30));const element=Array.from(dom.window.document.querySelectorAll('[role="button"]')).find(element=>element.textContent===label)!;element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));};
  return{dom,calls,copied,errors,text,click,confirm:()=>{confirmed=true;}};
}
it('creates only on explicit action, copies and reuses a link, confirms rotation and disables it',async()=>{
  const app=fixture();try{
    await waitFor(()=>app.calls.includes('read')&&app.text().includes('创建分享链接'));
    expect(app.calls).toEqual(['read']);await app.click('创建分享链接');await waitFor(()=>app.text().includes('分享已开启'));
    await app.click('复制链接');await waitFor(()=>app.text().includes('链接已复制'));expect(app.copied[0]).toContain('/share/'+'a'.repeat(64));
    await app.click('重新生成');await new Promise(done=>setTimeout(done,20));expect(app.calls.filter(call=>call.startsWith('create'))).toEqual(['create:false']);
    app.confirm();await app.click('重新生成');await waitFor(()=>app.text().includes('/share/'+'b'.repeat(64)));
    await app.click('停用分享');await waitFor(()=>app.text().includes('分享已停用'));expect(app.calls).toContain('disable');expect(app.text()).toContain('重新开启分享');
    expect(app.errors).toEqual([]);
  }finally{app.dom.window.close();}
});
it('keeps a failed creation retryable and shows the specific failure',async()=>{
  const app=fixture(true);try{await waitFor(()=>app.calls.includes('read'));await app.click('创建分享链接');await waitFor(()=>app.text().includes('PC 已离线'));expect(app.text()).toContain('创建分享链接');expect(app.text()).not.toContain('分享已开启');expect(app.errors).toEqual([]);}finally{app.dom.window.close();}
});
