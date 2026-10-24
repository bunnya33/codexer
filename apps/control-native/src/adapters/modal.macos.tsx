import React, {useContext, useId, useLayoutEffect, useRef} from 'react';
import {View, useWindowDimensions} from 'react-native';
import type {ModalProps} from 'react-native';
import {FileLinkContext} from '../../../mobile/src/file-link-context';
import {PreviewContext} from '../../../mobile/src/preview-context';
import {DrawerMotionContext, DrawerSwipeBlockContext} from '../../../mobile/src/drawer-context';
import {useModalHost} from './modal-host.macos';

export function useModalDimensions() {return useWindowDimensions();}

// RN macOS 0.83 has no ModalHostView implementation under Fabric. Render the
// same shared dialog content as native views above the main window instead.
export default function Modal({children, visible = true, onShow, onDismiss, onRequestClose, transparent, testID}: ModalProps) {
  const host = useModalHost();
  const id = useId();
  const shown = useRef(false);
  const callbacks = useRef({onShow, onDismiss, onRequestClose});
  callbacks.current = {onShow, onDismiss, onRequestClose};
  const fileLink = useContext(FileLinkContext), preview = useContext(PreviewContext);
  const motion = useContext(DrawerMotionContext), block = useContext(DrawerSwipeBlockContext);
  useLayoutEffect(() => {
    if (!host || !visible) {host?.remove(id);return;}
    host.put({id, close: () => callbacks.current.onRequestClose?.({} as never), content:
      <FileLinkContext.Provider value={fileLink}><PreviewContext.Provider value={preview}>
        <DrawerMotionContext.Provider value={motion}><DrawerSwipeBlockContext.Provider value={block}>
          <View testID={testID} style={{flex: 1, backgroundColor: transparent ? 'transparent' : '#fff'}}>
            {children}
          </View>
        </DrawerSwipeBlockContext.Provider></DrawerMotionContext.Provider>
      </PreviewContext.Provider></FileLinkContext.Provider>});
  }, [host, id, visible, children, transparent, testID, fileLink, preview, motion, block]);
  useLayoutEffect(() => {
    if (!visible || !host) return;
    const frame = requestAnimationFrame(() => {shown.current = true;callbacks.current.onShow?.({} as never);});
    return () => {cancelAnimationFrame(frame);host.remove(id);if(shown.current){shown.current=false;callbacks.current.onDismiss?.();}};
  }, [host, id, visible]);
  return null;
}
