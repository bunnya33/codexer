import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

let javascript = '';
beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { EffortSlider } from './apps/mobile/src/effort-slider';
    const root = createRoot(document.getElementById('root'));
    const calls = window.calls = { changes: [], commits: [] };
    window.renderSlider = (value = 2, disabled = false, labels = ['low','medium','high','xhigh','max','ultra']) => flushSync(() => root.render(
      <EffortSlider labels={labels} value={value} disabled={disabled}
        onChange={index => calls.changes.push(index)} onCommit={index => calls.commits.push(index)} />));
    window.renderSlider();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'native-view-fixture', setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'native', namespace: 'fixture' }));
      builder.onResolve({ filter: /^\.\/styles$/ }, args => args.importer.endsWith('effort-slider.tsx') ? { path: 'theme', namespace: 'fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path === 'theme'
        ? `export const useTheme = () => ({ c: { slider: '#333', sliderTrack: '#ddd', sliderDot: '#999', sliderSelectedDot: '#fff', thumb: '#fff', thumbBorder: '#ccc' } });`
        : `import React from 'react'; export const StyleSheet = { create: x => x, absoluteFill: {} };
           export function View(props) { if (props.accessibilityRole === 'adjustable') window.slider = props; return <div>{props.children}</div>; }` }));
    } }] });
  javascript = result.outputFiles[0]!.text;
});

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.eval(javascript);
  const w = dom.window as any;
  w.slider.onLayout({ nativeEvent: { layout: { width: 240 } } });
  // Flush the measured width before dispatching native responder events.
  w.renderSlider();
  return { w, close: () => dom.window.close(), at: (x: number) => ({ nativeEvent: { locationX: x } }) };
}

it('previews drag steps and commits only the final step on release', () => {
  const f = fixture();
  try {
    expect(f.w.slider.onStartShouldSetResponder()).toBe(true);
    f.w.slider.onResponderGrant(f.at(20));
    f.w.slider.onResponderMove(f.at(100));
    f.w.slider.onResponderRelease(f.at(220));
    expect(f.w.calls.changes).toEqual([0, 2, 5]);
    expect(f.w.calls.commits).toEqual([5]);
  } finally { f.close(); }
});

it('clamps taps to endpoint values and restores preview when a gesture is cancelled', () => {
  const f = fixture();
  try {
    f.w.slider.onResponderGrant(f.at(-100));
    f.w.slider.onResponderTerminate();
    expect(f.w.calls.changes).toEqual([0, 2]);
    expect(f.w.calls.commits).toEqual([]);
    f.w.slider.onResponderGrant(f.at(500));
    f.w.slider.onResponderRelease(f.at(500));
    expect(f.w.calls.commits).toEqual([5]);
  } finally { f.close(); }
});

it('disables gestures and accessibility changes while saving or with a single effort', () => {
  const f = fixture();
  try {
    for (const args of [[2, true], [0, false, ['high']]]) {
      f.w.renderSlider(...args);
      expect(f.w.slider.onStartShouldSetResponder()).toBe(false);
      f.w.slider.onResponderGrant(f.at(200));
      f.w.slider.onResponderRelease(f.at(200));
      f.w.slider.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    }
    expect(f.w.calls.changes).toEqual([]);
    expect(f.w.calls.commits).toEqual([]);
  } finally { f.close(); }
});

it('supports bounded accessibility increments and decrements', () => {
  const f = fixture();
  try {
    f.w.slider.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    f.w.renderSlider(5);
    f.w.slider.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    f.w.slider.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } });
    expect(f.w.calls.changes).toEqual([3, 4]);
    expect(f.w.calls.commits).toEqual([3, 4]);
  } finally { f.close(); }
});
