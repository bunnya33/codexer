import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Modal, View } from 'react-native';
import { InteractionSurface } from './interaction/surface';

/** A separate scroll surface keeps the underlying conversation at its existing anchor. */
export function ReviewReader({ open, onClose, title, children, onBack, origin, onClosed, desktopWidth = 1040 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; onBack?: () => void; origin?:RefObject<View|null>; onClosed?:()=>void; desktopWidth?:number }) {
  const host = useRef<View>(null), [mounted, setMounted] = useState(open);
  useEffect(() => { if (open) setMounted(true); }, [open]);
  return <Modal visible={open || mounted} transparent animationType="none" onRequestClose={onBack ?? onClose}>
    <View ref={host} collapsable={false} style={{ flex: 1 }}>
      <InteractionSurface open={open} onClose={onClose} onBack={onBack} onClosed={() => {setMounted(false);onClosed?.();}} host={host} origin={origin} title={title} kind="reader" readerWidth={desktopWidth}>{children}</InteractionSurface>
    </View>
  </Modal>;
}
