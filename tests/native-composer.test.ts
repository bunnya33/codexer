import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let javascript = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { ComposerInput } from './apps/mobile/src/composer';
    const root = createRoot(document.getElementById('root'));
    window.sizes = [];
    window.renderComposer = (value = '', platform = 'ios', height = 844) => {
      window.platform = platform; window.windowHeight = height;
      flushSync(() => root.render(<ComposerInput value={value} multiline imagesEnabled={false}
        onImages={() => {}} onImageError={() => {}} onContentSizeChange={event => window.sizes.push(event.nativeEvent.contentSize.height)} />));
    };
    window.contentSize = height => flushSync(() => window.editor.onContentSizeChange({ nativeEvent: { contentSize: { height, width: 200 } } }));
    window.renderComposer();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'native-input-fixture', setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'native', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'jsx', resolveDir: process.cwd(), contents: `
        import React from 'react';
        export const Platform = { get OS() { return window.platform; } };
        export const useWindowDimensions = () => ({ height: window.windowHeight, width: 390 });
        export function TextInput(props) { window.editor = props; return <textarea value={props.value} readOnly />; }
      ` }));
    } }] });
  javascript = result.outputFiles[0]!.text;
});

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.eval(javascript);
  const window = dom.window as unknown as { editor: { style: object[]; scrollEnabled: boolean; submitKeyEvents?: unknown }; sizes: number[]; renderComposer: (value?: string, platform?: string, height?: number) => void; contentSize: (height: number) => void };
  return { dom, window, style: () => Object.assign({}, ...window.editor.style) };
}

it('leaves iOS text layout free to grow and keeps caret scrolling enabled before any size callback', () => {
  const { dom, window, style } = fixture();
  try {
    for (const value of ['', '中'.repeat(200), '第一行\n第二行\n', '短句']) {
      window.renderComposer(value);
      expect(style()).toMatchObject({ height: undefined, minHeight: 42, maxHeight: 211 });
      expect(window.editor.scrollEnabled).toBe(true);
    }
    expect(window.sizes).toEqual([]);
    window.contentSize(900);
    expect(style().height).toBeUndefined();
    expect(window.editor.scrollEnabled).toBe(true);
    expect(window.sizes).toEqual([900]);
  } finally { dom.window.close(); }
});

it.each(['android', 'windows'])('keeps measured growth, overflow scrolling and draft clearing on %s', async platform => {
  const { dom, window, style } = fixture();
  try {
    window.renderComposer('draft', platform);
    window.contentSize(64);
    expect(style().height).toBe(64);
    expect(window.editor.scrollEnabled).toBe(false);
    window.contentSize(500);
    expect(style().height).toBe(211);
    expect(window.editor.scrollEnabled).toBe(true);
    window.renderComposer('', platform);
    await vi.waitFor(() => expect(style().height).toBe(42));
    expect(window.editor.scrollEnabled).toBe(false);
    if (platform === 'windows') expect(window.editor.submitKeyEvents).toEqual([{ code: 'Enter' }]);
  } finally { dom.window.close(); }
});
