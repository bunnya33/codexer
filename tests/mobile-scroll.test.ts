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

async function conversationFixture() {
  const dom = await fixture();
  (dom.window.document.querySelector('[aria-label="关闭会话列表"]') as HTMLElement).click();
  await vi.waitFor(() => expect(dom.window.document.querySelector('[aria-label="返回会话"]')).toBeNull());
  return dom;
}

it('keeps following after downward wheel and keyboard input at the bottom without a scroll event', async () => {
  const dom = await conversationFixture();
  try {
    const { window } = dom, document = window.document;
    const message = document.querySelector('[data-testid="conversation-stream"] [dir="auto"]')!;
    const following = async (expected: boolean) => vi.waitFor(() => expect(document.querySelector('[data-testid="following"]')!.textContent).toBe(`自动跟随：${expected}`));
    message.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: 80 }));
    (document.querySelector('[aria-label="模拟预览高度更新"]') as HTMLElement).click();
    await following(true);
    for (const key of ['ArrowDown', 'PageDown', 'End', ' ']) message.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key }));
    await following(true);
    message.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -40 }));
    await following(false);
    message.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: 80 }));
    await following(true);
    message.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: ' ', shiftKey: true }));
    await following(false);
  } finally { dom.window.close(); }
});

it('ignores zoom, horizontal motion, text editing and nested scrolling until it reaches the outer stream', async () => {
  const dom = await conversationFixture();
  try {
    const { window } = dom, document = window.document;
    const stream = document.querySelector('[data-testid="conversation-stream"]')!;
    const nested = document.createElement('div');
    nested.style.overflowY = 'auto';
    Object.defineProperties(nested, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    nested.scrollTop = 100;
    stream.append(nested);
    const wheel = (target: Element, deltaY: number, extra = {}) => target.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY, ...extra }));
    wheel(nested, -40);
    wheel(nested, 40);
    wheel(stream, -40, { ctrlKey: true });
    wheel(stream, -10, { deltaX: 80 });
    const input = document.createElement('textarea');
    stream.append(input);
    wheel(input, -40);
    input.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    expect(document.querySelector('[data-testid="scroll-intents"]')!.textContent).toBe('滚动意图：0');
    expect(document.querySelector('[data-testid="following"]')!.textContent).toBe('自动跟随：true');
    nested.scrollTop = 0;
    wheel(nested, -40);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="following"]')!.textContent).toBe('自动跟随：false'));
  } finally { dom.window.close(); }
});

it('tracks reversals in a vertical touch gesture without pausing on a downward page gesture at the bottom', async () => {
  const dom = await conversationFixture();
  try {
    const { window } = dom, document = window.document;
    const message = document.querySelector('[data-testid="conversation-stream"] [dir="auto"]')!;
    const touch = (type: string, y: number) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { touches: [{ identifier: 1, clientX: 50, clientY: y }] });
      message.dispatchEvent(event);
    };
    touch('touchstart', 250);
    touch('touchmove', 120);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="scroll-intents"]')!.textContent).toBe('滚动意图：1'));
    expect(document.querySelector('[data-testid="following"]')!.textContent).toBe('自动跟随：true');
    touch('touchmove', 150);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="following"]')!.textContent).toBe('自动跟随：false'));
    touch('touchmove', 130);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="following"]')!.textContent).toBe('自动跟随：true'));
  } finally { dom.window.close(); }
});

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
    expect(touch('touchmove', 45, 390)).toBe(false);
    expect(touch('touchend', 45, 390)).toBe(false);
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
