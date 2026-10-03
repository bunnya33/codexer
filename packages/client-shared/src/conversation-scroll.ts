type ScrollMetrics = { height: number; offset: number; viewport: number };

/** Track following separately from the measured distance used by the jump button. */
export class ConversationScroll {
  metrics: ScrollMetrics = { height: 0, offset: 0, viewport: 0 };
  private following = true;
  private interacting = false;

  get shouldFollow() { return this.following && !this.interacting; }
  get jumpVisible() { return this.metrics.viewport > 0 && this.distance > 100; }
  private get distance() { return Math.max(0, this.metrics.height - this.metrics.viewport - this.metrics.offset); }

  requestBottom() { this.following = true; this.interacting = false; }
  beginInteraction() { this.interacting = true; }
  pause() { this.following = false; this.interacting = true; }

  readScroll(metrics: ScrollMetrics) {
    const previous = this.metrics;
    const expectedOffset = Math.min(previous.offset, Math.max(0, metrics.height - metrics.viewport));
    const movedUp = previous.viewport > 0 && metrics.offset < expectedOffset - 1;
    this.metrics = { ...metrics, offset: Math.max(0, metrics.offset) };
    if (this.distance <= 8) { this.following = true; this.interacting = false; }
    else if (this.interacting || movedUp) { this.following = false; this.interacting = true; }
    return this.jumpVisible;
  }

  contentSize(height: number) { this.metrics.height = height; return this.remeasure(); }
  layout(viewport: number) { this.metrics.viewport = viewport; return this.remeasure(); }
  reset() { this.metrics = { height: 0, offset: 0, viewport: 0 }; this.requestBottom(); }

  private remeasure() {
    if (this.metrics.viewport > 0 && this.distance <= 8) { this.following = true; this.interacting = false; }
    return this.jumpVisible;
  }
}
