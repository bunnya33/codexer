import { expect, it } from 'vitest';
import { deviceHasRunningTasks, deviceRunningTaskCount, devicesActivityStatus } from '../packages/client-shared/src/device-activity.js';
import { reduceEvent } from '../packages/protocol/src/index.js';
import { event, snapshot } from './helpers.js';

const device = { id: 'device-test', online: true };

it('aggregates activity across every online device and ignores stale offline work', () => {
  const running = snapshot();
  const idle = { ...snapshot(), deviceId: 'idle-device', threads: {} };
  const devices = [{ id: 'idle-device', online: true }, device];
  const snapshots = { [running.deviceId]: running, [idle.deviceId]: idle };
  expect(devicesActivityStatus([], snapshots)).toBe('offline');
  expect(devicesActivityStatus(devices, snapshots)).toBe('running');
  expect(devicesActivityStatus([...devices].reverse(), snapshots)).toBe('running');
  expect(devicesActivityStatus([devices[0]!, { ...device, online: false }], snapshots)).toBe('idle');
  expect(devicesActivityStatus(devices.map(value => ({ ...value, online: false })), snapshots)).toBe('offline');
  expect(devicesActivityStatus(devices, {})).toBe('idle');
  running.runtime.connected = false;
  expect(devicesActivityStatus(devices, snapshots)).toBe('idle');
});

it('keeps the device active until every running conversation has finished', () => {
  let state = snapshot();
  const first = state.threads['thread-test']!;
  state.threads.second = { ...first, id: 'second' };
  expect(deviceRunningTaskCount(device, state)).toBe(2);
  expect(deviceHasRunningTasks(device, state)).toBe(true);
  state = reduceEvent(state, { ...event(state), change: { type: 'thread.updated', thread: { ...first, status: 'idle', activeTurnId: null } } });
  expect(deviceRunningTaskCount(device, state)).toBe(1);
  expect(deviceHasRunningTasks(device, state)).toBe(true);
  state = reduceEvent(state, { ...event(state), change: { type: 'thread.updated', thread: { ...state.threads.second!, status: 'idle', activeTurnId: null } } });
  expect(deviceRunningTaskCount(device, state)).toBe(0);
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
