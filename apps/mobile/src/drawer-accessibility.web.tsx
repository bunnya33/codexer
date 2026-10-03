import type { ReactNode } from 'react';

export function DrawerAccessibility({ active, children }: { active: boolean; children: ReactNode }) {
  return <div inert={!active} aria-hidden={!active} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, pointerEvents: active ? 'auto' : 'none' }}>{children}</div>;
}
