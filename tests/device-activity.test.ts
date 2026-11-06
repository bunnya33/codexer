import { expect, it } from 'vitest';
import { deviceHasRunningTasks } from '../packages/client-shared/src/device-activity.js';
import { reduceEvent } from '../packages/protocol/src/index.js';
import { event, snapshot } from './helpers.js';

const device = { id: 'device-test', online: true };

it('keeps the device active until every running conversation has finished', () => {
  let state = snapshot();
  const first = state.threads['thread-test']!;
  state.threads.second = { ...first, id: 'second' };
  expect(deviceHasRunningTasks(device, state)).toBe(true);
  state = reduceEvent(state, { ...event(state), change: { type: 'thread.updated', thread: { ...first, status: 'idle', activeTurnId: null } } });
  expect(deviceHasRunningTasks(device, state)).toBe(true);
  state = reduceEvent(state, { ...event(state), change: { type: 'thread.updated', thread: { ...state.threads.second!, status: 'idle', activeTurnId: null } } });
  expect(deviceHasRunningTasks(device, state)).toBe(false);
});

it('ignores cached activity from an offline device, disconnected runtime or another device', () => {
  const state = snapshot();
  expect(deviceHasRunningTasks({ ...device, online: false }, state)).toBe(false);
  expect(deviceHasRunningTasks(device, { ...state, runtime: { ...state.runtime, connected: false } })).toBe(false);
  expect(deviceHasRunningTasks({ id: 'another-device', online: true }, state)).toBe(false);
  expect(deviceHasRunningTasks(device)).toBe(false);
});

it('does not treat queued work or non-active conversations as running tasks', () => {
  const state = snapshot();
  const thread = state.threads['thread-test']!;
  thread.queuedMessages = [{ id: 'queued', text: 'next task', imageCount: 0, createdAt: 1, status: 'queued' }];
  for (const status of ['notLoaded', 'idle', 'systemError', 'unavailable'] as const) {
    thread.status = status;
    expect(deviceHasRunningTasks(device, state)).toBe(false);
  }
});
