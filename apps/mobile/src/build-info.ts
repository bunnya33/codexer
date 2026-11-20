import serverPackage from '../../../package.json';
import mobilePackage from '../package.json';
import { Platform } from 'react-native';
import { installedAndroidBuild } from './installed-android-build';

// The bundled version stays with the loaded page, including a stale browser tab.
export const controlVersion = Platform.OS === 'web' ? serverPackage.version
  : Platform.OS === 'android' ? installedAndroidBuild.version : mobilePackage.version;
export const controlPlatform = Platform.OS === 'web' ? '网页' : Platform.OS === 'ios' ? 'iOS' : 'Android';
