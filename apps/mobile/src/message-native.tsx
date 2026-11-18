import {requireOptionalNativeModule,requireNativeViewManager} from 'expo-modules-core';
import {Platform} from 'react-native';
import type {ComponentType} from 'react';
import type {NativeMessageProps} from './message-native-types';

const mobile=Platform.OS==='ios'||Platform.OS==='android';
const module=mobile?requireOptionalNativeModule('CodexerMessages'):null;
export const NativeMessageText:ComponentType<NativeMessageProps>|null=module?requireNativeViewManager('CodexerMessages'):null;
