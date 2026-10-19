import {DeviceEventEmitter, TurboModuleRegistry} from 'react-native';

type Boot = {mode: 'control'|'agent'; version: string; closeExits: boolean; serverUrl: string};
export const desktop = TurboModuleRegistry.getEnforcing<any>('RelayDesktop');
export const boot: Boot = JSON.parse(desktop.boot());
export async function request<T = unknown>(method: string, value: unknown = {}): Promise<T> {
  return JSON.parse(await desktop.request(method, JSON.stringify(value))) as T;
}
export function subscribe(event: string, callback: (value: any) => void) {
  const subscription = DeviceEventEmitter.addListener(event, (value: string) => callback(value ? JSON.parse(value) : null));
  return () => subscription.remove();
}
