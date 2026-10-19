import React from 'react';
import {Dimensions,View,useWindowDimensions} from 'react-native';
import type {ModalProps} from 'react-native';
import {useControlTheme} from '../../../mobile/src/theme';
import {applyTheme} from './theme-platform';
// Use RNW's actual native window; the Metro adapter excludes this import.
// @ts-expect-error Internal RNW component has no TypeScript declaration.
import NativeModal from 'react-native-windows/Libraries/Modal/Modal.windows';

export function useModalDimensions(){
  const viewport=useWindowDimensions();
  const screen=Dimensions.get('screen');
  return {width:Math.min(viewport.width,Math.floor(screen.width*.85)),height:Math.min(viewport.height,Math.floor(screen.height*.8))};
}

export default function Modal({children,onShow,...props}:ModalProps){
  const size=useModalDimensions();
  const {theme}=useControlTheme();
  // RNW sizes native modal windows to their content. A flex-only overlay has
  // no intrinsic width and otherwise collapses to the 100 px window minimum.
  return <NativeModal {...props} onShow={(event: Parameters<NonNullable<ModalProps['onShow']>>[0])=>{applyTheme(theme);onShow?.(event);}}><View style={size}>{children}</View></NativeModal>;
}
