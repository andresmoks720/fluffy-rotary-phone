import { describe, expect, it } from 'vitest';

import { decodeFrame } from '../src/index.js';

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

describe('parser fuzz bounded stability', () => {
  it('never crashes process for random byte buffers', () => {
    const rand = lcg(0xabc123);

    for (let i = 0; i < 1000; i += 1) {
      const len = Math.floor(rand() * 128);
      const bytes = new Uint8Array(len);
      for (let j = 0; j < len; j += 1) {
        bytes[j] = Math.floor(rand() * 256);
      }

      expect(() => decodeFrame(bytes)).toThrow();
    }
  });

  it('keeps malformed corpus error classes stable', () => {
    const corpus = [
      new Uint8Array([]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0x01, 0x03, 0x00, 0x01, 0, 0, 0, 1]),
      new Uint8Array([0x01, 0xff, 0x00, 0x01, 0, 0, 0, 1, 0, 0, 0, 0]),
      new Uint8Array(64).fill(0xff)
    ];

    const classes = corpus.map((bytes) => {
      try {
        decodeFrame(bytes);
        return 'ok';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/too short|length mismatch/.test(message)) return 'length';
        if (/CRC32C/.test(message)) return 'crc';
        if (/unknown frame type/.test(message)) return 'unknown';
        return 'other';
      }
    });

    expect(classes).toEqual(['length', 'length', 'length', 'unknown', 'unknown']);
  });
});
