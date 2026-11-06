import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

let javascript = '', css = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/task-status-app.tsx'], outdir: '.local/task-status-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis', 'process.env': '{}' } });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
  css = result.outputFiles!.find(file => file.path.endsWith('.css'))?.text ?? '';
});

async function fixture() {
  const errors: unknown[] = [];
  const dom = new JSDOM(`<style>${css}</style><div id="root"></div>`, { url: 'http://fixture.test', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {
    window.addEventListener('error', event => errors.push(event.error));
    Object.assign(window, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
    window.matchMedia = (() => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  } });
  dom.window.eval(javascript);
  const doc = dom.window.document;
  await vi.waitFor(() => expect(doc.querySelector('[data-testid="turn-token-usage"]')).not.toBeNull());
  const click = (label: string) => (doc.querySelector(`[aria-label="${label}"]`) as HTMLElement).click();
  return { doc, click, errors, close() { (dom.window as unknown as { taskStatusFixture: { close(): void } }).taskStatusFixture.close(); dom.window.close(); } };
}

it('places running markers before the title and tokens, with a spinner only at processing duration', async () => {
  const f = await fixture();
  try {
    const header = f.doc.querySelector('[data-testid="conversation-header"]')!;
    const dot = header.querySelector('[aria-label="当前会话正在运行"]')!;
    expect(dot.compareDocumentPosition(header.querySelector('[data-testid="conversation-title"]')!) & 4).toBe(4);
    const usage = f.doc.querySelector('[data-testid="turn-token-usage"]')!;
    expect(usage.firstElementChild?.getAttribute('aria-label')).toBe('任务进行中');
    expect(usage.textContent).toContain('输入 1,000');
    const spinner = f.doc.querySelector('[data-testid="processing-spinner"]')!;
    expect(spinner).not.toBeNull();
    expect(spinner.parentElement?.querySelector('[data-testid="task-status-dot"]')).toBeNull();
    expect(f.doc.querySelector('[data-testid="turn-end-time"]')).toBeNull();
    expect(f.errors).toEqual([]);
  } finally { f.close(); }
});

it('removes all orange markers on completion while retaining tokens and the solid green ended marker', async () => {
  const f = await fixture();
  try {
    f.click('切换任务状态');
    await vi.waitFor(() => expect(f.doc.querySelectorAll('.codexer-task-dot-running').length).toBe(0));
    expect(f.doc.querySelector('[data-testid="processing-spinner"]')).toBeNull();
    expect(f.doc.querySelector('[data-testid="turn-token-usage"]')?.textContent).toContain('输入 1,000');
    expect(f.doc.querySelector('[aria-label="任务已结束"] .codexer-task-dot-ring')).toBeNull();
    expect(f.doc.querySelector('[aria-label="任务已结束"] .codexer-task-dot-core')).not.toBeNull();
    expect(f.doc.querySelector('[data-testid="turn-end-time"]')?.textContent).toContain('已完成');
  } finally { f.close(); }
});

it('places project and chat markers before their text and preserves project activity when collapsed', async () => {
  const f = await fixture();
  try {
    for (const label of ['项目 示例项目 有会话正在运行', '正在运行：示例会话']) {
      const dot = f.doc.querySelector(`[aria-label="${label}"]`)!;
      expect(dot).not.toBeNull();
      expect(dot.nextElementSibling?.textContent).toBe(label.startsWith('项目') ? '示例项目' : '示例会话');
    }
    f.click('收起项目 示例项目');
    await vi.waitFor(() => expect(f.doc.querySelector('[aria-label="展开项目 示例项目"]')).not.toBeNull());
    expect(f.doc.querySelector('[aria-label="项目 示例项目 有会话正在运行"]')).not.toBeNull();
  } finally { f.close(); }
});

it('shows running token status before the first usage report and removes it when the turn ends', async () => {
  const f = await fixture();
  try {
    f.click('切换 Token 数据');
    await vi.waitFor(() => expect(f.doc.querySelector('[data-testid="turn-token-usage"]')?.textContent).toBe('Token 统计中'));
    expect(f.doc.querySelector('[data-testid="turn-token-usage"] [aria-label="任务进行中"]')).not.toBeNull();
    f.click('切换任务状态');
    await vi.waitFor(() => expect(f.doc.querySelector('[data-testid="turn-token-usage"]')).toBeNull());
  } finally { f.close(); }
});
