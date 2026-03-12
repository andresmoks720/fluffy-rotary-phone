const STRICT_HEX_BYTE_PATTERN = /^[0-9a-fA-F]{2}$/;

export function decodeLiveFrameHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('invalid frame hex length');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byteText = hex.slice(i * 2, i * 2 + 2);
    if (!STRICT_HEX_BYTE_PATTERN.test(byteText)) {
      throw new Error(`invalid frame hex byte at index ${i}`);
    }
    bytes[i] = Number.parseInt(byteText, 16);
  }

  return bytes;
}
