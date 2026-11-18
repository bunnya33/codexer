import {Platform} from 'react-native';
import {requireOptionalNativeModule} from 'expo-modules-core';
const messages=Platform.OS==='ios'||Platform.OS==='android'?requireOptionalNativeModule('CodexerMessages'):null;
export function messageHaptic(){try{messages?.haptic();}catch{/* Hardware and system feedback preference are optional. */}}
