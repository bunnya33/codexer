import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {expect,it} from 'vitest';

const bootstrap=readFileSync(new URL('../apps/relay/protocol/preview-bootstrap.html',import.meta.url),'utf8');
function frame(saved:Record<string,unknown>={}) {
  const dom=new JSDOM('<html><head></head><body><form><button>Submit</button></form></body></html>',{url:'https://relay.test/v1/previews/test/',runScripts:'outside-only'});
  const requests:{url:string;options:RequestInit}[]=[];
  const win=dom.window;
  for(const area of ['localStorage','sessionStorage'])Object.defineProperty(win,area,{configurable:true,get:()=>{throw new win.DOMException('Opaque sandbox','SecurityError');}});
  Object.assign(win,{TextEncoder,fetch:async(url:string,options:RequestInit)=>{requests.push({url,options});return {ok:true};}});
  const text=bootstrap.replace('@@BASE@@','/v1/previews/test/').replace('@@PREFIX@@',JSON.stringify('/v1/previews/test/')).replace('@@ORIGIN@@',JSON.stringify('http://localhost:5173')).replace('@@PATH@@',JSON.stringify('/')).replace('@@STORAGE@@',JSON.stringify(saved));
  win.eval(text.match(/<script>([\s\S]*)<\/script>/)![1]!);
  return {win,requests,close:()=>win.close()};
}

it('lets a sandboxed app register and submit forms when it reads storage during startup',async()=>{
  const f=frame();
  try {
    f.win.eval(`localStorage.getItem('name');document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();localStorage.setItem('name','islander');document.body.dataset.submitted='yes';});`);
    const event=new f.win.Event('submit',{cancelable:true});
    expect(f.win.document.querySelector('form')!.dispatchEvent(event)).toBe(false);
    expect(f.win.document.body.dataset.submitted).toBe('yes');
    expect(f.win.localStorage.getItem('name')).toBe('islander');
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.url).toBe('/v1/previews/test/__codexer_storage');
    expect(f.requests[0]!.options.credentials).toBe('omit');
    expect(JSON.parse(String(f.requests[0]!.options.body))).toEqual({local:{name:'islander'},session:{}});
  } finally {f.close();}
});

it('restores only the preview storage, supports storage methods and bounds writes synchronously',()=>{
  const f=frame({local:{name:'islander'},session:{view:'map'}}),other=frame();
  try {
    expect(f.win.localStorage instanceof f.win.Storage).toBe(true);
    expect(f.win.localStorage.getItem('name')).toBe('islander');
    expect(f.win.sessionStorage.getItem('view')).toBe('map');
    expect(other.win.localStorage.getItem('name')).toBeNull();
    f.win.localStorage.extra=123;
    expect(f.win.localStorage.getItem('extra')).toBe('123');
    expect(Object.keys(f.win.localStorage)).toEqual(['name','extra']);
    expect(f.win.localStorage.key(0)).toBe('name');
    expect(f.win.localStorage.key(99)).toBeNull();
    const before=f.win.localStorage.length;
    expect(()=>f.win.localStorage.setItem('large','x'.repeat(65536))).toThrow('Preview storage quota exceeded');
    expect(f.win.localStorage.length).toBe(before);
    expect(f.win.localStorage.getItem('large')).toBeNull();
    delete f.win.localStorage.extra;
    expect(f.win.localStorage.getItem('extra')).toBeNull();
    f.win.localStorage.clear();
    expect(f.win.localStorage.length).toBe(0);
    expect(f.win.sessionStorage.getItem('view')).toBe('map');
  } finally {f.close();other.close();}
});
