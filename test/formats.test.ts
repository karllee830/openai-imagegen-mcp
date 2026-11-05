import { describe, expect, it } from 'vitest';
import { detectImageFormat } from '../src/formats.js';
import { PNG_BYTES } from './helpers.js';

describe('detectImageFormat', () => {
  it.each([
    ['png', PNG_BYTES],
    ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])],
    ['gif', Buffer.from('GIF89a')],
  ])('recognizes %s', (format, data) => {
    expect(detectImageFormat(data)).toBe(format);
  });

  it.each([
    ['empty data', Buffer.alloc(0)],
    ['text', Buffer.from('hello')],
    ['html', Buffer.from('<html></html>')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['a RIFF file that is not WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])],
  ])('rejects %s', (_label, data) => {
    expect(detectImageFormat(data)).toBeUndefined();
  });
});
