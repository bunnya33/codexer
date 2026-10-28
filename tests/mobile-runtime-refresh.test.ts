import {beforeAll, expect, it, vi} from 'vitest';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {resolve} from 'node:path';
let javascript = '';
beforeAll(async () => {
  const result = await build({entryPoints: ['tests/fixtures/runtime-refresh.tsx'], outdir: '.local/runtime-refresh-tests', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'], nodePaths: [resolve('apps/mobile/node_modules')], alias: {'react-native': 'react-native-web'}, define: {'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis'}});
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
});
async function fixture(mode: string) {
  const confirm = vi.fn(() => mode !== 'cancel');
  const dom = new JSDOM('<div id="root"></div>', {url: `https://fixture.test/?mode=${mode}`, runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(window) {window.confirm = confirm; window.matchMedia = (() => ({matches: false, addListener() {}, removeListener() {}})) as unknown as typeof window.matchMedia;}});
  dom.window.eval(javascript);
  await vi.waitFor(() => expect(dom.window.document.querySelector('[aria-label="刷新 Codex 运行时"]')).not.toBeNull());
  const button = dom.window.document.querySelector('[aria-label="刷新 Codex 运行时"]') as HTMLElement;
  const calls = () => JSON.parse(dom.window.document.querySelector('[data-testid="calls"]')!.textContent!);
  return {dom, button, calls, confirm};
}
it.each(['offline', 'old'])('blocks remote refresh for an %s device', async mode => {
  const {dom, button, calls, confirm} = await fixture(mode);
  try {expect(button.getAttribute('aria-disabled')).toBe('true'); button.click(); expect(calls()).toEqual([]); expect(confirm).not.toHaveBeenCalled();}
  finally {dom.window.close();}
});
it('does not dispatch after cancellation', async () => {
  const {dom, button, calls, confirm} = await fixture('cancel');
  try {button.click(); await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce()); expect(confirm.mock.calls[0]).toEqual([expect.stringContaining('Chosen PC')]); expect(calls()).toEqual([]);}
  finally {dom.window.close();}
});
it.each([['success', 'Codex 运行时已刷新'], ['deferred', '已安排'], ['failure', '刷新未完成'], ['unknown', '刷新结果未确认']])('shows the confirmed %s result and targets only the selected device', async (mode, text) => {
  const {dom, button, calls} = await fixture(mode!);
  try {
    button.click(); button.click();
    await vi.waitFor(() => expect(dom.window.document.body.textContent).toContain(text));
    expect(calls()).toEqual([{deviceId: 'chosen-device', payload: {type: 'runtime.refresh'}}]);
  } finally {dom.window.close();}
});
