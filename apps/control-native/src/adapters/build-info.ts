import {Platform} from 'react-native';
import {boot} from '../bridge';
export const controlVersion=boot.version;
export const controlPlatform=Platform.OS === 'macos' ? 'macOS' : 'Windows';
