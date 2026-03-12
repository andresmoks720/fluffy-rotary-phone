import { describe, expect, it } from 'vitest';

import { crc32c, crc32cHex, CRC32C_GOLDEN_VECTORS } from '../src/index.js';

function hexToBytes(hex: string): Uint8Array {
  if ((hex.length & 1) !== 0) {
    throw new Error('Hex string must have even length');
  }

  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }

  return out;
}

describe('crc32c', () => {
  it('matches golden vectors', () => {
    for (const vector of CRC32C_GOLDEN_VECTORS) {
      const bytes = hexToBytes(vector.dataHex);
      expect(crc32c(bytes), vector.name).toBe(vector.expected);
    }
  });

  it('returns lowercase zero-padded hex', () => {
    expect(crc32cHex(hexToBytes('313233343536373839'))).toBe('e3069283');
  });
});
