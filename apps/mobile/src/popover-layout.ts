type Rect = { x: number; y: number; width: number; height: number };
type Insets = { top: number; bottom: number; left: number; right: number };

export function popoverLayout(anchor: Rect, viewport: { width: number; height: number }, requestedWidth: number, measuredHeight: number, insets: Insets, align: 'start' | 'end') {
  const start = insets.left + 12, end = viewport.width - insets.right - 12;
  const top = insets.top + 12, bottom = viewport.height - insets.bottom - 12;
  const width = Math.min(requestedWidth, Math.max(0, end - start));
  const left = Math.max(start, Math.min(end - width, align === 'end' ? anchor.x + anchor.width - width : anchor.x));
  const above = Math.max(0, Math.min(bottom, anchor.y - 8) - top);
  const below = Math.max(0, bottom - Math.max(top, anchor.y + anchor.height + 8));
  const before = measuredHeight > 0 && measuredHeight <= above || !(measuredHeight > 0 && measuredHeight <= below) && above >= below;
  const maxHeight = before ? above : below;
  const height = Math.min(measuredHeight, maxHeight);
  return { width, left, maxHeight, top: Math.max(top, Math.min(bottom - height, before ? anchor.y - height - 8 : anchor.y + anchor.height + 8)) };
}
