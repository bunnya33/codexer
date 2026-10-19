type ScrollMetrics = { height: number; offset: number; viewport: number };
export type ScrollDirection = 'up' | 'down';

const BOTTOM_TOLERANCE = 24;

/** Track following separately from the measured distance used by the jump button. */
export class ConversationScroll {
  metrics: ScrollMetrics = { height: 0, offset: 0, viewport: 0 };
  private following = true;
  private interacting = false;
  private direction: ScrollDirection | undefined;

  get shouldFollow() { return this.following && !this.interacting; }
  get jumpVisible() { return this.metrics.viewport > 0 && this.distance > 100; }
  get nearTop() { return this.metrics.viewport > 0 && this.metrics.offset <= 64; }
  private get distance() { return Math.max(0, this.metrics.height - this.metrics.viewport - this.metrics.offset); }

  requestBottom() { this.following = true; this.interacting = false; this.direction = undefined; }
  beginInteraction(direction?: ScrollDirection) {
    // A downward wheel/gesture at the end may not emit any scroll event.
    if (direction === 'down' && (this.shouldFollow || this.distance <= BOTTOM_TOLERANCE)) this.requestBottom();
    else { this.interacting = true; this.direction = direction; }
  }
  pause() { this.following = false; this.interacting = true; this.direction = 'up'; }

  readScroll(metrics: ScrollMetrics) {
    const previous = this.metrics;
    const movedDown = previous.viewport > 0 && metrics.offset > previous.offset + 1;
    this.metrics = { ...metrics, offset: Math.max(0, metrics.offset) };
    // Following is user intent, not a property of post-render geometry. Long
    // cards, virtualized rows and composer resizing can move the offset in
    // either direction, including after a newer scroll-to-end callback.
    // Only explicit input pauses following; scrolling back down can resume it.
    if (!this.shouldFollow && this.direction !== 'up' && movedDown && this.distance <= BOTTOM_TOLERANCE) this.requestBottom();
    return this.jumpVisible;
  }

  contentSize(height: number) { this.metrics.height = height; return this.jumpVisible; }
  layout(viewport: number) { this.metrics.viewport = viewport; return this.jumpVisible; }
  reset() { this.metrics = { height: 0, offset: 0, viewport: 0 }; this.requestBottom(); }
}
