import { FRAME_TYPES } from '../../contract/src/index.js';
import { decodeFrame } from '../../protocol/src/index.js';
import {
  DEFAULT_SAFE_CARRIER_MODULATION,
  demodulateSafeBpsk,
  generateSafePreamble,
  modulateSafeFrameWithPreambleToWaveform,
  scanSafePreambleCorrelation
} from './phy.js';

export interface LiveRxPipelineDiagnostics {
  rxPipelineStage: 'meter_only' | 'detector_attached' | 'demod_attached' | 'decoder_attached' | 'parser_bridge_attached';
  rxProcessorRole: 'meter' | 'rx_pipeline';
  preambleDetectorHits: number;
  candidateFrameCount: number;
  demodAttempts: number;
  parserInvocations: number;
  helloFramesSeen: number;
  detectorWindowsEvaluated: number;
  detectorInputRms: number;
  detectorInputPeak: number;
  lastPreambleCorrelationScore: number;
  bestPreambleCorrelationScore: number;
  preambleThreshold: number;
  lastDetectorWindowSampleCount: number;
  detectorLastActiveAtMs: number | null;
  detectorLastEvaluatedAtMs: number | null;
  detectorInputSource: 'rx_worklet_stream' | 'rx_injected_samples';
  detectorInputContinuity: 'unknown' | 'continuous_chunks' | 'discontinuous_chunks';
  detectorLastChunkSamples: number;
  detectorInputChunkDiscontinuities: number;
  detectorOffsetsEvaluated: number;
  detectorPhaseBinsEvaluated: number;
  bestSampleOffset: number;
  bestOffsetIndex: number;
  bestOffsetCorrelationScore: number;
  bestCarrierPhaseOffsetRad: number;
  rxBufferedSamples: number;
  detectorBufferFillSamples: number;
  detectorBufferDroppedSamples: number;
  minSamplesRequiredPreamble: number;
  minSamplesRequiredHello: number;
  minSamplesRequiredData: number;
  frameTruncationDetected: boolean;
}

export interface DecodedRxFrameEventDetail {
  readonly frameHex: string;
  readonly frameType?: string;
  readonly classification?: 'ok' | 'decode_error' | 'header_crc_failure' | 'payload_crc_failure' | 'timeout' | 'retry';
}

export interface PushPcmOptions {
  readonly source: 'rx_worklet_stream' | 'rx_injected_samples';
}

export interface LiveRxPipelineConfig {
  readonly maxBufferSamples?: number;
  readonly detectorScanMaxSamples?: number;
  readonly preambleThreshold?: number;
  readonly detectorPhaseOffsetsRad?: readonly number[];
}

const DEFAULT_DETECTOR_PHASE_OFFSETS_RAD = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4] as const;

function detectExpectedFrameLength(bytes: Uint8Array): number | null {
  if (bytes.length < 2) return null;
  const frameType = bytes[1];
  if (frameType === undefined) return null;
  if (frameType === FRAME_TYPES.HELLO) {
    if (bytes.length < 34) return null;
    const fileNameLen = (bytes[28] ?? 0) * 256 + (bytes[29] ?? 0);
    return 30 + fileNameLen + 4;
  }
  if (frameType === FRAME_TYPES.DATA) {
    if (bytes.length < 24) return null;
    const payloadLen = (bytes[18] ?? 0) * 256 + (bytes[19] ?? 0);
    return 24 + payloadLen + 4;
  }
  if (frameType === FRAME_TYPES.END) {
    return 28;
  }
  return null;
}

function appendToRollingSamples(current: Float32Array, next: Float32Array, maxSamples: number): { merged: Float32Array; dropped: number } {
  if (next.length >= maxSamples) {
    return {
      merged: next.slice(next.length - maxSamples),
      dropped: current.length + Math.max(0, next.length - maxSamples)
    };
  }
  const total = current.length + next.length;
  if (total <= maxSamples) {
    const merged = new Float32Array(total);
    merged.set(current, 0);
    merged.set(next, current.length);
    return { merged, dropped: 0 };
  }
  const keepFromCurrent = maxSamples - next.length;
  const merged = new Float32Array(maxSamples);
  merged.set(current.slice(current.length - keepFromCurrent), 0);
  merged.set(next, keepFromCurrent);
  return { merged, dropped: total - maxSamples };
}

function inferFrameTypeName(frameType: number): string {
  if (frameType === FRAME_TYPES.HELLO) return 'HELLO';
  if (frameType === FRAME_TYPES.DATA) return 'DATA';
  if (frameType === FRAME_TYPES.END) return 'END';
  return `UNKNOWN_${frameType}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((v) => v.toString(16).padStart(2, '0')).join('');
}

type DecodeClassification = Exclude<DecodedRxFrameEventDetail['classification'], undefined>;

function classifyDecodeFailure(error: unknown): DecodeClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('header CRC32C mismatch')) return 'header_crc_failure';
  if (message.includes('payload CRC32C mismatch')) return 'payload_crc_failure';
  return 'decode_error';
}

interface BuiltChips {
  readonly chips: Float32Array;
}

function buildChips(
  scanSamples: Float32Array,
  sampleOffset: number,
  sampleRateHz: number,
  samplesPerChip: number,
  phaseOffsetRad: number
): BuiltChips {
  const available = scanSamples.length - sampleOffset;
  const chipCount = Math.floor(available / samplesPerChip);
  const chips = new Float32Array(chipCount);
  for (let chipIndex = 0; chipIndex < chipCount; chipIndex += 1) {
    let sum = 0;
    for (let inChipOffset = 0; inChipOffset < samplesPerChip; inChipOffset += 1) {
      const sampleIndex = sampleOffset + chipIndex * samplesPerChip + inChipOffset;
      const sample = scanSamples[sampleIndex] ?? 0;
      const phase = ((2 * Math.PI * DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz * sampleIndex) / sampleRateHz) + phaseOffsetRad;
      sum += sample * Math.sin(phase);
    }
    chips[chipIndex] = sum >= 0 ? 1 : -1;
  }
  return { chips };
}

export class LiveRxPipeline {
  private readonly maxBufferSamples: number;
  private readonly detectorScanMaxSamples: number;
  private readonly preambleThreshold: number;
  private readonly detectorPhaseOffsetsRad: readonly number[];
  private rolling = new Float32Array(0);
  private readonly minSampleRequirementsByRateHz = new Map<number, { preamble: number; hello: number; data: number }>();

  constructor(config: LiveRxPipelineConfig = {}) {
    this.maxBufferSamples = config.maxBufferSamples ?? 262144;
    this.detectorScanMaxSamples = config.detectorScanMaxSamples ?? 65536;
    this.preambleThreshold = config.preambleThreshold ?? 0.92;
    this.detectorPhaseOffsetsRad = (config.detectorPhaseOffsetsRad ?? DEFAULT_DETECTOR_PHASE_OFFSETS_RAD).slice();
  }

  createInitialDiagnostics(): LiveRxPipelineDiagnostics {
    return {
      rxPipelineStage: 'meter_only',
      rxProcessorRole: 'meter',
      preambleDetectorHits: 0,
      candidateFrameCount: 0,
      demodAttempts: 0,
      parserInvocations: 0,
      helloFramesSeen: 0,
      detectorWindowsEvaluated: 0,
      detectorInputRms: 0,
      detectorInputPeak: 0,
      lastPreambleCorrelationScore: 0,
      bestPreambleCorrelationScore: 0,
      preambleThreshold: this.preambleThreshold,
      lastDetectorWindowSampleCount: 0,
      detectorLastActiveAtMs: null,
      detectorLastEvaluatedAtMs: null,
      detectorInputSource: 'rx_worklet_stream',
      detectorInputContinuity: 'unknown',
      detectorLastChunkSamples: 0,
      detectorInputChunkDiscontinuities: 0,
      detectorOffsetsEvaluated: 0,
      detectorPhaseBinsEvaluated: 0,
      bestSampleOffset: -1,
      bestOffsetIndex: -1,
      bestOffsetCorrelationScore: 0,
      bestCarrierPhaseOffsetRad: 0,
      rxBufferedSamples: 0,
      detectorBufferFillSamples: 0,
      detectorBufferDroppedSamples: 0,
      minSamplesRequiredPreamble: 0,
      minSamplesRequiredHello: 0,
      minSamplesRequiredData: 0,
      frameTruncationDetected: false
    };
  }

  reset(): void {
    this.rolling = new Float32Array(0);
  }

  pushPcm(samples: Float32Array, sampleRateHz: number, diagnostics: LiveRxPipelineDiagnostics, options: PushPcmOptions): DecodedRxFrameEventDetail | null {
    const appended = appendToRollingSamples(this.rolling, samples, this.maxBufferSamples);
    this.rolling = new Float32Array(appended.merged);

    diagnostics.detectorInputSource = options.source;
    diagnostics.detectorBufferFillSamples = this.rolling.length;
    diagnostics.detectorBufferDroppedSamples += appended.dropped;

    if (
      options.source === 'rx_worklet_stream'
      && diagnostics.detectorLastChunkSamples >= 64
      && samples.length >= 64
      && samples.length >= diagnostics.detectorLastChunkSamples
      && diagnostics.detectorLastChunkSamples !== samples.length
    ) {
      diagnostics.detectorInputChunkDiscontinuities += 1;
    }
    diagnostics.detectorLastChunkSamples = samples.length;
    diagnostics.detectorInputContinuity = diagnostics.detectorInputChunkDiscontinuities > 0
      ? 'discontinuous_chunks'
      : 'continuous_chunks';

    return this.runDecode(sampleRateHz, diagnostics);
  }

  private computeMinSamplesRequired(sampleRateHz: number): { preamble: number; hello: number; data: number } {
    const cached = this.minSampleRequirementsByRateHz.get(sampleRateHz);
    if (cached) return cached;
    const defaults = DEFAULT_SAFE_CARRIER_MODULATION;
    const preambleChips = generateSafePreamble().length;
    const computed = {
      preamble: preambleChips * defaults.samplesPerChip,
      hello: modulateSafeFrameWithPreambleToWaveform(new Uint8Array(34), sampleRateHz, defaults).length,
      data: modulateSafeFrameWithPreambleToWaveform(new Uint8Array(24 + 512 + 4), sampleRateHz, defaults).length
    };
    this.minSampleRequirementsByRateHz.set(sampleRateHz, computed);
    return computed;
  }

  private runDecode(sampleRateHz: number, diagnostics: LiveRxPipelineDiagnostics): DecodedRxFrameEventDetail | null {
    const preamble = generateSafePreamble();
    const samplesPerChip = DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip;
    diagnostics.rxPipelineStage = 'detector_attached';
    diagnostics.rxProcessorRole = 'rx_pipeline';

    const minRequired = this.computeMinSamplesRequired(sampleRateHz);
    diagnostics.minSamplesRequiredPreamble = minRequired.preamble;
    diagnostics.minSamplesRequiredHello = minRequired.hello;
    diagnostics.minSamplesRequiredData = minRequired.data;
    diagnostics.rxBufferedSamples = this.rolling.length;

    const scanSamples = this.rolling.length <= this.detectorScanMaxSamples
      ? this.rolling
      : this.rolling.subarray(this.rolling.length - this.detectorScanMaxSamples);
    diagnostics.lastDetectorWindowSampleCount = scanSamples.length;

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < scanSamples.length; i += 1) {
      const value = scanSamples[i] ?? 0;
      const abs = Math.abs(value);
      if (abs > peak) peak = abs;
      sumSquares += value * value;
    }
    diagnostics.detectorInputRms = scanSamples.length === 0 ? 0 : Math.sqrt(sumSquares / scanSamples.length);
    diagnostics.detectorInputPeak = peak;
    diagnostics.detectorLastEvaluatedAtMs = Date.now();
    diagnostics.frameTruncationDetected = false;

    if (scanSamples.length < minRequired.preamble) return null;

    let bestDetection: {
      sampleOffset: number;
      phaseOffsetRad: number;
      bestIndex: number;
      bestScore: number;
      hit: { index: number; score: number } | null;
      chips: Float32Array;
    } | null = null;

    for (let sampleOffset = 0; sampleOffset < samplesPerChip; sampleOffset += 1) {
      const available = scanSamples.length - sampleOffset;
      if (available < minRequired.preamble) continue;

      for (const phaseOffsetRad of this.detectorPhaseOffsetsRad) {
        const built = buildChips(scanSamples, sampleOffset, sampleRateHz, samplesPerChip, phaseOffsetRad);
        const detection = scanSafePreambleCorrelation(built.chips, this.preambleThreshold);
        diagnostics.detectorWindowsEvaluated += detection.windowsEvaluated;
        diagnostics.detectorOffsetsEvaluated += 1;
        diagnostics.detectorPhaseBinsEvaluated += 1;

        if (
          bestDetection === null
          || detection.bestScore > bestDetection.bestScore
          || (detection.hit !== null && bestDetection.hit === null)
        ) {
          bestDetection = {
            sampleOffset,
            phaseOffsetRad,
            bestIndex: detection.bestIndex,
            bestScore: detection.bestScore,
            hit: detection.hit,
            chips: built.chips
          };
        }
      }
    }

    if (bestDetection === null) return null;

    diagnostics.lastPreambleCorrelationScore = bestDetection.bestScore;
    diagnostics.bestPreambleCorrelationScore = Math.max(
      diagnostics.bestPreambleCorrelationScore,
      bestDetection.bestScore
    );
    diagnostics.bestSampleOffset = bestDetection.sampleOffset;
    diagnostics.bestOffsetIndex = bestDetection.bestIndex;
    diagnostics.bestOffsetCorrelationScore = bestDetection.bestScore;
    diagnostics.bestCarrierPhaseOffsetRad = bestDetection.phaseOffsetRad;

    if (!bestDetection.hit) return null;

    diagnostics.detectorLastActiveAtMs = Date.now();
    diagnostics.preambleDetectorHits += 1;
    diagnostics.rxPipelineStage = 'demod_attached';

    const dataChips = bestDetection.chips.subarray(bestDetection.hit.index + preamble.length);
    const fullBytes = Math.floor(dataChips.length / 8);
    if (fullBytes < 20) {
      diagnostics.frameTruncationDetected = true;
      return null;
    }

    diagnostics.candidateFrameCount += 1;
    diagnostics.demodAttempts += 1;
    let rawBytes: Uint8Array;
    try {
      rawBytes = demodulateSafeBpsk(dataChips.subarray(0, fullBytes * 8));
    } catch (error) {
      return { frameHex: '', classification: classifyDecodeFailure(error) };
    }

    diagnostics.rxPipelineStage = 'decoder_attached';
    const expectedLength = detectExpectedFrameLength(rawBytes);
    if (expectedLength === null || rawBytes.length < expectedLength) {
      diagnostics.frameTruncationDetected = true;
      return null;
    }

    const frameBytes = rawBytes.subarray(0, expectedLength);
    diagnostics.parserInvocations += 1;
    diagnostics.rxPipelineStage = 'parser_bridge_attached';

    try {
      const decoded = decodeFrame(frameBytes, { expectedTurnOwner: 'sender' });
      if (decoded.frameType === FRAME_TYPES.HELLO) {
        diagnostics.helloFramesSeen += 1;
      }
      return { frameHex: toHex(frameBytes), frameType: inferFrameTypeName(decoded.frameType), classification: 'ok' };
    } catch (error) {
      return {
        frameHex: toHex(frameBytes),
        frameType: inferFrameTypeName(frameBytes[1] ?? 0),
        classification: classifyDecodeFailure(error)
      };
    }
  }
}
