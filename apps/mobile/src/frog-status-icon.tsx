import { Image } from 'react-native';
import type { DeviceActivityStatus } from '../../../packages/client-shared/src/device-activity';

const images = {
  offline: require('../assets/frogcoder-status-offline.png'),
  idle: require('../assets/frogcoder-status-idle.png'),
  running: require('../assets/frogcoder-status-running.png'),
};
const labels = { offline: '没有设备在线', idle: '在线设备空闲', running: '有设备正在运行任务' };

export function FrogStatusIcon({ status }: { status: DeviceActivityStatus }) {
  return <Image testID="frog-device-status" source={images[status]} accessibilityLabel={labels[status]} accessible resizeMode="contain" style={{ width: 42, height: 42 }} />;
}
