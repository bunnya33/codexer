import { expect, it } from 'vitest';
import type { HistoryTurn } from '../packages/protocol/src/index.js';
import { localTaskTime, recordedTurnTiming } from '../packages/client-shared/src/turn-timing.js';

const turn = (values: Partial<HistoryTurn> = {}): HistoryTurn => ({ id: 'timing', status: 'completed', items: [], truncated: false, ...values });

it('uses task timestamps and keeps cross-day records distinct', () => {
  const start = new Date(2026, 9, 23, 23, 59, 50);
  const end = new Date(2026, 9, 24, 0, 1, 10);
  const timing = recordedTurnTiming(turn({ startedAtMs: +start, completedAtMs: +end }), false);
  expect(localTaskTime(timing.start!)).toBe('2026-10-23 23:59:50');
  expect(localTaskTime(timing.end!)).toBe('2026-10-24 00:01:10');
});

it('never substitutes a message timestamp for a missing task timestamp', () => {
  const value = turn({ items: [{ id: 'message', type: 'userMessage', truncated: false, startedAtMs: 2000, completedAtMs: 3000 }] });
  expect(recordedTurnTiming(value, false)).toEqual({ start: undefined, end: undefined });
});

it('hides a stale end while running and reveals it after completion', () => {
  const value = turn({ startedAtMs: 1000, completedAtMs: 2000 });
  expect(recordedTurnTiming(value, true).end).toBeUndefined();
  expect(recordedTurnTiming({ ...value, status: 'inProgress' }, false).end).toBeUndefined();
  expect(recordedTurnTiming(value, false).end?.getTime()).toBe(2000);
});

it('rejects invalid, non-integral and reversed timestamps', () => {
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(recordedTurnTiming(turn({ startedAtMs: value, completedAtMs: value }), false)).toEqual({ start: undefined, end: undefined });
  }
  expect(recordedTurnTiming(turn({ startedAtMs: 2000, completedAtMs: 1000 }), false).end).toBeUndefined();
});
