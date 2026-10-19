import { expect, it } from 'vitest';
import { ConversationScroll } from '../packages/client-shared/src/conversation-scroll';

const metrics = (offset: number, height = 2000, viewport = 500) => ({ offset, height, viewport });

it('resumes within the bottom tolerance after scrolling down and follows later output', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.beginInteraction();
  scroll.readScroll(metrics(1200));
  expect(scroll.shouldFollow).toBe(false);
  scroll.readScroll(metrics(1478));
  expect(scroll.shouldFollow).toBe(true);
  scroll.contentSize(2600);
  expect(scroll.shouldFollow).toBe(true);
});

it('keeps following through a few pixels of passive bottom drift and fractional rounding', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.readScroll(metrics(1496.5));
  expect(scroll.shouldFollow).toBe(true);
  scroll.contentSize(2600);
  expect(scroll.shouldFollow).toBe(true);
  scroll.readScroll(metrics(2096.5, 2600));
  expect(scroll.shouldFollow).toBe(true);
});

it('does not pause when scrolling down at the end without a resulting scroll event', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.beginInteraction('down');
  scroll.contentSize(2600);
  expect(scroll.shouldFollow).toBe(true);
  scroll.layout(480);
  expect(scroll.shouldFollow).toBe(true);
});

it('restores following after a downward gesture cancels an upward gesture that did not move the viewport', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.beginInteraction('up');
  expect(scroll.shouldFollow).toBe(false);
  scroll.beginInteraction('down');
  expect(scroll.shouldFollow).toBe(true);
});

it('keeps intentional small upward movement paused and does not mistake scrollbar drags for rounding', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.beginInteraction('up');
  scroll.readScroll(metrics(1497.5));
  expect(scroll.shouldFollow).toBe(false);
  // Browsers send another scroll notification after the gesture settles.
  scroll.readScroll(metrics(1497.5));
  expect(scroll.shouldFollow).toBe(false);
  scroll.contentSize(2002);
  expect(scroll.shouldFollow).toBe(false);
  scroll.requestBottom();
  scroll.readScroll(metrics(1502, 2002));
  scroll.readScroll(metrics(1487, 2002));
  expect(scroll.shouldFollow).toBe(false);
});

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

it('keeps following when clearing a multiline draft clamps the offset before the new message is measured', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  // Clearing three input lines grows the viewport. The native offset is clamped
  // to 1452, but its scroll callback arrives after the new message adds 120px.
  scroll.layout(548);
  scroll.contentSize(2120);
  scroll.readScroll(metrics(1500, 2120, 548));
  scroll.readScroll(metrics(1497, 2120, 548));
  scroll.beginInteraction('down');
  scroll.readScroll(metrics(1451.5, 2120, 548));
  expect(scroll.shouldFollow).toBe(true);
  scroll.readScroll(metrics(1572, 2120, 548));
  expect(scroll.shouldFollow).toBe(true);
  scroll.contentSize(2300);
  expect(scroll.shouldFollow).toBe(true);
});

it('keeps following across a temporary content shrink before appended output is measured', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.contentSize(1900);
  scroll.contentSize(2120);
  scroll.readScroll(metrics(1400, 2120));
  expect(scroll.shouldFollow).toBe(true);
});

it('honors an upward gesture during a multiline send resize and subsequent streaming', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.layout(548);
  scroll.contentSize(2120);
  scroll.beginInteraction('up');
  scroll.readScroll(metrics(1449, 2120, 548));
  expect(scroll.shouldFollow).toBe(false);
  scroll.contentSize(2300);
  expect(scroll.shouldFollow).toBe(false);
});

it('still detects an unmarked scrollbar drag after a resize has settled', () => {
  const scroll = new ConversationScroll();
  scroll.readScroll(metrics(1500));
  scroll.layout(548);
  scroll.contentSize(2120);
  scroll.readScroll(metrics(1452, 2120, 548));
  scroll.readScroll(metrics(1572, 2120, 548));
  scroll.readScroll(metrics(1557, 2120, 548));
  expect(scroll.shouldFollow).toBe(false);
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
