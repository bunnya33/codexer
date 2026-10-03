import { expect, it } from 'vitest';
import { drawerCanStart, drawerOffset, drawerReleaseOpen, drawerWidth } from '../packages/client-shared/src/drawer';

it('keeps a visible part of the conversation and clamps movement at both ends', () => {
  const width = drawerWidth(390);
  expect(width).toBe(312);
  expect(drawerWidth(800)).toBe(390);
  expect(drawerOffset(-80, width)).toBe(0);
  expect(drawerOffset(450, width)).toBe(width);
  expect(drawerOffset(150, width)).toBe(150);
});

it('accepts rightward conversation drags and closing drags without claiming taps or vertical scrolling', () => {
  expect(drawerCanStart(60, 8, 0)).toBe(true);
  expect(drawerCanStart(-60, 8, 240)).toBe(true);
  expect(drawerCanStart(-60, 8, 0)).toBe(false);
  expect(drawerCanStart(5, 0, 0)).toBe(false);
  expect(drawerCanStart(30, 60, 0)).toBe(false);
});

it('commits deliberate opening and closing swipes after a pause, with short drag and flick handling', () => {
  expect(drawerReleaseOpen(64, 312, 0)).toBe(true);
  expect(drawerReleaseOpen(100, 312, 0)).toBe(true);
  expect(drawerReleaseOpen(210, 312, 0)).toBe(true);
  expect(drawerReleaseOpen(30, 312, 0)).toBe(false);
  expect(drawerReleaseOpen(248, 312, 0, true)).toBe(false);
  expect(drawerReleaseOpen(290, 312, 0, true)).toBe(true);
  expect(drawerReleaseOpen(70, 312, 0.8)).toBe(true);
  expect(drawerReleaseOpen(260, 312, -0.8, true)).toBe(false);
  expect(drawerReleaseOpen(200, 312, 0.8)).toBe(true);
  expect(drawerReleaseOpen(120, 312, -0.8, true)).toBe(false);
  expect(drawerReleaseOpen(110, 312, 0, true, 130)).toBe(true);
  expect(drawerReleaseOpen(140, 312, 0, false, 120)).toBe(false);
  expect(drawerReleaseOpen(200, 312, 0, false, 120)).toBe(true);
  expect(drawerReleaseOpen(0, 0, 0)).toBe(false);
});
