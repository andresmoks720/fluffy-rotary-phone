export interface CrcVector {
  readonly name: string;
  readonly dataHex: string;
  readonly expected: number;
}

export const CRC32C_GOLDEN_VECTORS: ReadonlyArray<CrcVector> = [
  {
    name: 'empty',
    dataHex: '',
    expected: 0x00000000
  },
  {
    name: 'ascii-123456789',
    dataHex: '313233343536373839',
    expected: 0xe3069283
  },
  {
    name: 'incrementing-32-bytes',
    dataHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    expected: 0x46dd794e
  }
];
