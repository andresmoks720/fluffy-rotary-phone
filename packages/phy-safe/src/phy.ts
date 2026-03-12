import {
  SAFE_PHY_CONSTANTS,
  SAFE_PREAMBLE_SYMBOLS,
  SAFE_TRAINING_SYMBOLS
} from './constants.js';

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
}

function createPrbsSign(index: number): 1 | -1 {
  let x = (index + 1) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x & 1) === 0 ? 1 : -1;
}

function requiredChipCount(bytesLength: number): number {
  return bytesLength * 8;
}

function mapChipToCarrierWave(
  chip: number,
  chipIndex: number,
  sampleRateHz: number,
  samplesPerChip: number,
  config: SafeCarrierModulationConfig
): Float32Array {
  const samples = new Float32Array(samplesPerChip);
  const chipStartSample = chipIndex * samplesPerChip;
  for (let sampleOffset = 0; sampleOffset < samplesPerChip; sampleOffset += 1) {
    const sampleIndex = chipStartSample + sampleOffset;
    const phase = (2 * Math.PI * config.carrierFrequencyHz * sampleIndex) / sampleRateHz;
    samples[sampleOffset] = chip * config.amplitude * Math.sin(phase);
  }
  return samples;
}

export interface SafeCarrierModulationConfig {
  readonly carrierFrequencyHz: number;
  readonly samplesPerChip: number;
  readonly amplitude: number;
}

export const DEFAULT_SAFE_CARRIER_MODULATION: SafeCarrierModulationConfig = {
  carrierFrequencyHz: SAFE_PHY_CONSTANTS.centerFrequencyHz,
  samplesPerChip: 24,
  amplitude: 0.1
} as const;

export function modulateSafeBpskToWaveform(
  payload: Uint8Array,
  sampleRateHz: number,
  config: SafeCarrierModulationConfig = DEFAULT_SAFE_CARRIER_MODULATION
): Float32Array {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error('sampleRateHz must be a positive finite number.');
  }

  if (!Number.isInteger(config.samplesPerChip) || config.samplesPerChip <= 0) {
    throw new Error('samplesPerChip must be a positive integer.');
  }

  if (!Number.isFinite(config.amplitude) || config.amplitude <= 0 || config.amplitude > 1) {
    throw new Error('amplitude must be a finite number in (0, 1].');
  }

  const nyquistHz = sampleRateHz / 2;
  if (!Number.isFinite(config.carrierFrequencyHz) || config.carrierFrequencyHz <= 0 || config.carrierFrequencyHz >= nyquistHz) {
    throw new Error('carrierFrequencyHz must be finite, positive, and below Nyquist.');
  }

  const chips = modulateSafeBpsk(payload);
  const waveform = new Float32Array(chips.length * config.samplesPerChip);
  for (let i = 0; i < chips.length; i += 1) {
    const chip = chips[i];
    if (chip === undefined) {
      throw new Error(`missing modulated chip at index ${i}`);
    }
    const mapped = mapChipToCarrierWave(chip, i, sampleRateHz, config.samplesPerChip, config);
    waveform.set(mapped, i * config.samplesPerChip);
  }

  return waveform;
}

export function generateSafePreamble(): Float32Array {
  assertInteger(SAFE_PREAMBLE_SYMBOLS, 'SAFE_PREAMBLE_SYMBOLS');
  const totalChips = SAFE_PREAMBLE_SYMBOLS * SAFE_PHY_CONSTANTS.carrierCount;
  const preamble = new Float32Array(totalChips);
  for (let i = 0; i < totalChips; i += 1) {
    preamble[i] = createPrbsSign(i);
  }
  return preamble;
}

export function generateSafeTrainingBlock(): Float32Array {
  assertInteger(SAFE_TRAINING_SYMBOLS, 'SAFE_TRAINING_SYMBOLS');
  const totalChips = SAFE_TRAINING_SYMBOLS * SAFE_PHY_CONSTANTS.carrierCount;
  const training = new Float32Array(totalChips);
  for (let symbol = 0; symbol < SAFE_TRAINING_SYMBOLS; symbol += 1) {
    for (let carrier = 0; carrier < SAFE_PHY_CONSTANTS.carrierCount; carrier += 1) {
      const i = symbol * SAFE_PHY_CONSTANTS.carrierCount + carrier;
      training[i] = (symbol + carrier) % 2 === 0 ? 1 : -1;
    }
  }
  return training;
}

export function modulateSafeBpsk(payload: Uint8Array): Float32Array {
  const chips = new Float32Array(requiredChipCount(payload.length));
  let chipIndex = 0;

  for (const byte of payload) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      const bitValue = (byte >> bit) & 0x01;
      chips[chipIndex] = bitValue === 1 ? 1 : -1;
      chipIndex += 1;
    }
  }

  return chips;
}

export function demodulateSafeBpsk(symbols: Float32Array): Uint8Array {
  if (symbols.length === 0) {
    return new Uint8Array(0);
  }

  if (symbols.length % 8 !== 0) {
    throw new Error('BPSK symbol length must be divisible by 8.');
  }

  for (let i = 0; i < symbols.length; i += 1) {
    if (!Number.isFinite(symbols[i])) {
      throw new Error(`Invalid symbol at index ${i}; expected finite value.`);
    }
  }

  const payload = new Uint8Array(symbols.length / 8);
  for (let i = 0; i < payload.length; i += 1) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const symbol = symbols[i * 8 + bit];
      if (symbol === undefined) {
        throw new Error(`Missing symbol at index ${i * 8 + bit}.`);
      }
      const decoded = symbol >= 0 ? 1 : 0;
      byte = (byte << 1) | decoded;
    }
    payload[i] = byte;
  }

  return payload;
}

export function detectSafePreamble(
  samples: Float32Array,
  threshold: number
): { index: number; score: number } | null {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error('Threshold must be a finite number in (0, 1].');
  }

  const preamble = generateSafePreamble();
  if (samples.length < preamble.length) {
    return null;
  }

  let preambleEnergy = 0;
  for (let i = 0; i < preamble.length; i += 1) {
    const preambleValue = preamble[i];
    if (preambleValue === undefined) {
      throw new Error(`Missing preamble sample at index ${i}.`);
    }
    preambleEnergy += preambleValue * preambleValue;
  }

  for (let offset = 0; offset <= samples.length - preamble.length; offset += 1) {
    let dot = 0;
    let sampleEnergy = 0;
    for (let i = 0; i < preamble.length; i += 1) {
      const sample = samples[offset + i];
      const preambleValue = preamble[i];
      if (preambleValue === undefined) {
        throw new Error(`Missing preamble sample at index ${i}.`);
      }
      if (sample === undefined || !Number.isFinite(sample)) {
        throw new Error(`Invalid sample at index ${offset + i}; expected finite value.`);
      }
      dot += sample * preambleValue;
      sampleEnergy += sample * sample;
    }

    if (sampleEnergy === 0) {
      continue;
    }

    const score = dot / Math.sqrt(sampleEnergy * preambleEnergy);
    if (score >= threshold) {
      return { index: offset, score };
    }
  }

  return null;
}
