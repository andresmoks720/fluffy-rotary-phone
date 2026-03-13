import { describe, expect, it } from 'vitest';

import {
  SAFE_PHY_CONSTANTS,
  SAFE_PREAMBLE_SYMBOLS,
  SAFE_TRAINING_SYMBOLS,
  DEFAULT_SAFE_CARRIER_MODULATION,
  demodulateSafeBpsk,
  detectSafePreamble,
  generateSafePreamble,
  generateSafeTrainingBlock,
  modulateSafeBpsk,
  modulateSafeBpskToWaveform,
  modulateSafeFrameWithPreambleToWaveform,
  scanSafePreambleCorrelation
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


function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function addAwgn(input: Float32Array, sigma: number, seed: number): Float32Array {
  const rand = lcg(seed);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 2) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    const z1 = mag * Math.sin(2 * Math.PI * u2);
    out[i] = input[i] + sigma * z0;
    if (i + 1 < input.length) {
      out[i + 1] = input[i + 1] + sigma * z1;
    }
  }
  return out;
}

function bitErrorRate(a: Uint8Array, b: Uint8Array): number {
  let errors = 0;
  let total = a.length * 8;
  for (let i = 0; i < a.length; i += 1) {
    let x = a[i] ^ b[i];
    while (x > 0) {
      errors += x & 1;
      x >>= 1;
    }
  }
  return total === 0 ? 0 : errors / total;
}

describe('safe PHY deterministic vectors and acquisition boundaries', () => {
  it('locks deterministic aggregate vectors for preamble and training', () => {
    const preamble = generateSafePreamble();
    const training = generateSafeTrainingBlock();

    const preambleSum = Array.from(preamble).reduce((acc, v) => acc + v, 0);
    const trainingSum = Array.from(training).reduce((acc, v) => acc + v, 0);
    const preambleEnergy = Array.from(preamble).reduce((acc, v) => acc + v * v, 0);
    const trainingEnergy = Array.from(training).reduce((acc, v) => acc + v * v, 0);

    expect(preambleSum).toBe(-2);
    expect(trainingSum).toBe(0);
    expect(preambleEnergy).toBe(preamble.length);
    expect(trainingEnergy).toBe(training.length);
  });

  it('keeps preamble and training amplitudes in strict BPSK bounds', () => {
    const preamble = generateSafePreamble();
    const training = generateSafeTrainingBlock();

    for (const v of preamble) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    for (const v of training) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('detects expected offset under low noise', () => {
    const preamble = generateSafePreamble();
    const offset = 37;
    const stream = new Float32Array(offset + preamble.length + 11);
    stream.set(addAwgn(preamble, 0.03, 0x1234), offset);

    const found = detectSafePreamble(stream, 0.9);
    expect(found).not.toBeNull();
    expect(found?.index).toBeGreaterThanOrEqual(0);
    expect(found?.index).toBeLessThanOrEqual(offset);
    expect(found?.score).toBeGreaterThan(0.9);
  });

  it('rejects pure noise without false positive lock', () => {
    const preamble = generateSafePreamble();
    const noise = new Float32Array(preamble.length * 2);
    const rand = lcg(0xbeef);
    for (let i = 0; i < noise.length; i += 1) {
      noise[i] = (rand() - 0.5) * 0.25;
    }

    expect(detectSafePreamble(noise, 0.9)).toBeNull();
  });

  it('pins threshold boundary behavior just below and above perfect correlation', () => {
    const preamble = generateSafePreamble();
    expect(detectSafePreamble(preamble, 0.9999)).toEqual({ index: 0, score: 1 });
    expect(() => detectSafePreamble(preamble, 1.000001)).toThrow(/Threshold must be a finite number/);
  });

  it('rejects invalid detector thresholds loudly', () => {
    const preamble = generateSafePreamble();
    expect(() => detectSafePreamble(preamble, 0)).toThrow(/Threshold must be a finite number/);
    expect(() => detectSafePreamble(preamble, -0.1)).toThrow(/Threshold must be a finite number/);
    expect(() => detectSafePreamble(preamble, 1.1)).toThrow(/Threshold must be a finite number/);
  });



  it('reports windows evaluated count for scan truthfully', () => {
    const preamble = generateSafePreamble();
    const stream = new Float32Array(preamble.length + 10);
    stream.set(preamble, 3);
    const scan = scanSafePreambleCorrelation(stream, 0.9);
    expect(scan.windowsEvaluated).toBe(stream.length - preamble.length + 1);
  });
  it('reports best correlation score even when threshold is not reached', () => {
    const preamble = generateSafePreamble();
    const anti = new Float32Array(preamble.length);
    for (let i = 0; i < preamble.length; i += 1) {
      anti[i] = -preamble[i];
    }

    const scan = scanSafePreambleCorrelation(anti, 0.95);
    expect(scan.hit).toBeNull();
    expect(scan.bestIndex).toBe(0);
    expect(scan.bestScore).toBe(-1);
  });
});

describe('safe PHY BER and bit-order guarantees', () => {
  it('preserves exact bit ordering for known pattern payload', () => {
    const payload = Uint8Array.from([0b10000001, 0b01111110]);
    const symbols = modulateSafeBpsk(payload);
    expect(Array.from(symbols.slice(0, 8))).toEqual([1, -1, -1, -1, -1, -1, -1, 1]);
    expect(Array.from(symbols.slice(8, 16))).toEqual([-1, 1, 1, 1, 1, 1, 1, -1]);
    expect(demodulateSafeBpsk(symbols)).toEqual(payload);
  });

  it('enforces non-byte-aligned symbol rejection explicitly', () => {
    const payload = Uint8Array.from([0xaa]);
    const symbols = modulateSafeBpsk(payload);
    expect(() => demodulateSafeBpsk(symbols.slice(0, 7))).toThrow(/divisible by 8/);
  });

  it('keeps BER within deterministic envelope per noise bucket', () => {
    const rand = lcg(0x51a7);
    const payload = new Uint8Array(512);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = Math.floor(rand() * 256);
    }

    const symbols = modulateSafeBpsk(payload);
    const lowNoise = addAwgn(symbols, 0.05, 0x1001);
    const medNoise = addAwgn(symbols, 0.6, 0x1002);

    const decodedLow = demodulateSafeBpsk(lowNoise);
    const decodedMed = demodulateSafeBpsk(medNoise);

    const lowBer = bitErrorRate(payload, decodedLow);
    const medBer = bitErrorRate(payload, decodedMed);

    expect(lowBer).toBeLessThanOrEqual(0.001);
    expect(medBer).toBeGreaterThanOrEqual(0.001);
    expect(medBer).toBeLessThanOrEqual(0.2);
  });
});


describe('safe BPSK carrier waveform mapping', () => {

  it('prepends the deterministic safe preamble before payload chips on waveform path', () => {
    const sampleRateHz = 48000;
    const waveform = modulateSafeFrameWithPreambleToWaveform(Uint8Array.from([0x80]), sampleRateHz);
    const preambleWaveform = modulateSafeBpskToWaveform(new Uint8Array(0), sampleRateHz);
    const expectedPreambleSamples = generateSafePreamble().length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip;

    expect(preambleWaveform.length).toBe(0);
    expect(waveform.length).toBe(expectedPreambleSamples + 8 * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);

    const chips = new Float32Array(generateSafePreamble().length + 8);
    chips.set(generateSafePreamble(), 0);
    chips.set(modulateSafeBpsk(Uint8Array.from([0x80])), generateSafePreamble().length);
    const expected = new Float32Array(chips.length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);
    for (let chipIndex = 0; chipIndex < chips.length; chipIndex += 1) {
      const chip = chips[chipIndex] ?? 0;
      for (let sampleOffset = 0; sampleOffset < DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip; sampleOffset += 1) {
        const sampleIndex = chipIndex * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip + sampleOffset;
        const phase = (2 * Math.PI * DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz * sampleIndex) / sampleRateHz;
        expected[sampleIndex] = chip * DEFAULT_SAFE_CARRIER_MODULATION.amplitude * Math.sin(phase);
      }
    }
    expect(Array.from(waveform.slice(0, expected.length))).toEqual(Array.from(expected));
  });

  it('maps payload chips onto an audible carrier waveform', () => {
    const waveform = modulateSafeBpskToWaveform(Uint8Array.from([0x80]), 48000);
    expect(waveform.length).toBe(8 * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);
    const peak = Math.max(...Array.from(waveform).map((value) => Math.abs(value)));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(DEFAULT_SAFE_CARRIER_MODULATION.amplitude + 1e-6);
  });

  it('fails loudly for invalid carrier modulation config', () => {
    expect(() => modulateSafeBpskToWaveform(Uint8Array.from([0x01]), 48000, {
      carrierFrequencyHz: 30000,
      samplesPerChip: 24,
      amplitude: 0.1
    })).toThrow(/below Nyquist/);
    expect(() => modulateSafeBpskToWaveform(Uint8Array.from([0x01]), 48000, {
      carrierFrequencyHz: 1500,
      samplesPerChip: 0,
      amplitude: 0.1
    })).toThrow(/positive integer/);
  });
});


describe('safe preamble offset tolerance for detector lock', () => {
  function buildWaveform(chips: Float32Array, sampleRateHz: number, sampleOffset = 0): Float32Array {
    const waveform = new Float32Array(chips.length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip + sampleOffset);
    for (let chipIndex = 0; chipIndex < chips.length; chipIndex += 1) {
      const chip = chips[chipIndex] ?? 0;
      for (let inChipOffset = 0; inChipOffset < DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip; inChipOffset += 1) {
        const sampleIndex = sampleOffset + chipIndex * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip + inChipOffset;
        const phase = (2 * Math.PI * DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz * sampleIndex) / sampleRateHz;
        waveform[sampleIndex] = chip * DEFAULT_SAFE_CARRIER_MODULATION.amplitude * Math.sin(phase);
      }
    }
    return waveform;
  }

  function downsampleToChips(waveform: Float32Array, sampleRateHz: number, sampleOffset: number): Float32Array {
    const available = waveform.length - sampleOffset;
    const chipCount = Math.floor(available / DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);
    const chips = new Float32Array(chipCount);
    for (let chipIndex = 0; chipIndex < chipCount; chipIndex += 1) {
      let sum = 0;
      for (let inChipOffset = 0; inChipOffset < DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip; inChipOffset += 1) {
        const sampleIndex = sampleOffset + chipIndex * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip + inChipOffset;
        const sample = waveform[sampleIndex] ?? 0;
        const phase = (2 * Math.PI * DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz * sampleIndex) / sampleRateHz;
        sum += sample * Math.sin(phase);
      }
      chips[chipIndex] = sum >= 0 ? 1 : -1;
    }
    return chips;
  }

  it('locks preamble for non-zero offsets in at least half-chip deterministic coverage', () => {
    const payload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const sampleRateHz = 48000;
    const frameWaveform = modulateSafeFrameWithPreambleToWaveform(payload, sampleRateHz);

    const offsets = [1, 3, 7, 11, 17, 23];
    let locks = 0;
    for (const sampleOffset of offsets) {
      const shifted = new Float32Array(frameWaveform.length + sampleOffset);
      shifted.set(frameWaveform, sampleOffset);

      const chips = downsampleToChips(shifted, sampleRateHz, sampleOffset);
      const scan = scanSafePreambleCorrelation(chips, 0.92);
      if (scan.hit !== null) {
        locks += 1;
      }
      expect(scan.windowsEvaluated).toBe(chips.length - generateSafePreamble().length + 1);
    }

    expect(locks).toBeGreaterThanOrEqual(3);
  });

  it('maintains lock under mild deterministic noise with non-zero offset', () => {
    const payload = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
    const sampleRateHz = 48000;
    const preamble = generateSafePreamble();
    const chips = new Float32Array(preamble.length + modulateSafeBpsk(payload).length);
    chips.set(preamble, 0);
    chips.set(modulateSafeBpsk(payload), preamble.length);
    const base = buildWaveform(chips, sampleRateHz, 5);

    const noisy = new Float32Array(base.length);
    let seed = 0x1234abcd;
    for (let i = 0; i < base.length; i += 1) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      const noise = ((seed / 0xffffffff) - 0.5) * 0.01;
      noisy[i] = (base[i] ?? 0) + noise;
    }

    const demodChips = downsampleToChips(noisy, sampleRateHz, 5);
    const scan = scanSafePreambleCorrelation(demodChips, 0.9);
    expect(scan.hit).not.toBeNull();
    expect(scan.windowsEvaluated).toBe(demodChips.length - preamble.length + 1);
  });
});
