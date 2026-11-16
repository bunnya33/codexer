import {beforeAll, expect, it} from 'vitest';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {agentResourcesSchema} from '../packages/protocol/src/agent-resources.js';

let script = '';
beforeAll(async () => {
  const result = await build({stdin: {contents: `
    import React, {act} from 'react';
    import {createRoot} from 'react-dom/client';
    import {AgentResourceBar} from './apps/mobile/src/agent-resources';
    window.IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.getElementById('root'));
    window.requests = []; window.appListeners = new Set(); window.props = {};
    window.render = (props = {}) => act(() => {window.props = {...window.props, ...props}; root.render(<AgentResourceBar device={{id:'one', name:'我的电脑', online:true, platform:'win32'}} scope="account:one" visible connected {...window.props}/>);});
    window.reply = (index, value) => act(async () => window.requests[index].resolve(value));
    window.fail = (index, message, status) => act(async () => window.requests[index].reject(Object.assign(new Error(message), {status})));
    window.appState = state => act(() => {for(const listener of window.appListeners) listener(state);});
    window.press = () => act(() => document.querySelector('[data-testid="agent-resource-summary"]').click());
    window.stop = () => act(() => root.unmount());
    window.now = 1000000; Date.now = () => window.now;
    let serial = 0; const timers = new Map();
    window.setTimeout = (fn, delay) => {const id = ++serial; timers.set(id, {fn, at:window.now + delay}); return id;};
    window.clearTimeout = id => timers.delete(id);
    window.setInterval = (fn, delay) => {const id=++serial; timers.set(id,{fn, at:window.now+delay, delay}); return id;};
    window.clearInterval = window.clearTimeout;
    window.advance = ms => act(async () => {window.now += ms; for(const [id,timer] of [...timers]) {if(timer.at > window.now) continue; if(timer.delay) timer.at = window.now + timer.delay; else timers.delete(id); timer.fn();} await Promise.resolve();});
  `, resolveDir: process.cwd(), loader: 'tsx'}, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: {'process.env.NODE_ENV': '"test"'}, plugins: [{name: 'resource-ui-fixture', setup(builder) {
    const sources: Record<string, string> = {
      'react-native': `import React from 'react'; export const StyleSheet={create:value=>value};
        export const View=({children})=><div>{children}</div>; export const Text=({children,testID})=><span data-testid={testID}>{children}</span>;
        export const Pressable=({children,onPress,testID,accessibilityLabel})=><button data-testid={testID} aria-label={accessibilityLabel} onClick={onPress}>{children}</button>;
        export const AppState={currentState:'active', addEventListener:(_,listener)=>{window.appListeners.add(listener);return {remove:()=>window.appListeners.delete(listener)}}};`,
      'lucide-react-native': `export const Info=()=>null;`,
      './relay': `export const relay={agentResources:(id,signal)=>new Promise((resolve,reject)=>window.requests.push({id,signal,resolve,reject}))};`,
      './dialog': `import React from 'react'; export const Dialog=({children,title,onClose})=><section aria-label={title}><button onClick={onClose}>关闭</button>{children}</section>;`,
      './theme': `export const themedStyles=factory=>()=>factory({});`,
      './styles': `export const useTheme=()=>({c:{},s:{}});`,
    };
    builder.onResolve({filter: /^(react-native|lucide-react-native|\.\/(relay|dialog|theme|styles))$/}, args => ({path:args.path, namespace:'fixture'}));
    builder.onLoad({filter:/.*/, namespace:'fixture'}, args => ({contents:sources[args.path]!, loader:'jsx', resolveDir:process.cwd()}));
  }}]});
  script = result.outputFiles[0]!.text;
});
const sample = () => ({capturedAt: 1700000000000, logicalCpus: 8, sampleWindowMs: 5000,
  agent: {pid: 123, name: 'Codexer Agent' as const, cpuPercent: 2.3, residentBytes: 128 * 1024 ** 2, privateWorkingSetBytes: 80 * 1024 ** 2, privateBytes: 96 * 1024 ** 2, uptimeSeconds: 3660},
  children: [{pid: 456, name: 'Codex app-server' as const, cpuPercent: 1, residentBytes: 64 * 1024 ** 2, privateWorkingSetBytes: 24 * 1024 ** 2, privateBytes: 32 * 1024 ** 2, uptimeSeconds: 300}],
});
function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {runScripts:'dangerously', beforeParse(window) {
    Object.assign(window, {MessageChannel: class {
      port1 = {onmessage: null as null | (() => void)};
      port2 = {postMessage: () => {setImmediate(() => this.port1.onmessage?.());}};
    }});
  }});
  dom.window.eval(script);
  const window = dom.window as unknown as {
    render(props?:object):void; reply(index:number,value:unknown):Promise<void>; fail(index:number,message:string,status?:number):Promise<void>;
    requests:{id:string;signal:AbortSignal}[]; advance(ms:number):Promise<void>; appState(state:string):void; press():void; stop():void;
  };
  return {window, dom, text:()=>dom.window.document.body.textContent ?? '', close:()=>{window.stop();dom.window.close();}};
}

it('shows only Agent usage in the card and separates its own Codex backend in details', async () => {
  const f=fixture();
  try {
    f.window.render(); expect(f.window.requests).toHaveLength(1);
    await f.window.reply(0,sample());
    expect(f.text()).toContain('CPU 2.3% · 内存 80.0 MiB');
    expect(f.text()).not.toContain('64.0 MiB');
    f.window.press();
    expect(f.text()).toContain('Agent 本身'); expect(f.text()).toContain('64.0 MiB');
    expect(f.text()).toContain('私有提交 96.0 MiB'); expect(f.text()).toContain('1 小时 1 分钟');
    expect(f.text()).toContain('专用工作集 80.0 MiB · 总工作集 128.0 MiB');
    expect(f.text()).toContain('专用工作集 24.0 MiB · 总工作集 64.0 MiB');
    expect(f.text()).toContain('任务管理器默认内存列');
    expect(f.text()).toContain('整机总算力 100%');
    f.window.render({device:{id:'one',name:'我的电脑',online:false,platform:'win32'}});
    expect(f.window.requests[0]!.signal.aborted).toBe(true);
    expect(f.text()).toContain('上次采样'); expect(f.text()).toContain('设备离线');
    await f.window.advance(20000);
    expect(f.window.requests).toHaveLength(1); expect(f.text()).toContain('20 秒前收到');
  } finally {f.close();}
});

it('does not overlap reads and aborts hidden/background work and late responses', async () => {
  const f=fixture();
  try {
    f.window.render({visible:false}); expect(f.window.requests).toHaveLength(0);
    f.window.render({visible:true}); await f.window.advance(30000);
    expect(f.window.requests).toHaveLength(1);
    f.window.appState('background'); expect(f.window.requests[0]!.signal.aborted).toBe(true);
    await f.window.reply(0,sample()); expect(f.text()).not.toContain('80.0 MiB');
    f.window.appState('active'); expect(f.window.requests).toHaveLength(2);
    await f.window.reply(1,sample());
    await f.window.advance(4999); expect(f.window.requests).toHaveLength(2);
    await f.window.advance(1); expect(f.window.requests).toHaveLength(3);
    f.window.render({scope:'account:two',device:{id:'two',name:'另一台电脑',online:true,platform:'darwin'}});
    expect(f.window.requests[2]!.signal.aborted).toBe(true); expect(f.window.requests[3]!.id).toBe('two');
    expect(f.text()).not.toContain('80.0 MiB');
    await f.window.reply(2,sample()); expect(f.text()).not.toContain('80.0 MiB');
    f.window.render({visible:false}); expect(f.window.requests[3]!.signal.aborted).toBe(true);
    await f.window.advance(60000); expect(f.window.requests).toHaveLength(4);
  } finally {f.close();}
});

it('warms up CPU, marks failed cached readings, and stops polling unsupported versions', async () => {
  const f=fixture();
  try {
    f.window.render();
    await f.window.reply(0,{...sample(),sampleWindowMs:null,agent:{...sample().agent,cpuPercent:null}});
    expect(f.text()).toContain('CPU 采样中');
    await f.window.advance(1000); expect(f.window.requests).toHaveLength(2);
    await f.window.reply(1,sample());
    await f.window.advance(5000); await f.window.fail(2,'network failure');
    expect(f.text()).toContain('上次采样');
    f.window.press(); expect(f.text()).toContain('读取失败，正在重试');
    await f.window.advance(10000); expect(f.window.requests).toHaveLength(4);
    await f.window.fail(3,'agent-update-required',409);
    expect(f.text()).toContain('更新此设备的 Agent');
    await f.window.advance(60000); expect(f.window.requests).toHaveLength(4);
  } finally {f.close();}
});

it('rejects malformed or unbounded resource payloads', () => {
  expect(agentResourcesSchema.parse(sample()).agent.cpuPercent).toBe(2.3);
  for (const cpuPercent of [NaN,Infinity,-1,101]) expect(agentResourcesSchema.safeParse({...sample(),agent:{...sample().agent,cpuPercent}}).success).toBe(false);
  expect(agentResourcesSchema.safeParse({...sample(),children:Array(5).fill(sample().children[0])}).success).toBe(false);
  expect(agentResourcesSchema.safeParse({...sample(),agent:{...sample().agent,residentBytes:-1}}).success).toBe(false);
  for (const privateWorkingSetBytes of [-1, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(agentResourcesSchema.safeParse({...sample(),agent:{...sample().agent,privateWorkingSetBytes}}).success).toBe(false);
});

it('labels legacy Windows working sets explicitly and leaves macOS resident memory unchanged', async () => {
  const f=fixture();
  try {
    f.window.render();
    const {privateWorkingSetBytes, ...agent} = sample().agent;
    await f.window.reply(0,{...sample(),agent});
    expect(f.text()).toContain('CPU 2.3% · 工作集 128.0 MiB');
    f.window.press(); expect(f.text()).toContain('更新 Agent 后可按任务管理器口径显示内存');
    expect(agentResourcesSchema.parse({...sample(),agent}).agent.privateWorkingSetBytes).toBeUndefined();
    f.window.render({device:{id:'one',name:'Mac',online:true,platform:'darwin'}});
    expect(f.text()).toContain('CPU 2.3% · 内存 128.0 MiB');
    expect(f.text()).not.toContain('私有提交');
  } finally {f.close();}
});

it('shows an unavailable private working set without substituting a different Windows metric', async () => {
  const f=fixture();
  try {
    f.window.render();
    await f.window.reply(0,{...sample(),agent:{...sample().agent,privateWorkingSetBytes:null}});
    expect(f.text()).toContain('CPU 2.3% · 内存 不可用');
    expect(f.text()).not.toContain('128.0 MiB');
    f.window.press(); expect(f.text()).toContain('总工作集 128.0 MiB');
  } finally {f.close();}
});
