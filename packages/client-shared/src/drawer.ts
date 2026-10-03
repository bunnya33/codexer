export const drawerWidth = (width: number) => Math.min(width * 0.8, 390);
export const drawerOffset = (offset: number, width: number) => Math.max(0, Math.min(width, offset));

export function drawerCanStart(dx: number, dy: number, offset: number) {
  return Math.abs(dx) >= 12 && Math.abs(dx) > Math.abs(dy) * 1.5 && (dx > 0 || offset > 0);
}

/** A deliberate swipe commits even after a pause; short drags keep the starting state. */
export function drawerReleaseOpen(offset: number, width: number, velocity: number, wasOpen = false, origin = wasOpen ? width : 0) {
  if (width <= 0) return false;
  const distance = drawerOffset(offset, width) - drawerOffset(origin, width);
  const threshold = Math.max(36, Math.min(72, width * 0.18));
  if (Math.abs(distance) >= 12 && Math.abs(velocity) >= 0.45) return velocity > 0;
  if (distance >= threshold) return true;
  if (distance <= -threshold) return false;
  return wasOpen;
}
