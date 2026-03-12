import { describe, expect, it } from 'vitest';

import { decodeLiveFrameHex } from '../src/index.js';

describe('decodeLiveFrameHex', () => {
  it('decodes uppercase and lowercase hex deterministically', () => {
    expect(decodeLiveFrameHex('0A0bFF')).toEqual(new Uint8Array([0x0a, 0x0b, 0xff]));
  });

  it('rejects odd-length hex strings', () => {
    expect(() => decodeLiveFrameHex('abc')).toThrow(/length/);
  });

  it('rejects malformed byte pairs', () => {
    expect(() => decodeLiveFrameHex('0g')).toThrow(/index 0/);
    expect(() => decodeLiveFrameHex('g0')).toThrow(/index 0/);
    expect(() => decodeLiveFrameHex('aa10zz')).toThrow(/index 2/);
  });
});
