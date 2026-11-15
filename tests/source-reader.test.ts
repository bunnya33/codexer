import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

let javascript = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/source-reader.tsx'], outdir: '.local/source-reader-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' } });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
});

async function fixture(files: Record<string, string>) {
  const requests: string[] = [];
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4187', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    window.HTMLElement.prototype.scrollTo = function(options?: ScrollToOptions | number, y?: number) {
      const position = typeof options === 'number' ? { left: options, top: y } : options ?? {};
      if (position.top !== undefined) this.scrollTop = position.top;
      if (position.left !== undefined) this.scrollLeft = position.left;
    };
    Object.assign(window, { readerFiles: files, TextEncoder, TextDecoder, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, fetch: async (input: string) => {
      requests.push(input);
      return new Response(files[new URL(input).searchParams.get('path')!]);
    } });
  } });
  dom.window.eval(javascript);
  const element = (label: string) => dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const click = async (label: string) => { await vi.waitFor(() => expect(element(label)).toBeTruthy()); element(label)!.click(); };
  const search = async (query: string) => {
    await vi.waitFor(() => expect(element('搜索文件内容')).toBeTruthy());
    const input = element('搜索文件内容')!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, query);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  return { dom, requests, element, click, search, active: () => [...dom.window.document.querySelectorAll('[data-testid="active-source-match"]')].map(element => element.textContent).join('') };
}

it('opens Lua as highlighted source without downloading and searches with next/previous/case/clear controls', async () => {
  const f = await fixture({ '/demo/result.lua': 'local value = "<script>"\nreturn Value .. value\n' });
  try {
    await f.click('打开 /demo/result.lua');
    await vi.waitFor(() => expect(f.element('/demo/result.lua 源码')?.textContent).toContain('local value'));
    expect(f.dom.window.document.body.textContent).not.toContain('是否下载此文件');
    expect(f.requests).toHaveLength(1);
    expect(new URL(f.requests[0]!).searchParams.get('preview')).toBe('1');
    expect(f.element('/demo/result.lua 源码')!.querySelector('script')).toBeNull();
    await f.search('value');
    await vi.waitFor(() => expect(f.element('搜索结果')?.textContent).toBe('1/3'));
    expect(f.active()).toBe('value');
    await f.click('下一个匹配');
    await vi.waitFor(() => expect(f.active()).toBe('Value'));
    expect(f.element('搜索结果')?.textContent).toBe('2/3');
    await f.click('上一个匹配');
    await vi.waitFor(() => expect(f.element('搜索结果')?.textContent).toBe('1/3'));
    await f.click('上一个匹配');
    await vi.waitFor(() => expect(f.element('搜索结果')?.textContent).toBe('3/3'));
    await f.click('区分大小写');
    await vi.waitFor(() => expect(f.element('搜索结果')?.textContent).toBe('1/2'));
    await f.search('missing');
    await vi.waitFor(() => expect(f.dom.window.document.body.textContent).toContain('未找到匹配内容'));
    await f.click('清除文件搜索');
    await vi.waitFor(() => expect(f.element('搜索结果')).toBeNull());
    expect(f.active()).toBe('');
    expect(f.requests).toHaveLength(1);
  } finally { f.dom.window.close(); }
});

it('renders Markdown as a document and switches to searchable source without another fetch', async () => {
  const f = await fixture({ '/demo/README.md': '# 使用说明\n\n| 项目 | 说明 |\n| --- | --- |\n| Lua | 脚本 |\n\n```lua\nlocal value = 1\n```' });
  try {
    await f.click('打开 /demo/README.md');
    await vi.waitFor(() => expect(f.element('文档预览')).toBeTruthy());
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('[role="heading"]')?.textContent).toBe('会话文件'));
    expect(f.dom.window.document.body.textContent).toContain('使用说明');
    expect(f.element('搜索文件内容')).toBeNull();
    await f.click('源码与搜索');
    await f.search('Lua');
    await vi.waitFor(() => expect(f.element('搜索结果')?.textContent).toBe('1/2'));
    await f.click('文档预览');
    await vi.waitFor(() => expect(f.element('搜索文件内容')).toBeNull());
    expect(f.requests).toHaveLength(1);
  } finally { f.dom.window.close(); }
});

it('resets search when opening another file and preserves binary download confirmation', async () => {
  const f = await fixture({ '/demo/a.lua': 'local value = 1', '/demo/b.py': 'print("hello")', '/demo/archive.zip': 'binary' });
  try {
    await f.click('打开 /demo/a.lua');
    await f.search('value');
    await vi.waitFor(() => expect(f.element('搜索结果')?.textContent).toBe('1/1'));
    const scroll = f.dom.window.document.querySelector<HTMLElement>('[data-testid="source-lines"]')!;
    scroll.scrollTop = 230;
    await f.click('下一个匹配');
    await vi.waitFor(() => expect(scroll.scrollTop).toBe(0));
    await f.click('关闭文件');
    await f.click('打开 /demo/b.py');
    await vi.waitFor(() => expect(f.element('/demo/b.py 源码')).toBeTruthy());
    expect((f.element('搜索文件内容') as HTMLInputElement).value).toBe('');
    expect(f.element('搜索结果')).toBeNull();
    await f.click('关闭文件');
    await f.click('打开 /demo/archive.zip');
    await vi.waitFor(() => expect(f.dom.window.document.body.textContent).toContain('是否下载此文件'));
    expect(f.element('确认下载')).toBeTruthy();
    expect(f.requests).toHaveLength(2);
  } finally { f.dom.window.close(); }
});
