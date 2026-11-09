import type { ReactNode, RefObject } from 'react';
import type { View } from 'react-native';
import { InteractionSurface } from './surface';

export function ModelSurface({ children, composerAnchor, ...props }: { open: boolean; host: RefObject<View | null>; anchor: RefObject<View | null>; composerAnchor?: RefObject<View | null>; onClose: () => void; children: ReactNode }) {
  return <InteractionSurface {...props} aboveAnchor={composerAnchor} title="模型与推理强度" kind="popover" width={340}>{children}</InteractionSurface>;
}
