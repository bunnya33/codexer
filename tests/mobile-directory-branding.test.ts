import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let script = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{Directory}from'./apps/mobile/src/directory';
    const root=createRoot(document.getElementById('root'));
    window.render=view=>flushSync(()=>root.render(<Directory view={{catalogs:{},...view}} deviceId="selected" rows={[]} wide={false}/>));
    window.stop=()=>flushSync(()=>root.unmount());
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'directory-fixture', setup(builder) {
      builder.onResolve({ filter: /^(react-native|lucide-react-native|\.\/(project-transfers|styles|device-picker|drawer-swipe-block|task-status-dot|running-task-count|download-library))$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: {
        'react-native': `import React from 'react';export const Platform={get OS(){return window.platform}};
          export const View=({children,testID})=><div data-testid={testID}>{children}</div>;
          export const Image=({source,accessibilityLabel,testID})=><img src={source} alt={accessibilityLabel} data-testid={testID}/>;
          export const Text=({children})=><span>{children}</span>;export const TextInput=()=>null;
          export const FlatList=()=>null;export const Animated={};export const Easing={};
          export const Pressable=({children,accessibilityLabel,onPress})=><button aria-label={accessibilityLabel} onClick={onPress}>{children}</button>;`,
        'lucide-react-native': 'export const ArrowLeftRight=()=>null;export const FolderClosed=ArrowLeftRight,FolderOpen=ArrowLeftRight,FolderPlus=ArrowLeftRight,MoreHorizontal=ArrowLeftRight,RefreshCw=ArrowLeftRight,Search=ArrowLeftRight,Settings2=ArrowLeftRight,X=ArrowLeftRight;',
        './styles': 'export const directoryThreadHeight=40;export const useTheme=()=>({c:{},s:{}});',
        './project-transfers': 'export const ProjectTransfers=()=>null;',
        './device-picker': 'export const DevicePicker=()=>null;',
        './drawer-swipe-block': 'export const DrawerSwipeBlock=({children})=>children;',
        './task-status-dot': 'export const TaskStatusDot=()=>null;',
        './running-task-count': 'export const RunningTaskCount=()=>null;',
        './download-library': 'import React from "react";export const DownloadLibraryButton=()=> <button aria-label="下载列表"/>;',
      }[args.path]! }));
    } }] }); script = result.outputFiles[0]!.text;
});

it.each(['ios', 'android'])('updates the %s header for activity on any device', platform => {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(window) { Object.assign(window, { platform }); } });
  const app = dom.window as unknown as { render(view: unknown): void; stop(): void };
  dom.window.eval(script);
  try {
    const view = { devices: [{ id: 'selected', online: true }, { id: 'other', online: true }], snapshots: { other: { deviceId: 'other', runtime: { connected: true }, threads: { task: { status: 'active' } } } } };
    const icon = () => dom.window.document.querySelector<HTMLImageElement>('[data-testid="frog-device-status"]')!;
    app.render(view);
    expect(dom.window.document.body.textContent).toContain('FrogCoder');
    expect(icon().alt).toBe('有设备正在运行任务'); const yellow = icon().src;
    view.snapshots.other.threads.task.status = 'idle'; app.render(view);
    expect(icon().alt).toBe('在线设备空闲'); const green = icon().src; expect(green).not.toBe(yellow);
    view.devices.forEach(device => { device.online = false; }); view.snapshots.other.threads.task.status = 'active'; app.render(view);
    expect(icon().alt).toBe('没有设备在线'); expect(icon().src).not.toBe(green); expect(icon().src).not.toBe(yellow);
    const actions = dom.window.document.querySelector('[data-testid="directory-footer-actions"]')!;
    expect([...actions.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['下载列表', '刷新设备', '项目传输']);
    expect(actions.contains(dom.window.document.querySelector('[aria-label="连接设置"]'))).toBe(false);
  } finally { app.stop(); dom.window.close(); }
});

it('retains the desktop product title', () => {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', beforeParse(window) { Object.assign(window, { platform: 'macos' }); } });
  const app = dom.window as unknown as { render(view: unknown): void; stop(): void };
  dom.window.eval(script);
  try {
    app.render({ devices: [], snapshots: {} });
    expect(dom.window.document.body.textContent).toContain('Codexer');
    expect(dom.window.document.querySelector('[data-testid="frog-device-status"]')).toBeNull();
  } finally { app.stop(); dom.window.close(); }
});
