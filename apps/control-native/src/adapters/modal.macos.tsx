import React from 'react';
import {Dimensions, View, useWindowDimensions} from 'react-native';
import type {ModalProps} from 'react-native';
// Bypass our Metro alias to use React Native macOS's native AppKit modal.
// @ts-expect-error Internal platform component has no TypeScript declaration.
import NativeModal from 'react-native-macos/Libraries/Modal/Modal';
export function useModalDimensions() {
  const viewport=useWindowDimensions(), screen=Dimensions.get('screen');
  return {width:Math.min(viewport.width,Math.floor(screen.width*.85)),height:Math.min(viewport.height,Math.floor(screen.height*.8))};
}
export default function Modal({children,...props}:ModalProps) {
  return <NativeModal {...props}><View style={useModalDimensions()}>{children}</View></NativeModal>;
}
