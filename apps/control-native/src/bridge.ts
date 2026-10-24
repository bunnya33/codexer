import {DeviceEventEmitter, Platform, TurboModuleRegistry} from 'react-native';

type Boot = {mode: 'control'|'agent'; version: string; closeExits: boolean; serverUrl: string};
export const desktop = TurboModuleRegistry.getEnforcing<any>('RelayDesktop');
export const boot: Boot = JSON.parse(desktop.boot());
export async function request<T = unknown>(method: string, value: unknown = {}): Promise<T> {
  try { return JSON.parse(await desktop.request(method, JSON.stringify(value))) as T; }
  catch (value) {
    // React Native Windows rejects native promises with {message, code}, not Error.
    const message = value instanceof Error ? value.message : typeof value === 'string' ? value
      : value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : '本机操作失败，请查看诊断日志。';
    throw new Error(message);
  }
}
export function subscribe(event: string, callback: (value: any) => void) {
  if (Platform.OS === 'macos') {
    const subscription = desktop.onEvent((encoded: string) => {
      const message = JSON.parse(encoded);
      if (message.event === event) callback(message.value);
    });
    return () => subscription.remove();
  }
  const subscription = DeviceEventEmitter.addListener(event, (value: string) => callback(value ? JSON.parse(value) : null));
  return () => subscription.remove();
}
