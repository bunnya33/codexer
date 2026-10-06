import type { HistoryTurn } from '../../protocol/src/index';

export type ImagePreview = { source: { uri: string; headers?: Record<string, string>; mimeType?: string; expectedBytes?: number }; name: string; svgXml?: string };
export type ImageGallery = { images: ImagePreview[]; index: number };
export type ImageDirection = -1 | 1;

/** Only loaded conversation images, in message order. Shared assets appear once. */
export function conversationImages(turns: HistoryTurn[]) {
  const seen = new Set<string>();
  return turns.flatMap(turn => turn.items.flatMap(item => (item.images ?? []).filter(image => {
    if (seen.has(image.id)) return false;
    seen.add(image.id);
    return true;
  })));
}

/** A deliberate horizontal swipe at normal zoom; pinching and panning stay local. */
export function imageSwipe(dx: number, dy: number, scale: number, multiTouch = false): ImageDirection | null {
  if (multiTouch || scale > 1.01 || !Number.isFinite(dx) || !Number.isFinite(dy)
    || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 1 : -1;
}
