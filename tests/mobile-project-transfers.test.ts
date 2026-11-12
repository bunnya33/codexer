import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
let javascript = '';
beforeAll(async () => {
  const result = await build({entryPoints: ['tests/fixtures/project-transfers.tsx'], outdir: '.local/project-transfer-ui-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: {'react-native': 'react-native-web'}, define: {'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis'}});
  javascript = result.outputFiles!.find(f => f.path.endsWith('.js'))!.text;
});
async function fixture(mode = '') {
  const dom = new JSDOM('<div id="root"></div>', {url: `https://fixture.test/?mode=${mode}`, runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {window.matchMedia = (() => ({matches: false, addListener() {}, removeListener() {}})) as any;}});
  dom.window.eval(javascript);
  const button = (text: string) => [...dom.window.document.querySelectorAll('[role="button"]')].find(el => el.textContent === text) as HTMLElement;
  const calls = () => (dom.window as any).transferCalls as any[];
  await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('接收设备会先保存项目'));
  return {dom, button, calls};
}
it('prepares a snapshot without sending it or starting development', async () => {
  const {dom, button, calls} = await fixture();
  try {
    const target = dom.window.document.querySelector('[role="radio"]') as HTMLElement; target.click();
    await vi.waitFor(() => expect(button('生成快照并预览').getAttribute('aria-disabled')).not.toBe('true'));
    button('生成快照并预览').click();
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('等待源设备空闲并生成快照'));
    expect(calls()).toHaveLength(1); expect(calls()[0].prepare.targetDeviceId).toBe('target');
    expect(calls()[0].prepare.options.includeGit).toBe(true); expect(calls()[0].prepare.options.includeLocalFiles).toBe(false);
    expect(calls()[0].prepare.relativePath).toBe('Demo');
    expect(button('确认发送')).toBeUndefined();
  } finally {dom.window.close();}
});
it('requires explicit confirmation and keeps a background transfer when the dialog closes', async () => {
  const {dom, button, calls} = await fixture('ready');
  try {
    await vi.waitFor(() => expect(button('确认发送')).toBeTruthy()); expect(calls()).toHaveLength(0);
    expect(dom.window.document.body.textContent).toContain('node_modules'); expect(dom.window.document.body.textContent).toContain('F:/Projects/demo');
    button('确认发送').click(); await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('正在发送到服务器'));
    (dom.window.document.querySelector('[aria-label="关闭发送项目 · Demo"]') as HTMLElement).click();
    await vi.waitFor(() => expect(button('确认发送')).toBeUndefined());
    button('重新打开').click(); await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('正在发送到服务器'));
    expect(calls()).toEqual([{id: '58c099d1-d461-489e-87ae-c55aa8406355', action: 'start'}]);
  } finally {dom.window.close();}
});
it('shows a received project and leaves later development to the user', async () => {
  const {dom, button, calls} = await fixture('received');
  try {
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('F:/Projects/demo'));
    expect(dom.window.document.body.textContent).toContain('随时切换到该设备');
    expect(button('确认发送')).toBeUndefined(); expect(button('取消传输')).toBeUndefined(); expect(calls()).toHaveLength(0);
  } finally {dom.window.close();}
});
it('disables creation for an offline destination', async () => {
  const {dom, button, calls} = await fixture('offline');
  try {
    (dom.window.document.querySelector('[role="radio"]') as HTMLElement).click();
    await vi.waitFor(() => expect(button('生成快照并预览')).toBeTruthy());
    expect(button('生成快照并预览').getAttribute('aria-disabled')).toBe('true'); button('生成快照并预览').click(); expect(calls()).toHaveLength(0);
  } finally {dom.window.close();}
});
it('starts a fresh transfer after cancelling a confirmed preparation', async () => {
  const {dom, button, calls} = await fixture();
  try {
    (dom.window.document.querySelector('[role="radio"]') as HTMLElement).click();
    await vi.waitFor(() => expect(button('生成快照并预览').getAttribute('aria-disabled')).not.toBe('true'));
    button('生成快照并预览').click(); await vi.waitFor(() => expect(button('取消传输')).toBeTruthy());
    button('取消传输').click(); await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain('已取消'));
    button('返回传输列表').click(); await vi.waitFor(() => expect(button('生成快照并预览')).toBeTruthy());
    button('生成快照并预览').click(); await vi.waitFor(() => expect(calls()).toHaveLength(3));
    expect(calls()[0].prepare.id).not.toBe(calls()[2].prepare.id);
  } finally {dom.window.close();}
});
