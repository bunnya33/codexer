import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal, View } from 'react-native';
import { InteractionSurface } from './interaction/surface';

/** A separate scroll surface keeps the underlying conversation at its existing anchor. */
export function ReviewReader({ open, onClose, title, children, onBack }: { open: boolean; onClose: () => void; title: string; children: ReactNode; onBack?: () => void }) {
  const host = useRef<View>(null), [mounted, setMounted] = useState(open);
  useEffect(() => { if (open) setMounted(true); }, [open]);
  return <Modal visible={open || mounted} transparent animationType="none" onRequestClose={onBack ?? onClose}>
    <View ref={host} collapsable={false} style={{ flex: 1 }}>
      <InteractionSurface open={open} onClose={onClose} onBack={onBack} onClosed={() => setMounted(false)} host={host} title={title} kind="reader">{children}</InteractionSurface>
    </View>
  </Modal>;
}
