import { describe, expect, it } from 'vitest';

import {
  LiveRxPipeline,
  modulateSafeBpskToWaveform,
  modulateSafeFrameWithPreambleToWaveform,
  DEFAULT_SAFE_CARRIER_MODULATION,
  generateSafePreamble
} from '../src/index.js';
import {
  FLAGS_MVP_DEFAULT,
  FRAME_TYPES,
  PROFILE_DEFAULTS,
  PROFILE_IDS,
  PROTOCOL_VERSION
} from '../../contract/src/index.js';
import { encodeFrame } from '../../protocol/src/index.js';

function buildHelloFrame(sessionId: number): Uint8Array {
  const defaults = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
  return encodeFrame({
    version: PROTOCOL_VERSION,
    frameType: FRAME_TYPES.HELLO,
    flags: FLAGS_MVP_DEFAULT,
    profileId: PROFILE_IDS.SAFE,
    sessionId,
    fileNameUtf8: new TextEncoder().encode('rx-pipeline.bin'),
    fileSizeBytes: 1024n,
    totalDataFrames: 2,
    payloadBytesPerFrame: defaults.payloadBytesPerFrame,
    framesPerBurst: defaults.framesPerBurst,
    fileCrc32c: 0x11223344
  });
}

describe('LiveRxPipeline', () => {
  it('decodes HELLO from continuous chunked PCM stream and tracks buffer counters', () => {
    const pipeline = new LiveRxPipeline();
    const diagnostics = pipeline.createInitialDiagnostics();

    const waveform = modulateSafeFrameWithPreambleToWaveform(
      buildHelloFrame(0x10000055),
      48000,
      DEFAULT_SAFE_CARRIER_MODULATION
    );

    let event = null;
    for (let i = 0; i < waveform.length; i += 512) {
      const chunk = waveform.subarray(i, Math.min(i + 512, waveform.length));
      event = pipeline.pushPcm(chunk, 48000, diagnostics, { source: 'rx_worklet_stream' }) ?? event;
    }

    expect(event?.classification).toBe('ok');
    expect(event?.frameType).toBe('HELLO');
    expect(diagnostics.detectorInputSource).toBe('rx_worklet_stream');
    expect(diagnostics.detectorInputContinuity).toBe('continuous_chunks');
    expect(diagnostics.detectorBufferFillSamples).toBeGreaterThan(0);
    expect(diagnostics.detectorBufferDroppedSamples).toBe(0);
    expect(diagnostics.preambleDetectorHits).toBeGreaterThanOrEqual(1);
    expect(diagnostics.parserInvocations).toBeGreaterThanOrEqual(1);
    expect(diagnostics.detectorPhaseBinsEvaluated).toBeGreaterThanOrEqual(diagnostics.detectorOffsetsEvaluated);
  });

  it('accounts for dropped samples when ring buffer overflows', () => {
    const pipeline = new LiveRxPipeline({ maxBufferSamples: 1024 });
    const diagnostics = pipeline.createInitialDiagnostics();

    const large = new Float32Array(3000).fill(0.01);
    pipeline.pushPcm(large, 48000, diagnostics, { source: 'rx_injected_samples' });

    expect(diagnostics.detectorBufferFillSamples).toBe(1024);
    expect(diagnostics.detectorBufferDroppedSamples).toBeGreaterThan(0);
    expect(diagnostics.detectorInputSource).toBe('rx_injected_samples');
    expect(diagnostics.detectorInputContinuity).toBe('continuous_chunks');
  });

  it('keeps sender and receiver safe preamble waveform compatibility exact', () => {
    const preambleOnly = modulateSafeBpskToWaveform(new Uint8Array(0), 48000, DEFAULT_SAFE_CARRIER_MODULATION);
    expect(preambleOnly.length).toBe(0);

    const preambleChips = generateSafePreamble();
    const expectedPrefix = new Float32Array(preambleChips.length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);
    for (let chipIndex = 0; chipIndex < preambleChips.length; chipIndex += 1) {
      const chip = preambleChips[chipIndex] ?? 0;
      for (let sampleOffset = 0; sampleOffset < DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip; sampleOffset += 1) {
        const sampleIndex = chipIndex * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip + sampleOffset;
        const phase = (2 * Math.PI * DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz * sampleIndex) / 48000;
        expectedPrefix[sampleIndex] = chip * DEFAULT_SAFE_CARRIER_MODULATION.amplitude * Math.sin(phase);
      }
    }

    const frameWaveform = modulateSafeFrameWithPreambleToWaveform(buildHelloFrame(0x10000056), 48000, DEFAULT_SAFE_CARRIER_MODULATION);
    const prefix = frameWaveform.subarray(0, expectedPrefix.length);
    expect(prefix.length).toBe(expectedPrefix.length);
    for (let i = 0; i < expectedPrefix.length; i += 1) {
      expect(Math.abs((prefix[i] ?? 0) - (expectedPrefix[i] ?? 0))).toBeLessThan(1e-6);
    }
  });

});
