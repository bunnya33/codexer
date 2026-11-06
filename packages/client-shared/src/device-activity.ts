import type { DeviceSnapshot } from '../../protocol/src/index.js';

export function deviceHasRunningTasks(device: { id: string; online: boolean }, snapshot?: DeviceSnapshot): boolean {
  return device.online && snapshot?.deviceId === device.id && snapshot.runtime.connected
    && Object.values(snapshot.threads).some(thread => thread.status === 'active');
}
