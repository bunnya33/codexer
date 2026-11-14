import type { DeviceSnapshot } from '../../protocol/src/index.js';

export type DeviceActivityStatus = 'offline' | 'idle' | 'running';

export function devicesActivityStatus(devices: readonly { id: string; online: boolean }[], snapshots: Readonly<Record<string, DeviceSnapshot>>): DeviceActivityStatus {
  const online = devices.filter(device => device.online);
  if (!online.length) return 'offline';
  return online.some(device => deviceHasRunningTasks(device, snapshots[device.id])) ? 'running' : 'idle';
}

export function deviceHasRunningTasks(device: { id: string; online: boolean }, snapshot?: DeviceSnapshot): boolean {
  return deviceRunningTaskCount(device, snapshot) > 0;
}

export function deviceRunningTaskCount(device: { id: string; online: boolean }, snapshot?: DeviceSnapshot): number {
  if (!device.online || snapshot?.deviceId !== device.id || !snapshot.runtime.connected) return 0;
  return Object.values(snapshot.threads).filter(thread => thread.status === 'active').length;
}
