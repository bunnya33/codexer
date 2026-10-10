import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildPreviewDocument } from '../packages/client-shared/src/preview-runtime.js';
import { rewritePreviewContent } from './go-preview.js';

it('runs the dashboard interaction, restores state, applies Tweak changes and sends a feedback draft', async () => {
  const messages: Record<string, unknown>[]=[];
  const html=buildPreviewDocument(`<div id="dashboard" aria-label="Dashboard"><button id="next">切换</button><span id="result"></span></div><script>
    const state={radius:8};const root=document.getElementById('dashboard');
    function render(){root.style.borderRadius=state.radius+'px';document.getElementById('result').textContent=String(window.openai.widgetState.modelContent.count);}
    render();const tweak=new Tweak({container:root,onChange:render});tweak.addSlider(state,'radius',{label:'圆角',min:0,max:24});
    document.getElementById('next').onclick=()=>{window.openai.setWidgetState({modelContent:{count:2},privateContent:{panel:'private'}}).catch(()=>{});render();};
  </script>`,'test-channel',{modelContent:{count:1},privateContent:null});
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,beforeParse(window){
    window.TextEncoder=TextEncoder;
    window.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
    window.postMessage=(message: Record<string,unknown>)=>{messages.push(message);};
  }});
  try {
    const {window}=dom;
    const source=window as unknown as Window;
    expect(window.document.getElementById('result')!.textContent).toBe('1');
    window.document.getElementById('next')!.click();
    expect(window.document.getElementById('result')!.textContent).toBe('2');
    const write=messages.find(message=>message.type==='state')!;
    window.dispatchEvent(new window.MessageEvent('message',{source,data:{channel:'test-channel',type:'state-result',id:write.id,ok:true}}));
    const list=messages.find(message=>message.type==='controls')!.controls as {id:string}[];
    window.dispatchEvent(new window.MessageEvent('message',{source,data:{channel:'wrong',type:'tweak',id:list[0]!.id,value:24}}));
    expect(window.document.getElementById('dashboard')!.style.borderRadius).toBe('8px');
    window.dispatchEvent(new window.MessageEvent('message',{source,data:{channel:'test-channel',type:'tweak',id:list[0]!.id,value:18}}));
    expect(window.document.getElementById('dashboard')!.style.borderRadius).toBe('18px');
    window.dispatchEvent(new window.MessageEvent('message',{source,data:{channel:'test-channel',type:'annotate',enabled:true}}));
    window.document.getElementById('next')!.click();
    expect(messages.find(message=>message.type==='selection')).toMatchObject({selector:'#next',tag:'button',text:'切换'});
    const latest=messages.filter(message=>message.type==='controls').at(-1)!.controls as {id:string;label:string;group:string}[];
    const size=latest.find(control=>control.label==='字号'&&control.group.includes('#next'))!;
    window.dispatchEvent(new window.MessageEvent('message',{source,data:{channel:'test-channel',type:'tweak',id:size.id,value:22}}));
    expect(window.document.getElementById('next')!.style.fontSize).toBe('22px');
    window.eval('window.openai.sendFollowUpMessage({prompt:"修改当前布局",title:"反馈"})');
    expect(messages.find(message=>message.type==='follow-up')).toMatchObject({prompt:'修改当前布局'});
  } finally {dom.window.close();}
});

it('maps browser API and HMR traffic once, including relative paths and Relay-derived socket URLs', () => {
  const prefix = '/v1/previews/' + 'a'.repeat(64) + '/';
  const requests: unknown[] = [], sockets: string[] = [], xhr: string[] = [];
  const html = rewritePreviewContent('<html><head></head><body><script>fetch("/api");</script></body></html>', 'text/html', prefix, 'http://localhost:5173', '/nested/page.html');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://relay.example' + prefix + 'nested/page.html',
    beforeParse(window) {
      Object.assign(window, {
        Request,
        fetch: (value: unknown) => { requests.push(value); return Promise.resolve(); },
        WebSocket: class { constructor(url: string) { sockets.push(String(url)); } },
        XMLHttpRequest: class { open(_method: string, url: string) { xhr.push(url); } },
      });
    },
  });
  try {
    const { window } = dom;
    expect(requests[0]).toBe(prefix + 'api');
    window.eval(`fetch(${JSON.stringify(prefix + 'api')});fetch('api?q=1');fetch(new URL('/api',location.href));fetch(new Request('http://localhost:5173/api'));new XMLHttpRequest().open('POST','api');`);
    expect(requests.slice(1,4)).toEqual([prefix + 'api', prefix + 'nested/api?q=1', prefix + 'api']);
    expect((requests[4] as Request).url).toBe('https://relay.example' + prefix + 'api');
    expect(xhr).toEqual([prefix + 'nested/api']);
    expect(window.document.baseURI).toBe('https://relay.example' + prefix + 'nested/page.html');
    window.eval(`new WebSocket('ws://localhost:5173/?token=hmr');new WebSocket('wss://relay.example/?token=hmr');new WebSocket('wss://relay.example${prefix}?token=hmr');new WebSocket('wss://relay.example${prefix}__socket?path=%2F');new WebSocket('wss://external.example/socket');`);
    const mapped = 'wss://relay.example' + prefix + '__socket?path=%2F%3Ftoken%3Dhmr';
    expect(sockets).toEqual([mapped, mapped, mapped, 'wss://relay.example' + prefix + '__socket?path=%2F', 'wss://external.example/socket']);
    window.eval("fetch('https://external.example/api')");
    expect(requests.at(-1)).toBe('https://external.example/api');
  } finally { dom.window.close(); }
});

it('lets a sandboxed app read an optional cookie before opening its WebSocket', () => {
  const prefix = '/v1/previews/' + 'a'.repeat(64) + '/';
  const sockets: string[] = [];
  const html = rewritePreviewContent(`<html><head></head><body><script>
    document.cookie = 'app=value';
    window.cookieValue = document.cookie;
    new WebSocket('ws://localhost:8501/_stcore/stream', ['streamlit', document.cookie || 'PLACEHOLDER_AUTH_TOKEN']);
  </script></body></html>`, 'text/html', prefix, 'http://localhost:8501');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://relay.example' + prefix,
    beforeParse(window) {
      Object.defineProperty(window.document, 'cookie', {
        configurable: true,
        get() { throw new window.DOMException('The document is sandboxed', 'SecurityError'); },
        set() { throw new window.DOMException('The document is sandboxed', 'SecurityError'); },
      });
      Object.assign(window, { WebSocket: class { constructor(url: string) { sockets.push(String(url)); } } });
    },
  });
  try {
    expect((dom.window as unknown as {cookieValue:string}).cookieValue).toBe('');
    expect(sockets).toEqual(['wss://relay.example' + prefix + '__socket?path=%2F_stcore%2Fstream']);
    expect(buildPreviewDocument(html, 'test', null, true)).not.toContain('allow-same-origin');
  } finally { dom.window.close(); }
});
