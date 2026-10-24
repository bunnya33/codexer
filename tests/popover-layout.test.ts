import { expect, it } from 'vitest';
import { popoverLayout } from '../apps/mobile/src/popover-layout';

const insets = { top: 24, bottom: 24, left: 0, right: 0 };
const anchor = { x: 230, y: 700, width: 140, height: 32 };

it('aligns a composer menu above its button with room for the system bars', () => {
  const layout = popoverLayout(anchor, { width: 390, height: 844 }, 304, 156, insets, 'end');
  expect(layout).toMatchObject({ left: 66, top: 536, width: 304 });
  expect(layout.top + 156).toBe(anchor.y - 8);
});

it('falls below a button when the full model list cannot fit above it', () => {
  const layout = popoverLayout({ ...anchor, y: 80 }, { width: 390, height: 844 }, 320, 390, insets, 'end');
  expect(layout.top).toBe(120);
  expect(layout.left).toBe(50);
  expect(layout.maxHeight).toBe(688);
});

it.each([
  { viewport: { width: 280, height: 400 }, anchor, height: 900, safe: insets },
  { viewport: { width: 844, height: 390 }, anchor: { ...anchor, x: -10, y: 230 }, height: 600, safe: { ...insets, left: 44, right: 44 } },
  { viewport: { width: 390, height: 360 }, anchor: { ...anchor, y: 290 }, height: 390, safe: insets },
])('keeps large lists inside a narrow, rotated or keyboard-reduced viewport ($viewport)', ({ viewport, anchor, height, safe }) => {
  const layout = popoverLayout(anchor, viewport, 320, height, safe, 'start');
  expect(layout.left).toBeGreaterThanOrEqual(safe.left + 12);
  expect(layout.left + layout.width).toBeLessThanOrEqual(viewport.width - safe.right - 12);
  expect(layout.top).toBeGreaterThanOrEqual(safe.top + 12);
  expect(layout.top + Math.min(height, layout.maxHeight)).toBeLessThanOrEqual(viewport.height - safe.bottom - 12);
});
