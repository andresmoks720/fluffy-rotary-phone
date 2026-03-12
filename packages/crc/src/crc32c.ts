const POLY_REFLECTED = 0x82f63b78;

const TABLE = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ POLY_REFLECTED : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }

  return table;
})();

export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i += 1) {
    const lookup = (crc ^ data[i]!) & 0xff;
    crc = (crc >>> 8) ^ TABLE[lookup]!;
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32cHex(data: Uint8Array): string {
  return crc32c(data).toString(16).padStart(8, '0');
}
