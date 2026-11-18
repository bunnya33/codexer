import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

let javascript = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {TurnView} from './apps/mobile/src/conversation';
    import {ThemeProvider} from './apps/mobile/src/theme';
    const prompt={id:'prompt',type:'userMessage',text:'Original question',truncated:false};
    const previous={id:'previous',type:'agentMessage',text:'Earlier reply',truncated:false};
    const noop=()=>{};
    function Fixture(){
      const [revision,setRevision]=useState(0);
      const [active,setActive]=useState(true);
      const turn={id:'turn',status:active?'inProgress':'completed',truncated:false,items:[prompt,previous,
        {id:'latest',type:'agentMessage',text:'Live reply '+revision,truncated:false}]};
      window.updateReply=()=>setRevision(value=>value+1);
      window.completeTurn=()=>setActive(false);
      return <TurnView turn={turn} active={active} deviceId="device" threadId="thread" onImage={noop} questionRequestIds={[]}/>;
    }
    const root=createRoot(document.getElementById('root'));
    window.closeFixture=()=>root.unmount();
    root.render(<ThemeProvider><Fixture/></ThemeProvider>);
  `, loader: 'tsx', resolveDir: resolve('.') }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')],
    alias: { 'react-native': 'react-native-web' }, loader: { '.css': 'empty' },
    plugins: [{ name: 'count-message-render', setup(build) {
      // Exercise the native Markdown implementation used by the IPA.
      build.onResolve({ filter: /^\.\/markdown$/ }, () => ({ path: resolve('apps/mobile/src/markdown.tsx') }));
      build.onLoad({ filter: /[\\/]apps[\\/]mobile[\\/]src[\\/]markdown\.tsx$/ }, async args => ({ loader: 'tsx', contents:
        (await readFile(args.path, 'utf8')).replace('return <PreviewContent', 'window.messageRenders[children]=(window.messageRenders[children]||0)+1; return <PreviewContent') }));
    } }], define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' } });
  javascript = result.outputFiles[0]!.text;
});

it('reuses unchanged messages during live updates while rendering new replies and completion', async () => {
  const errors: unknown[] = [];
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://fixture.test', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    window.addEventListener('error', event => errors.push(event.error));
    Object.assign(window, { messageRenders: {}, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
    window.matchMedia = (() => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  } });
  const host = dom.window as unknown as { messageRenders: Record<string, number>; updateReply(): void; completeTurn(): void; closeFixture(): void };
  try {
    dom.window.eval(javascript);
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('Live reply 0'));
    const promptRenders = host.messageRenders['Original question'];
    const replyRenders = host.messageRenders['Earlier reply'];
    expect(promptRenders).toBeGreaterThan(0);
    expect(replyRenders).toBeGreaterThan(0);
    for (let revision = 1; revision <= 5; revision++) {
      host.updateReply();
      await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain(`Live reply ${revision}`));
    }
    expect(host.messageRenders['Original question']).toBe(promptRenders);
    expect(host.messageRenders['Earlier reply']).toBe(replyRenders);
    host.completeTurn();
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-testid="work-disclosure-turn"]')).not.toBeNull());
    expect(dom.window.document.body.textContent).toContain('Live reply 5');
    expect(errors).toEqual([]);
  } finally { host.closeFixture?.(); dom.window.close(); }
});
