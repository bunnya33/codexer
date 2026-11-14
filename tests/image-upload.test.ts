import { expect, it } from 'vitest';
import { imageBase64Mime } from '../packages/client-shared/src/image-upload.js';
import { decodeImage } from '../packages/shared/src/images.js';

it.each([
  ['image/jpeg', Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1])],
  ['image/png', Buffer.from([137,80,78,71,13,10,26,10,...Array(16).fill(0)])],
  ['image/gif', Buffer.from('GIF89a0000')],
  ['image/webp', Buffer.from('RIFF0000WEBP')],
] as const)('matches the server image signature for %s', (mimeType, bytes) => {
  const base64 = bytes.toString('base64');
  expect(imageBase64Mime(base64)).toBe(mimeType);
  expect(decodeImage({name:'image',mimeType:imageBase64Mime(base64),base64}).bytes).toEqual(bytes);
});

it('identifies iOS JPEG base64 independently of the original PNG or HEIC asset metadata', () => {
  const base64 = Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1]).toString('base64');
  expect(imageBase64Mime(`\n${base64}\n`)).toBe('image/jpeg');
  expect(() => decodeImage({name:'screenshot.png',mimeType:'image/png',base64})).toThrow('invalid-image');
  expect(() => decodeImage({name:'screenshot.jpg',mimeType:imageBase64Mime(base64),base64})).not.toThrow();
  expect(imageBase64Mime(Buffer.from('0000ftypheic').toString('base64'))).toBeNull();
  expect(imageBase64Mime('invalid-base64!')).toBeNull();
});
