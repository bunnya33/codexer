import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

let javascript = '', css = '';
beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/fixtures/mobile-scroll.tsx'], outdir: '.local/mobile-scroll', write: false,
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
    nodePaths: [resolve('apps/mobile/node_modules')], alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'globalThis' },
  });
  javascript = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
  css = result.outputFiles!.find(file => file.path.endsWith('.css'))!.text;
});

async function fixture() {
  const dom = new JSDOM(`<style>${css}</style><div id="root"></div>`, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    },
  });
  Object.defineProperties(dom.window.document.documentElement, {
    clientWidth: { value: 390 }, clientHeight: { value: 844 },
  });
  dom.window.eval(javascript);
  await vi.waitFor(() => expect(dom.window.document.querySelector('[data-testid="directory-threads-work"]')).not.toBeNull());
  return dom;
}

it('restores conversation interaction after selecting a project conversation', async () => {
  const dom = await fixture();
  try {
    const { document } = dom.window;
    const project = document.querySelector('[data-testid="directory-threads-work"]')!;
    const row = [...project.querySelectorAll('[role="button"]')].find(element => element.textContent === '会话 0')!;
    expect(row).toBeTruthy();
    (row as HTMLElement).click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="返回会话"]')).toBeNull());
    expect(document.querySelector('[data-testid="conversation-card"] [inert]')).toBeNull();
  } finally { dom.window.close(); }
});

it('leaves vertical message gestures unclaimed while horizontal gestures open the drawer', async () => {
  const dom = await fixture();
  try {
    const { window } = dom;
    const document = window.document;
    (document.querySelector('[aria-label="关闭会话列表"]') as HTMLElement).click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="返回会话"]')).toBeNull());
    const message = document.querySelector('[data-testid="conversation-stream"]')!.querySelector('[dir="auto"]')!;
    const touch = (type: string, x: number, y: number) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      const point = { identifier: 1, clientX: x, clientY: y };
      Object.assign(event, { touches: type === 'touchend' ? [] : [point], changedTouches: [point] });
      message.dispatchEvent(event);
      return event.defaultPrevented;
    };
    touch('touchstart', 40, 250);
    expect(touch('touchmove', 45, 120)).toBe(false);
    expect(touch('touchend', 45, 120)).toBe(false);
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    expect(document.querySelector('[data-testid="scroll-intents"]')!.textContent).toBe('滚动意图：1');
    expect(document.querySelector('[aria-label="返回会话"]')).toBeNull();
    (document.querySelector('[aria-label="模拟预览高度更新"]') as HTMLElement).click();
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    expect(document.querySelector('[data-testid="following"]')!.textContent).toBe('自动跟随：false');
    touch('touchstart', 40, 250);
    expect(touch('touchmove', 170, 255)).toBe(true);
    expect(touch('touchend', 170, 255)).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="conversation-directory"]')!.getAttribute('aria-hidden')).not.toBe('true'));
  } finally { dom.window.close(); }
});
