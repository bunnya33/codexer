export const drawerWidth = (width: number) => Math.min(width * 0.8, 390);
export const drawerOffset = (offset: number, width: number) => Math.max(0, Math.min(width, offset));

export function drawerCanStart(dx: number, dy: number, offset: number) {
  return Math.abs(dx) >= 12 && Math.abs(dx) > Math.abs(dy) * 1.5 && (dx > 0 || offset > 0);
}

/** Velocity is in pixels/ms. Project the last movement, then settle at either end. */
export function drawerReleaseOpen(offset: number, width: number, velocity: number) {
  if (width <= 0) return false;
  const boundedVelocity = Math.max(-2, Math.min(2, velocity));
  return drawerOffset(offset + boundedVelocity * 160, width) >= width / 2;
}
