import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
let javascript = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/project-create.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' }, define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis' } });
  javascript = result.outputFiles![0]!.text;
});
async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) { window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia; } });
  dom.window.eval(javascript);
  await vi.waitFor(() => expect(dom.window.document.querySelector('[aria-label="项目名称"]')).not.toBeNull());
  return dom;
}
it('validates mobile form paths, keeps errors visible, and allows adding an existing project', async () => {
  const dom = await fixture();
  try {
    const document = dom.window.document;
    const input = (label: string, value: string) => {
      const field = document.querySelector(`[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    const button = (text: string) => [...document.querySelectorAll('[role="button"]')].find(item => item.textContent === text) as HTMLElement;
    input('项目名称', 'Demo'); input('文件夹相对路径', '../outside');
    await vi.waitFor(() => expect(button('创建项目').getAttribute('aria-disabled')).toBe('true'));
    input('文件夹相对路径', 'apps/demo');
    await vi.waitFor(() => expect(button('创建项目').getAttribute('aria-disabled')).not.toBe('true'));
    button('创建项目').click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('文件夹已存在'));
    button('添加已有文件夹').click();
    await vi.waitFor(() => expect(button('添加项目')).toBeTruthy()); button('添加项目').click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="created-payload"]')?.textContent).toContain('project.create'));
    expect(JSON.parse(document.querySelector('[data-testid="created-payload"]')!.textContent!)).toEqual({ type: 'project.create', parentId: 'local-parent', name: 'Demo', relativePath: 'apps/demo', mode: 'existing' });
  } finally { dom.window.close(); }
});
it('explains local authorization and disables creation when no parent has been granted', async () => {
  const dom = await fixture();
  try {
    (dom.window.document.querySelector('[aria-label="关闭新建项目"]') as HTMLElement).click();
    await vi.waitFor(() => expect(dom.window.document.querySelector('[aria-label="项目名称"]')).toBeNull());
    (dom.window.document.querySelector('[aria-label="打开未授权表单"]') as HTMLElement).click();
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('新建项目的目录权限'));
    expect(dom.window.document.querySelector('[aria-label="项目名称"]')).toBeNull();
    const submit = [...dom.window.document.querySelectorAll('[role="button"]')].find(item => item.textContent === '创建项目')!;
    expect(submit.getAttribute('aria-disabled')).toBe('true');
  } finally { dom.window.close(); }
});
