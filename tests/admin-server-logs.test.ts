import {beforeAll,expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {resolve} from 'node:path';

let source='';
beforeAll(async()=>{const result=await build({stdin:{contents:`import {createRoot} from 'react-dom/client';import {ServerLogsPanel} from './apps/admin/src/server-logs';const root=createRoot(document.getElementById('root'));window.stopPanel=()=>root.unmount();window.expired=0;root.render(<ServerLogsPanel onUnauthorized={()=>window.expired++}/>);`,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,jsx:'automatic',format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});source=result.outputFiles[0]!.text;});
const entry=(id=10)=>({id,at:1793412673175,level:'warn',category:'protocol',code:'invalid-message',deviceId:'device-test',connectionId:'connection-test',messageType:'device.snapshot',closeCode:1008,messageBytes:1234,issues:[{path:'/snapshot/threads/*/title',rule:'type'}]});
const page=(entries=[entry()],nextCursor:number|null=null,persistent=true)=>({entries,nextCursor,persistent,retained:101,capacity:2000,file:'server-logs.jsonl',maxFileBytes:2097152,fileCount:2,capturedAt:Date.now()});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
async function fixture(respond:(url:string,init:RequestInit,call:number)=>Response|Promise<Response>){
  const calls:{url:string;init:RequestInit}[]=[],copies:string[]=[],errors:unknown[]=[];
  const dom=new JSDOM('<div id="root"></div>',{url:'http://admin.test',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){Object.assign(w,{AbortController,AbortSignal,fetch:async(url:string,init:RequestInit)=>{calls.push({url,init});return respond(url,init,calls.length);}});Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async(text:string)=>{copies.push(text);}}});w.addEventListener('error',e=>errors.push(e.error));}});
  dom.window.eval(source);
  const wait=(check:()=>void)=>vi.waitFor(check,{timeout:3000,interval:10});
  await wait(()=>expect(calls.length).toBe(1));
  const text=()=>dom.window.document.body.textContent!;
  const button=(label:string)=>[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent===label)!;
  return {dom,calls,copies,errors,wait,text,button,refresh:()=>dom.window.document.querySelector<HTMLButtonElement>('[aria-label="刷新服务器日志"]')!.click(),close(){(dom.window as any).stopPanel();dom.window.close();}};
}

it('shows diagnostic fields, expands and copies metadata, and paginates without duplicate rows',async()=>{
  const f=await fixture((_url,_init,call)=>json(call===1?page([entry()],10):page([entry(),entry(9)])));
  try{
    await f.wait(()=>expect(f.text()).toContain('消息未通过协议校验'));
    expect(f.text()).toContain('服务器重启后可继续查看');
    f.dom.window.document.querySelector<HTMLButtonElement>('.server-log-summary')!.click();
    await f.wait(()=>expect(f.text()).toContain('/snapshot/threads/*/title'));
    expect(f.text()).toContain('connection-test');expect(f.text()).toContain('1234');
    f.button('复制诊断').click();await f.wait(()=>expect(f.copies.length).toBe(1));
    expect(JSON.parse(f.copies[0]!)).toMatchObject({deviceId:'device-test',closeCode:1008});
    f.button('加载更早日志').click();await f.wait(()=>expect(f.calls.length).toBe(2));
    expect(new URL(f.calls[1]!.url,'http://admin.test').searchParams.get('before')).toBe('10');
    await f.wait(()=>expect(f.dom.window.document.querySelectorAll('.server-log-entry').length).toBe(2));
    expect(f.button('加载更早日志')).toBeUndefined();expect(f.errors).toEqual([]);
  }finally{f.close();}
});

it('filters only on submit, resets, and ignores an aborted response from an older filter',async()=>{
  let finish!:(response:Response)=>void;
  const f=await fixture((_url,_init,call)=>call===2?new Promise(done=>{finish=done;}):json(page([entry(call===3?99:10)])));
  try{
    await f.wait(()=>expect(f.text()).toContain('消息未通过协议校验'));
    const level=f.dom.window.document.querySelector('select')!;level.value='error';level.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
    await new Promise(done=>setTimeout(done,10));expect(f.calls.length).toBe(1);
    f.button('筛选').click();await f.wait(()=>expect(f.calls.length).toBe(2));
    expect(new URL(f.calls[1]!.url,'http://admin.test').searchParams.get('level')).toBe('error');
    f.button('重置').click();await f.wait(()=>expect(f.calls.length).toBe(3));
    expect(f.calls[1]!.init.signal?.aborted).toBe(true);
    finish(json(page([entry(88)])));await f.wait(()=>expect(f.dom.window.document.querySelectorAll('.server-log-entry').length).toBe(1));
    f.dom.window.document.querySelector<HTMLButtonElement>('.server-log-summary')!.click();
    await f.wait(()=>expect(f.button('复制诊断')).toBeDefined());f.button('复制诊断').click();
    await f.wait(()=>expect(f.copies.length).toBe(1));
    expect(JSON.parse(f.copies.at(-1)!).id).toBe(99);
  }finally{f.close();}
});

it('keeps previous logs on refresh failure, recovers, and indicates memory-only logging',async()=>{
  const f=await fixture((_url,_init,call)=>{if(call===2)throw new Error('offline');return json(page([entry()],null,false));});
  try{await f.wait(()=>expect(f.text()).toContain('未写入磁盘'));f.refresh();await f.wait(()=>expect(f.text()).toContain('下方保留上次读取'));expect(f.dom.window.document.querySelectorAll('.server-log-entry').length).toBe(1);f.refresh();await f.wait(()=>expect(f.text()).not.toContain('下方保留上次读取'));}finally{f.close();}
});

it('aborts in-flight requests on navigation and forwards expired admin sessions',async()=>{
  let finish!:(value:Response)=>void;
  const f=await fixture(()=>new Promise(done=>{finish=done;}));
  try{f.refresh();expect(f.calls.length).toBe(1);(f.dom.window as any).stopPanel();expect(f.calls[0]!.init.signal?.aborted).toBe(true);finish(json(page()));await new Promise(done=>setTimeout(done,10));expect(f.errors).toEqual([]);}finally{f.close();}
  const expired=await fixture(()=>json({error:'unauthorized'},401));try{await expired.wait(()=>expect((expired.dom.window as any).expired).toBe(1));}finally{expired.close();}
});
