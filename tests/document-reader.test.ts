import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

let javascript = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/document-reader.tsx'], outdir: '.local/document-reader-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' } });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
});
async function fixture(reply: (request: number, signal: AbortSignal) => Promise<Response>) {
  const requests: { uri: string; headers: Record<string, string>; signal: AbortSignal }[] = [];
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4188', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    Object.assign(window, { documentFiles: { '/demo/sample.pdf': { name: 'sample.pdf', size: 25 }, '/demo/sample.docx': { name: 'sample.docx', size: 30 } }, TextEncoder, TextDecoder,
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
      fetch: async (uri: string, options: { signal: AbortSignal; headers: Record<string, string> }) => { requests.push({ uri, ...options }); return reply(requests.length, options.signal); } });
  } });
  dom.window.eval(javascript);
  const element = (label: string) => dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const click = async (label: string) => { await vi.waitFor(() => expect(element(label)).toBeTruthy()); element(label)!.click(); };
  return { dom, requests, element, click };
}
it('fetches PDF through existing file transfer and keeps document bytes inside an isolated frame', async () => {
  const f = await fixture(async () => new Response('%PDF-1.7\n%%EOF'));
  try {
    for (const extension of ['pdf']) {
      await f.click(`打开 /demo/sample.${extension}`);
      await vi.waitFor(() => expect(f.dom.window.document.querySelector('iframe')).toBeTruthy());
      const frame = f.dom.window.document.querySelector('iframe')!;
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
      expect(frame.srcdoc).toContain('/v1/document-runtime/viewer.js');
      expect(frame.srcdoc).not.toContain('Bearer');
      const request = f.requests.at(-1)!;
      expect(request.uri).toContain('/files/content?'); expect(new URL(request.uri).searchParams.get('preview')).toBe('1'); expect(request.headers.authorization).toBe('Bearer fixture-only');
      expect(f.dom.window.document.body.textContent).not.toContain('是否下载此文件');
      expect(f.element('下载文件')).toBeTruthy();
      await f.click('关闭文件');
      await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
    }
    expect(f.requests).toHaveLength(1);
    await f.click('打开 /demo/sample.docx');
    await vi.waitFor(() => expect(f.dom.window.document.body.textContent).toContain('是否下载此文件'));
    expect(f.requests).toHaveLength(1);
  } finally { f.dom.window.close(); }
});
it('explains a transfer failure and retries without losing the original download action', async () => {
  const f = await fixture(async request => request === 1 ? new Response('{"error":"file-timeout"}', { status: 504 }) : new Response('%PDF-1.7\n%%EOF'));
  try {
    await f.click('打开 /demo/sample.pdf');
    await vi.waitFor(() => expect(f.dom.window.document.body.textContent).toContain('读取文件超时'));
    expect(f.element('下载文件')).toBeTruthy();
    await f.click('重试文档预览');
    await vi.waitFor(() => expect(f.dom.window.document.querySelector('iframe')).toBeTruthy());
    expect(f.requests).toHaveLength(2); expect(f.requests[0]!.signal.aborted).toBe(true);
  } finally { f.dom.window.close(); }
});
it('aborts unfinished PDF reads on closing or changing conversations and ignores late responses', async () => {
  let finish!: (value: Response) => void;
  const f = await fixture(async () => new Promise<Response>(resolve => { finish = resolve; }));
  try {
    for (const action of ['关闭文件', '切换会话']) {
      await f.click('打开 /demo/sample.pdf');
      await vi.waitFor(() => expect(f.requests).toHaveLength(action === '关闭文件' ? 1 : 2));
      const request = f.requests.at(-1)!;
      await f.click(action);
      await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
      finish(new Response('%PDF-1.7\n%%EOF'));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(f.dom.window.document.querySelector('iframe')).toBeNull();
    }
  } finally { f.dom.window.close(); }
});
