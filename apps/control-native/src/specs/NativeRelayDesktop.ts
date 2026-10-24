import type {TurboModule, CodegenTypes} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

export interface Spec extends TurboModule {
  boot(): string;
  randomId(): string;
  request(method: string, payload: string): Promise<string>;
  readonly onEvent: CodegenTypes.EventEmitter<string>;
}
export default TurboModuleRegistry.getEnforcing<Spec>('RelayDesktop');
