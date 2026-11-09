import {beforeAll, expect, it, vi} from 'vitest';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {resolve} from 'node:path';
import type {ProjectQuery} from '../packages/protocol/src/project-files';

let javascript = '';
beforeAll(async () => {
  const result = await build({entryPoints: ['tests/fixtures/project-browser.tsx'], outdir: '.local/project-browser-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: {'react-native': 'react-native-web'}, define: {'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}'}});
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, release};
}
async function fixture(fileWait?: Promise<void>) {
  let width = 1590, height = 906;
  const requests: {query: ProjectQuery; signal?: AbortSignal}[] = [];
  const content = (path: string) => `// ${path}\nexport const value = 1;\n`;
  const dom = new JSDOM('<div id="root"></div>', {url: 'https://fixture.test', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    Object.defineProperties(window.HTMLHtmlElement.prototype, {clientWidth: {get: () => width}, clientHeight: {get: () => height}});
    window.HTMLElement.prototype.getBoundingClientRect = () => ({x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {}});
    window.matchMedia = (() => ({matches: false, addListener() {}, removeListener() {}})) as unknown as typeof window.matchMedia;
    Object.assign(window, {TextDecoder, ResizeObserver: class {observe() {} unobserve() {} disconnect() {}},
      fetch: async (url: string) => new Response(content(new URL(url).pathname.slice('/files/'.length))),
      __projectFiles: async (_device: string, _project: string, query: ProjectQuery, signal?: AbortSignal) => {
        requests.push({query, signal});
        if (query.operation === 'file') {
          if (query.path === 'src/a.ts') await fileWait;
          return {kind: 'file', file: {name: query.path.split('/').at(-1), size: new TextEncoder().encode(content(query.path)).length, version: 'a'.repeat(64)}};
        }
        if (query.operation === 'search') return {kind: 'search', matches: [{path: 'src/a.ts', line: 2, text: 'export const value = 1;'}], scanned: 2, skipped: 0};
        return {kind: 'list', entries: query.path === 'src' ? ['a.ts', 'b.ts'].map(name => ({name, path: 'src/' + name, kind: 'file', size: 50})) : [{name: 'src', path: 'src', kind: 'directory', size: 0}]};
      },
    });
  }});
  dom.window.eval(javascript);
  const element = (label: string) => dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const click = async (label: string) => {await vi.waitFor(() => expect(element(label)).toBeTruthy()); element(label).click();};
  const resize = async (w: number, h: number) => {width = w; height = h; dom.window.dispatchEvent(new dom.window.Event('resize')); await new Promise(resolve => setTimeout(resolve, 30));};
  await click('展开目录 src');
  await vi.waitFor(() => expect(element('打开文件 src/a.ts')).toBeTruthy());
  return {dom, requests, element, click, resize};
}
it('keeps an in-flight preview alive while refreshing and searching the other pane', async () => {
  const pending = gate(), f = await fixture(pending.promise);
  try {
    await f.click('打开文件 src/a.ts');
    await vi.waitFor(() => expect(f.requests.some(r => r.query.operation === 'file')).toBe(true));
    await f.click('刷新项目文件');
    const input = f.element('搜索项目文件') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'value');
    input.dispatchEvent(new f.dom.window.Event('input', {bubbles: true}));
    await vi.waitFor(() => expect(f.element('打开 src/a.ts 第 2 行')).toBeTruthy());
    const reads = f.requests.filter(r => r.query.operation === 'file');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.signal?.aborted).toBe(false);
    pending.release();
    await vi.waitFor(() => expect(f.element('src/a.ts 源码')?.textContent).toContain('export const'));
    expect(f.dom.window.document.querySelector('[data-testid="project-navigation"]')).not.toBeNull();
  } finally {pending.release(); f.dom.window.close();}
});
it('retains the selected file when resizing, and restores the expanded directory on mobile back', async () => {
  const f = await fixture();
  try {
    await f.click('打开文件 src/a.ts');
    await vi.waitFor(() => expect(f.element('src/a.ts 源码')).toBeTruthy());
    await f.resize(390, 844);
    expect(f.dom.window.document.querySelector('[data-testid="project-navigation"]')).toBeNull();
    expect(f.element('src/a.ts 源码')).toBeTruthy();
    expect(f.element('返回列表')).toBeTruthy();
    await f.resize(1280, 800);
    expect(f.element('打开文件 src/a.ts')).toBeTruthy();
    expect(f.element('src/a.ts 源码')).toBeTruthy();
    expect(f.requests.filter(r => r.query.operation === 'file')).toHaveLength(1);
    await f.resize(900, 559);
    expect(f.dom.window.document.querySelector('[data-testid="project-navigation"]')).toBeNull();
    await f.click('返回列表');
    await vi.waitFor(() => expect(f.element('打开文件 src/b.ts')).toBeTruthy());
  } finally {f.dom.window.close();}
});
it('cancels an older selection and ignores its delayed response', async () => {
  const pending = gate(), f = await fixture(pending.promise);
  try {
    await f.click('打开文件 src/a.ts');
    await vi.waitFor(() => expect(f.requests.some(r => r.query.operation === 'file')).toBe(true));
    await f.click('打开文件 src/b.ts');
    await vi.waitFor(() => expect(f.element('src/b.ts 源码')).toBeTruthy());
    expect(f.requests.find(r => r.query.operation === 'file' && r.query.path === 'src/a.ts')!.signal?.aborted).toBe(true);
    pending.release();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.element('src/b.ts 源码')?.textContent).toContain('src/b.ts');
    expect(f.element('src/a.ts 源码')).toBeNull();
  } finally {pending.release(); f.dom.window.close();}
});
