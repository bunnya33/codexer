import { expect, it } from 'vitest';
import { ConversationScroll } from '../packages/client-shared/src/conversation-scroll';

const metrics = (offset: number, height = 2000, viewport = 500) => ({ offset, height, viewport });

it('keeps the jump button visible after a short drag continues as unmarked momentum', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.beginInteraction();
  expect(scroll.readScroll(metrics(1460))).toBe(false);
  expect(scroll.shouldFollow).toBe(false);
  expect(scroll.readScroll(metrics(1250))).toBe(true);
  expect(scroll.contentSize(2200)).toBe(true);
  expect(scroll.shouldFollow).toBe(false);
});

it('does not restart following when output or preview sizing changes before a drag scroll event', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.beginInteraction();
  scroll.contentSize(2004);
  expect(scroll.shouldFollow).toBe(false);
  scroll.layout(504);
  expect(scroll.shouldFollow).toBe(false);
  // Mobile scrolling starts with small movements still inside the bottom tolerance.
  scroll.readScroll(metrics(1496, 2004, 504));
  expect(scroll.shouldFollow).toBe(false);
  scroll.contentSize(2008);
  expect(scroll.shouldFollow).toBe(false);
  scroll.readScroll(metrics(1300, 2008, 504));
  expect(scroll.jumpVisible).toBe(true);
  scroll.readScroll(metrics(1504, 2008, 504));
  expect(scroll.shouldFollow).toBe(true);
});

it('pauses even when the first upward scroll is within eight pixels of the bottom', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.beginInteraction();
  expect(scroll.readScroll(metrics(1494))).toBe(false);
  expect(scroll.shouldFollow).toBe(false);
  scroll.layout(500);
  expect(scroll.shouldFollow).toBe(false);
});

it('detects upward scrollbar movement without an intent event and resumes only at the end', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  expect(scroll.readScroll(metrics(900))).toBe(true);
  expect(scroll.shouldFollow).toBe(false);
  expect(scroll.readScroll(metrics(1430))).toBe(false);
  expect(scroll.shouldFollow).toBe(false);
  expect(scroll.readScroll(metrics(1500))).toBe(false);
  expect(scroll.shouldFollow).toBe(true);
});

it('remeasures the button when streaming content or the input panel changes without a scroll event', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.beginInteraction();
  scroll.readScroll(metrics(1440));
  expect(scroll.contentSize(2140)).toBe(true);
  expect(scroll.layout(400)).toBe(true);
  expect(scroll.shouldFollow).toBe(false);
  expect(scroll.layout(700)).toBe(false);
});

it('continues automatic following during output growth and ignores shrink clamping as user motion', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.contentSize(2400);
  scroll.readScroll(metrics(1500, 2400));
  expect(scroll.shouldFollow).toBe(true);
  scroll.requestBottom();
  expect(scroll.readScroll(metrics(1900, 2400))).toBe(false);
  expect(scroll.readScroll(metrics(1000, 1500))).toBe(false);
  expect(scroll.shouldFollow).toBe(true);
});

it('preserves the reader during history prepending and resets for a different conversation', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(700));
  scroll.pause();
  scroll.contentSize(3000);
  expect(scroll.readScroll(metrics(1700, 3000))).toBe(true);
  expect(scroll.shouldFollow).toBe(false);
  scroll.requestBottom();
  expect(scroll.shouldFollow).toBe(true);
  scroll.reset();
  expect(scroll.metrics).toEqual({ height: 0, offset: 0, viewport: 0 });
  expect(scroll.jumpVisible).toBe(false);
});
