type ScrollMetrics = { height: number; offset: number; viewport: number };
export type ScrollDirection = 'up' | 'down';

const BOTTOM_TOLERANCE = 24;
const PASSIVE_DRIFT_TOLERANCE = 4;

/** Track following separately from the measured distance used by the jump button. */
export class ConversationScroll {
  metrics: ScrollMetrics = { height: 0, offset: 0, viewport: 0 };
  private following = true;
  private interacting = false;
  private pendingClamp: number | null = null;

  get shouldFollow() { return this.following && !this.interacting; }
  get jumpVisible() { return this.metrics.viewport > 0 && this.distance > 100; }
  get nearTop() { return this.metrics.viewport > 0 && this.metrics.offset <= 64; }
  private get distance() { return Math.max(0, this.metrics.height - this.metrics.viewport - this.metrics.offset); }

  requestBottom() { this.following = true; this.interacting = false; }
  beginInteraction(direction: ScrollDirection = 'up') {
    // A downward wheel/gesture at the end may not emit any scroll event.
    if (direction === 'down' && (this.shouldFollow || this.distance <= BOTTOM_TOLERANCE)) this.requestBottom();
    else { this.interacting = true; this.pendingClamp = null; }
  }
  pause() { this.following = false; this.interacting = true; this.pendingClamp = null; }

  readScroll(metrics: ScrollMetrics) {
    const previous = this.metrics;
    const following = this.shouldFollow;
    const expectedOffset = Math.min(previous.offset, this.pendingClamp ?? previous.offset, Math.max(0, metrics.height - metrics.viewport));
    const movedUp = previous.viewport > 0 && metrics.offset < expectedOffset - (following ? PASSIVE_DRIFT_TOLERANCE : 1);
    const movedDown = previous.viewport > 0 && metrics.offset > expectedOffset + 1;
    // A size callback can precede both the clamped scroll callback and newly
    // appended content. Consume it when acknowledged or superseded by motion.
    if (this.pendingClamp !== null && (metrics.offset <= this.pendingClamp + PASSIVE_DRIFT_TOLERANCE || metrics.offset > previous.offset + PASSIVE_DRIFT_TOLERANCE || movedUp)) this.pendingClamp = null;
    this.metrics = { ...metrics, offset: Math.max(0, metrics.offset) };
    if (this.distance <= BOTTOM_TOLERANCE && !movedUp && (following || movedDown || this.distance <= 1)) this.requestBottom();
    else if (this.interacting || movedUp) { this.following = false; this.interacting = true; }
    return this.jumpVisible;
  }

  contentSize(height: number) { this.metrics.height = height; return this.remeasure(); }
  layout(viewport: number) { this.metrics.viewport = viewport; return this.remeasure(); }
  reset() { this.metrics = { height: 0, offset: 0, viewport: 0 }; this.pendingClamp = null; this.requestBottom(); }

  private remeasure() {
    if (this.shouldFollow) {
      const clamped = Math.min(this.pendingClamp ?? this.metrics.offset, Math.max(0, this.metrics.height - this.metrics.viewport));
      if (clamped < this.metrics.offset) this.pendingClamp = clamped;
    }
    // Layout and streaming measurements can arrive before the first native drag scroll.
    // Resume following only on a scroll back to the end or an explicit bottom request.
    return this.jumpVisible;
  }
}
