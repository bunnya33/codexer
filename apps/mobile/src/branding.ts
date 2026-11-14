import { Platform } from 'react-native';

export const appDisplayName = ['ios', 'android'].includes(Platform.OS) ? 'FrogCoder' : 'Codexer';
