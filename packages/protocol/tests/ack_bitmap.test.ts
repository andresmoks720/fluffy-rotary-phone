import { describe, expect, it } from 'vitest';

import { buildAckBitmap, missingSlotsFromAckBitmap } from '../src/index.js';

describe('ack bitmap helpers', () => {
  it('matches MVP worked example (slot_count=8, bitmap=0x00B7)', () => {
    const bitmap = buildAckBitmap(8, [0, 1, 2, 4, 5, 7]);
    expect(bitmap).toBe(0x00b7);
    expect(missingSlotsFromAckBitmap(8, bitmap)).toEqual([3, 6]);
  });

  it('rejects out-of-range slot_count', () => {
    expect(() => buildAckBitmap(0, [0])).toThrow(/slot_count/);
    expect(() => buildAckBitmap(17, [0])).toThrow(/slot_count/);
  });

  it('rejects out-of-range slot index', () => {
    expect(() => buildAckBitmap(8, [8])).toThrow(/out of bounds/);
  });
});
