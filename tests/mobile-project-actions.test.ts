import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
let javascript = '';
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/project-actions.tsx'], outdir: '.local/project-actions-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' }, define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis' } });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
});
async function fixture(mode = '') {
  const dom = new JSDOM('<div id="root"></div>', { url: `https://fixture.test/?mode=${mode}`, runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) { window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia; } });
  dom.window.eval(javascript);
  await vi.waitFor(() => expect(dom.window.document.querySelector('[data-testid="dialog-card"]')).not.toBeNull());
  const button = (label: string) => [...dom.window.document.querySelectorAll('[role="button"]')].find(element => element.textContent === label) as HTMLElement;
  const calls = () => JSON.parse(dom.window.document.querySelector('[data-testid="calls"]')!.textContent!);
  const choose = async () => { button('删除项目').click(); await vi.waitFor(() => expect(button('删除项目，保留目录')).toBeTruthy()); };
  return { dom, button, calls, choose };
}
it('offers creation directly and never invokes deletion when creating a conversation', async () => {
  const { dom, button, calls } = await fixture();
  try { button('新建会话').click(); await vi.waitFor(() => expect(dom.window.document.querySelector('[data-testid="created"]')!.textContent).toBe('true')); expect(calls()).toEqual([]); }
  finally { dom.window.close(); }
});
it.each(['archived', 'offline', 'old'])('disables deletion for %s projects and explains why', async mode => {
  const { dom, button, calls } = await fixture(mode);
  try {
    expect(button('删除项目').getAttribute('aria-disabled')).toBe('true'); button('删除项目').click(); expect(calls()).toEqual([]);
    expect(dom.window.document.body.textContent).toContain(mode === 'archived' ? '含归档' : mode === 'offline' ? '电脑已离线' : '更新此电脑');
  } finally { dom.window.close(); }
});
it('prepares without deleting, then explicitly deletes metadata while retaining the directory', async () => {
  const { dom, button, calls, choose } = await fixture();
  try {
    await choose(); expect(calls()).toEqual([{ type: 'project.delete.prepare', projectId: 'project' }]);
    expect(dom.window.document.body.textContent).toContain('/projects/demo');
    button('删除项目，保留目录').click();
    await vi.waitFor(() => expect(calls()).toHaveLength(2)); expect(calls()[1]).toMatchObject({ type: 'project.delete', projectId: 'project', deleteDirectory: false });
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-testid="dialog-card"]')).toBeNull());
  } finally { dom.window.close(); }
});
it('requires a second directory confirmation and can return or cancel without any deletion', async () => {
  const { dom, button, calls, choose } = await fixture();
  try {
    await choose(); button('连同目录一起删除…').click();
    await vi.waitFor(() => expect(button('永久删除项目和目录')).toBeTruthy());
    expect(dom.window.document.body.textContent).toContain('无法恢复'); expect(calls()).toHaveLength(1);
    button('返回').click(); await vi.waitFor(() => expect(button('取消')).toBeTruthy()); button('取消').click();
    await vi.waitFor(() => expect(dom.window.document.querySelector('[data-testid="dialog-card"]')).toBeNull()); expect(calls()).toHaveLength(1);
  } finally { dom.window.close(); }
});
it('sends the directory deletion flag only after the second explicit confirmation', async () => {
  const { dom, button, calls, choose } = await fixture();
  try {
    await choose(); button('连同目录一起删除…').click(); await vi.waitFor(() => expect(button('永久删除项目和目录')).toBeTruthy());
    button('永久删除项目和目录').click();
    await vi.waitFor(() => expect(calls()).toHaveLength(2)); expect(calls()[1]).toMatchObject({ type: 'project.delete', deleteDirectory: true });
  } finally { dom.window.close(); }
});
it('blocks directory deletion for shared roots while still permitting metadata-only deletion', async () => {
  const { dom, button, calls, choose } = await fixture('protected');
  try {
    await choose(); expect(button('连同目录一起删除…').getAttribute('aria-disabled')).toBe('true'); expect(button('删除项目，保留目录').getAttribute('aria-disabled')).not.toBe('true');
    expect(dom.window.document.body.textContent).toContain('其他项目或会话共用'); button('连同目录一起删除…').click(); expect(calls()).toHaveLength(1);
  } finally { dom.window.close(); }
});
it('disables both deletion choices if an archived conversation arrives during confirmation', async () => {
  const { dom, button, calls, choose } = await fixture();
  try {
    await choose(); button('添加归档会话').click();
    await vi.waitFor(() => expect(button('删除项目，保留目录').getAttribute('aria-disabled')).toBe('true'));
    button('删除项目，保留目录').click(); expect(calls()).toHaveLength(1); expect(dom.window.document.body.textContent).toContain('项目中仍有会话');
  } finally { dom.window.close(); }
});
it.each(['stale', 'partial'])('shows the actual %s outcome without retrying a destructive operation', async mode => {
  const { dom, button, calls, choose } = await fixture(mode);
  try {
    await choose(); button('连同目录一起删除…').click(); await vi.waitFor(() => expect(button('永久删除项目和目录')).toBeTruthy()); button('永久删除项目和目录').click();
    await vi.waitFor(() => expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain(mode === 'stale' ? '确认信息已变化' : '目录未能全部删除'));
    expect(calls()).toHaveLength(2); expect(mode === 'stale' ? button('删除项目') : button('完成')).toBeTruthy();
  } finally { dom.window.close(); }
});
