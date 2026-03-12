import { describe, expect, it } from 'vitest';

import {
  SAFE_PHY_CONSTANTS,
  SAFE_PREAMBLE_SYMBOLS,
  SAFE_TRAINING_SYMBOLS,
  demodulateSafeBpsk,
  detectSafePreamble,
  generateSafePreamble,
  generateSafeTrainingBlock,
  modulateSafeBpsk
} from '../src/index.js';

describe('safe PHY constants', () => {
  it('align with MVP safe profile defaults', () => {
    expect(SAFE_PHY_CONSTANTS.profileId).toBe('safe');
    expect(SAFE_PHY_CONSTANTS.modulation).toBe('BPSK');
    expect(SAFE_PHY_CONSTANTS.carrierCount).toBe(16);
    expect(SAFE_PHY_CONSTANTS.carrierSpacingHz).toBe(125);
    expect(SAFE_PHY_CONSTANTS.symbolRateHz).toBe(250);
    expect(SAFE_PHY_CONSTANTS.preambleDurationMs).toBe(300);
    expect(SAFE_PHY_CONSTANTS.trainingDurationMs).toBe(400);
    expect(SAFE_PHY_CONSTANTS.payloadBytesPerFrame).toBe(512);
    expect(SAFE_PREAMBLE_SYMBOLS).toBe(75);
    expect(SAFE_TRAINING_SYMBOLS).toBe(100);
  });
});

describe('safe preamble and training generation', () => {
  it('preamble has deterministic length and BPSK-only values', () => {
    const preamble = generateSafePreamble();

    expect(preamble.length).toBe(SAFE_PREAMBLE_SYMBOLS * SAFE_PHY_CONSTANTS.carrierCount);
    const unique = new Set(Array.from(preamble));
    expect(unique).toEqual(new Set([-1, 1]));

    expect(Array.from(preamble.slice(0, 8))).toEqual([-1, 1, -1, 1, -1, 1, -1, 1]);
  });

  it('training has deterministic length and alternating pilot pattern', () => {
    const training = generateSafeTrainingBlock();
    expect(training.length).toBe(SAFE_TRAINING_SYMBOLS * SAFE_PHY_CONSTANTS.carrierCount);

    expect(Array.from(training.slice(0, 8))).toEqual([1, -1, 1, -1, 1, -1, 1, -1]);
    const secondSymbol = Array.from(
      training.slice(SAFE_PHY_CONSTANTS.carrierCount, SAFE_PHY_CONSTANTS.carrierCount + 8)
    );
    expect(secondSymbol).toEqual([-1, 1, -1, 1, -1, 1, -1, 1]);
  });
});

describe('safe BPSK modulation and demodulation', () => {
  it('recovers payload in a noise-free roundtrip', () => {
    const payload = Uint8Array.from([0x00, 0xff, 0x3c, 0xa5, 0x81, 0x7e]);
    const symbols = modulateSafeBpsk(payload);

    const decoded = demodulateSafeBpsk(symbols);
    expect(decoded).toEqual(payload);
  });

  it('fails explicitly when symbol count is malformed', () => {
    expect(() => demodulateSafeBpsk(new Float32Array([1, -1, 1]))).toThrow(
      'BPSK symbol length must be divisible by 8.'
    );
  });

  it('fails explicitly for invalid numeric symbol values', () => {
    const symbols = new Float32Array(8);
    symbols[3] = Number.NaN;

    expect(() => demodulateSafeBpsk(symbols)).toThrow(
      'Invalid symbol at index 3; expected finite value.'
    );
  });
});

describe('safe preamble acquisition', () => {
  it('passes for a clearly embedded preamble and fails for low correlation data', () => {
    const preamble = generateSafePreamble();

    const prefix = new Float32Array(23).fill(0);
    const suffix = new Float32Array(19).fill(0);
    const stream = new Float32Array(prefix.length + preamble.length + suffix.length);
    stream.set(prefix, 0);
    stream.set(preamble, prefix.length);
    stream.set(suffix, prefix.length + preamble.length);

    const found = detectSafePreamble(stream, 0.95);
    expect(found).toEqual({ index: prefix.length, score: 1 });

    const anti = new Float32Array(preamble.length);
    for (let i = 0; i < preamble.length; i += 1) {
      anti[i] = -preamble[i];
    }

    expect(detectSafePreamble(anti, 0.95)).toBeNull();
  });
});
