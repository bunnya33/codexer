import { createContext } from 'react';

export type DrawerMotion = {
  canStart: (dx: number, dy: number) => boolean;
  begin: () => void;
  move: (dx: number) => void;
  release: (velocity: number) => void;
  cancel: () => void;
};
export const DrawerMotionContext = createContext<DrawerMotion | null>(null);
export const DrawerSwipeBlockContext = createContext<(() => void) | null>(null);
