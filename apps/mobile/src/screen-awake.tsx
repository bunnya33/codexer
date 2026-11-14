import type { ReactNode } from 'react';

export const screenAwakeAvailable = false;
export function ScreenAwakeProvider({ children }: { children: ReactNode }) { return children; }
export function ScreenAwakeSettings() { return null; }
