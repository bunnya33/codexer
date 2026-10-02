import { expect, it } from 'vitest';
import { conversationImages, imageSwipe } from '../packages/client-shared/src/images';
import type { HistoryTurn } from '../packages/protocol/src/index';

it('browses loaded attachments in conversation order, preserving distinct images with the same name', () => {
  const turns: HistoryTurn[] = [
    { id: 'first', status: 'completed', truncated: false, items: [
      { id: 'user', type: 'userMessage', truncated: false, images: [{ id: 'one', name: 'image.png' }, { id: 'two', name: 'image.png' }] },
      { id: 'answer', type: 'agentMessage', truncated: false, images: [{ id: 'one', name: 'image.png' }] },
    ] },
    { id: 'live', status: 'inProgress', truncated: false, items: [
      { id: 'text', type: 'userMessage', text: 'No attachment', truncated: false },
      { id: 'new', type: 'agentMessage', truncated: false, images: [{ id: 'three', name: 'result.png' }] },
    ] },
  ];
  expect(conversationImages(turns).map(image => image.id)).toEqual(['one', 'two', 'three']);
  expect(conversationImages([])).toEqual([]);
});

it('recognizes deliberate horizontal swipes in either direction, including slow drags', () => {
  expect(imageSwipe(-120, 12, 1)).toBe(1);
  expect(imageSwipe(120, -12, 1)).toBe(-1);
  expect(imageSwipe(50, 0, 1)).toBe(-1);
});

it('keeps taps, vertical movement, zoomed panning and pinch gestures from changing images', () => {
  expect(imageSwipe(6, 0, 1)).toBeNull();
  expect(imageSwipe(100, 100, 1)).toBeNull();
  expect(imageSwipe(100, 0, 2)).toBeNull();
  expect(imageSwipe(100, 0, 1, true)).toBeNull();
  expect(imageSwipe(NaN, 0, 1)).toBeNull();
});
