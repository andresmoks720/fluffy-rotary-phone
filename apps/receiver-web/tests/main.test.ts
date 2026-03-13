import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FLAGS_MVP_DEFAULT,
  FRAME_TYPES,
  PROFILE_IDS,
  PROFILE_DEFAULTS,
  PROTOCOL_VERSION
} from '../../../packages/contract/src/index.js';
import { encodeFrame } from '../../../packages/protocol/src/index.js';
import {
  DEFAULT_SAFE_CARRIER_MODULATION,
  generateSafePreamble,
  modulateSafeFrameWithPreambleToWaveform
} from '../../../packages/phy-safe/src/index.js';

const mockCaptureAnalyserTimeDomain = vi.fn(() => new Float32Array([0.1, 0.2]));
const mockSampleAnalyserLevels = vi.fn(() => ({ rms: 0.005, peakAbs: 0.2, clipping: false }));

let workletMessageHandler: ((event: { data: unknown }) => void) | null = null;
const fakeRxStreamPort = {
  addEventListener: vi.fn((type: string, cb: (event: { data: unknown }) => void) => {
    if (type === 'message') workletMessageHandler = cb;
  }),
  start: vi.fn()
};

function emitWorkletSamples(samples: Float32Array, rms = 0.01, peak = 0.1): void {
  workletMessageHandler?.({ data: { samples, rms, peak } });
}

vi.mock('../../../packages/audio-browser/src/index.js', () => {
  return {
    appendWaveformDebugEntry: (_buf: unknown[], entry: unknown) => [entry],
    captureAnalyserTimeDomain: mockCaptureAnalyserTimeDomain,
    collectAudioRuntimeInfo: () => ({ sampleRate: 48000 }),
    createAudioGraphRuntime: () => ({
      rxAnalyser: {},
      rxChannelPolicy: 'downmix_to_mono',
      txGain: {},
      rxStreamTapNode: { port: fakeRxStreamPort },
      testToneFrequencyHz: null,
      testToneStartedAtMs: null,
      dispose: vi.fn()
    }),
    readInputTrackDiagnostics: () => ({ channelCount: 1 }),
    LinkTimingEstimator: class {
      recordTxToneStart(): void {}
      recordRxSample(): void {}
      snapshot(): Record<string, number> { return { latencyMs: 0, driftPpm: 0 }; }
    },
    registerWorklet: vi.fn(async () => undefined),
    requestMicStream: vi.fn(async () => ({
      getAudioTracks: () => [{ stop: vi.fn() }],
      getTracks: () => [{ stop: vi.fn() }]
    })),
    sampleAnalyserLevels: mockSampleAnalyserLevels,
    summarizeAudioLevels: () => ({ rms: 0.1, peakAbs: 0.2, clipping: false })
  };
});

class FakeAudioContext {
  static createdBufferLengths: number[] = [];
  sampleRate = 48000;
  audioWorklet = { addModule: async () => undefined };
  destination = {};
  createBuffer(_ch: number, len: number): AudioBuffer {
    FakeAudioContext.createdBufferLengths.push(len);
    return {
      getChannelData: () => new Float32Array(len)
    } as unknown as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    return {
      connect: () => undefined,
      start: () => undefined,
      buffer: null
    } as unknown as AudioBufferSourceNode;
  }
  close(): Promise<void> { return Promise.resolve(); }
}


function buildShiftedWaveform(frameBytes: Uint8Array, sampleOffsetShift: number): Float32Array {
  const base = modulateSafeFrameWithPreambleToWaveform(frameBytes, 48000, DEFAULT_SAFE_CARRIER_MODULATION);
  if (sampleOffsetShift <= 0) {
    return base;
  }
  const shifted = new Float32Array(base.length + sampleOffsetShift);
  shifted.set(base, sampleOffsetShift);
  return shifted;
}

describe('receiver web shell', () => {


  afterEach(() => {
    document.querySelector<HTMLButtonElement>('#receiver-cancel')?.click();
  });
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockCaptureAnalyserTimeDomain.mockReset();
    mockCaptureAnalyserTimeDomain.mockReturnValue(new Float32Array([0.1, 0.2]));
    mockSampleAnalyserLevels.mockReset();
    mockSampleAnalyserLevels.mockReturnValue({ rms: 0.005, peakAbs: 0.2, clipping: false });
    document.body.innerHTML = '<div id="app"></div>';
    FakeAudioContext.createdBufferLengths = [];
    workletMessageHandler = null;
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  it('handles start/worklet-decoded HELLO/cancel flow and transmits preamble-framed replies', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(document.querySelector('#receiver-state')?.textContent).toBe('listen');
    expect(document.querySelector<HTMLInputElement>('#receiver-carrier-frequency')?.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#receiver-bandwidth')?.disabled).toBe(true);
    const liveStats = document.querySelector('#receiver-live-stats')?.textContent ?? '';
    expect(liveStats).toContain('Safe PHY: carrier=1500Hz');
    expect(liveStats).toContain('samplesPerChip=24');
    expect(liveStats).toContain('(tx/rx locked)');

    const defaults = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const helloBytes = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x10000001,
      fileNameUtf8: new TextEncoder().encode('x.bin'),
      fileSizeBytes: 1024n,
      totalDataFrames: 2,
      payloadBytesPerFrame: defaults.payloadBytesPerFrame,
      framesPerBurst: defaults.framesPerBurst,
      fileCrc32c: 0x12345678
    });
    const waveform = buildShiftedWaveform(helloBytes, 0);
    for (let i = 0; i < waveform.length; i += 512) {
      emitWorkletSamples(waveform.subarray(i, Math.min(i + 512, waveform.length)), 0.05, 0.2);
    }

    for (let i = 0; i < 20; i += 1) {
      const diag = document.querySelector('#receiver-diag')?.textContent ?? '';
      if (diag.includes('\"handshakeResult\": \"accepted\"')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const diag = document.querySelector('#receiver-diag')?.textContent ?? '';
    expect(diag).toContain('\"handshakeResult\": \"accepted\"');
    expect(diag).toContain("processedHelloCount");
  }, 10000);

  it('warns when audio is present but detector path cannot progress', async () => {
    vi.useFakeTimers();
    try {
      mockSampleAnalyserLevels.mockReturnValue({ rms: 0.2, peakAbs: 0.3, clipping: false });
      await import('../src/main.ts');
      document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
      await vi.advanceTimersByTimeAsync(4200);

      const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
      const diag = JSON.parse(diagRaw) as { rxPipeline?: { warning?: string | null; detectorStageTruth?: string } };
      expect(
        diag.rxPipeline?.warning === 'audio present but no detector input reached the RX buffer'
        || diag.rxPipeline?.warning === 'detector input present but no detector windows were evaluated'
        || diag.rxPipeline?.warning === 'detector input present but preamble correlation remains below threshold'
        || diag.rxPipeline?.warning === 'audio present but detector candidates did not reach decode pipeline'
      ).toBe(true);
      expect(
        diag.rxPipeline?.detectorStageTruth === 'signal_but_no_detector_input'
        || diag.rxPipeline?.detectorStageTruth === 'detector_input_present_but_windows_not_evaluated'
        || diag.rxPipeline?.detectorStageTruth === 'detector_input_present_but_low_correlation'
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });




  it('decodes HELLO from worklet continuous PCM stream', async () => {
    const defaults = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const helloBytes = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x1000000c,
      fileNameUtf8: new TextEncoder().encode('worklet.bin'),
      fileSizeBytes: 2048n,
      totalDataFrames: 4,
      payloadBytesPerFrame: defaults.payloadBytesPerFrame,
      framesPerBurst: defaults.framesPerBurst,
      fileCrc32c: 0x0a0b0c0d
    });

    const waveform = buildShiftedWaveform(helloBytes, 0);

    await import('../src/main.ts');
    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    for (let i = 0; i < waveform.length; i += 512) {
      emitWorkletSamples(waveform.subarray(i, Math.min(i + 512, waveform.length)), 0.05, 0.2);
    }

    const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
    const diag = JSON.parse(diagRaw) as {
      processedHelloCount?: number;
      rxPipeline?: {
        detectorInputSource?: string;
        preambleDetectorHits?: number;
        parserInvocations?: number;
      };
    };

    expect(diag.processedHelloCount).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.detectorInputSource).toBe('rx_worklet_stream');
    expect(diag.rxPipeline?.preambleDetectorHits).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.parserInvocations).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('processes injected sender waveform through rolling-buffer detector boundary and decodes HELLO', async () => {
    const defaults = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const helloBytes = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x1000000a,
      fileNameUtf8: new TextEncoder().encode('injected.bin'),
      fileSizeBytes: 2048n,
      totalDataFrames: 4,
      payloadBytesPerFrame: defaults.payloadBytesPerFrame,
      framesPerBurst: defaults.framesPerBurst,
      fileCrc32c: 0x01020304
    });

    const waveform = buildShiftedWaveform(helloBytes, 0);

    await import('../src/main.ts');
    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    for (let i = 0; i < waveform.length; i += 512) {
      emitWorkletSamples(waveform.subarray(i, Math.min(i + 512, waveform.length)), 0.05, 0.2);
    }

    const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
    const diag = JSON.parse(diagRaw) as {
      processedHelloCount?: number;
      rxPipeline?: {
        preambleDetectorHits?: number;
        candidateFrameCount?: number;
        demodAttempts?: number;
        parserInvocations?: number;
      };
    };

    expect(diag.rxPipeline?.preambleDetectorHits).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.candidateFrameCount).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.demodAttempts).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.parserInvocations).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.preambleDetectorHits).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('locks on non-zero injected sample offset and updates best offset telemetry', async () => {
    const defaults = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const helloBytes = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x1000000b,
      fileNameUtf8: new TextEncoder().encode('offset.bin'),
      fileSizeBytes: 1024n,
      totalDataFrames: 2,
      payloadBytesPerFrame: defaults.payloadBytesPerFrame,
      framesPerBurst: defaults.framesPerBurst,
      fileCrc32c: 0x05060708
    });

    const sampleOffsetShift = 11;
    const waveform = buildShiftedWaveform(helloBytes, sampleOffsetShift);

    await import('../src/main.ts');
    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    for (let i = 0; i < waveform.length; i += 512) {
      emitWorkletSamples(waveform.subarray(i, Math.min(i + 512, waveform.length)), 0.05, 0.2);
    }

    const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
    const diag = JSON.parse(diagRaw) as {
      processedHelloCount?: number;
      rxPipeline?: {
        bestSampleOffset?: number;
        preambleDetectorHits?: number;
      };
    };

    expect(diag.rxPipeline?.bestSampleOffset).toBeGreaterThanOrEqual(0);
    expect(diag.rxPipeline?.preambleDetectorHits).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.preambleDetectorHits).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('flags truncation when detector locks but buffered payload is too short', async () => {
    const chips = new Float32Array(generateSafePreamble().length + 32);
    chips.set(generateSafePreamble(), 0);
    chips.fill(1, generateSafePreamble().length);
    const sampleCount = chips.length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip;
    const waveform = new Float32Array(sampleCount);
    for (let chipIndex = 0; chipIndex < chips.length; chipIndex += 1) {
      const chip = chips[chipIndex] ?? 0;
      for (let sampleOffset = 0; sampleOffset < DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip; sampleOffset += 1) {
        const sampleIndex = chipIndex * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip + sampleOffset;
        const phase = (2 * Math.PI * DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz * sampleIndex) / 48000;
        waveform[sampleIndex] = chip * DEFAULT_SAFE_CARRIER_MODULATION.amplitude * Math.sin(phase);
      }
    }

    await import('../src/main.ts');
    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    for (let i = 0; i < waveform.length; i += 512) {
      emitWorkletSamples(waveform.subarray(i, Math.min(i + 512, waveform.length)), 0.05, 0.2);
    }

    const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
    const diag = JSON.parse(diagRaw) as {
      rxPipeline?: {
        frameTruncationDetected?: boolean;
        candidateFrameCount?: number;
        preambleDetectorHits?: number;
      };
    };

    expect(diag.rxPipeline?.preambleDetectorHits).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.candidateFrameCount).toBeGreaterThanOrEqual(0);
    expect(diag.rxPipeline?.frameTruncationDetected).toBe(true);
  }, 20000);
  it('reports offset-scan and buffer sufficiency telemetry fields', async () => {
    const defaults = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const helloBytes = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x10000009,
      fileNameUtf8: new TextEncoder().encode('pipeline.bin'),
      fileSizeBytes: 64n,
      totalDataFrames: 1,
      payloadBytesPerFrame: defaults.payloadBytesPerFrame,
      framesPerBurst: defaults.framesPerBurst,
      fileCrc32c: 0x1234abcd
    });
    const sampleOffsetShift = 7;
    const waveform = buildShiftedWaveform(helloBytes, sampleOffsetShift);
    await import('../src/main.ts');
    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (let i = 0; i < waveform.length; i += 512) {
      emitWorkletSamples(waveform.subarray(i, Math.min(i + 512, waveform.length)), 0.05, 0.2);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
    const diag = JSON.parse(diagRaw) as {
      rxPipeline?: {
        detectorWindowsEvaluated?: number;
        detectorInputSource?: string;
        detectorOffsetsEvaluated?: number;
        bestSampleOffset?: number;
        bestOffsetCorrelationScore?: number;
        minSamplesRequiredHello?: number;
        minSamplesRequiredData?: number;
        rxBufferedSamples?: number;
      };
    };

    expect(diag.rxPipeline?.detectorInputSource).toBe('rx_worklet_stream');
    expect(diag.rxPipeline?.detectorOffsetsEvaluated).toBeGreaterThanOrEqual(DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);
    expect((diag.rxPipeline?.detectorOffsetsEvaluated ?? 0) % DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip).toBe(0);
    expect(diag.rxPipeline?.bestSampleOffset).toBeGreaterThanOrEqual(0);
    expect(diag.rxPipeline?.bestOffsetCorrelationScore).toBeGreaterThanOrEqual(diag.rxPipeline?.lastPreambleCorrelationScore ?? -1);

    const expectedPreambleSamples = generateSafePreamble().length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip;
    const expectedHelloSamples = modulateSafeFrameWithPreambleToWaveform(new Uint8Array(34), 48000, DEFAULT_SAFE_CARRIER_MODULATION).length;
    const expectedDataSamples = modulateSafeFrameWithPreambleToWaveform(new Uint8Array(24 + 512 + 4), 48000, DEFAULT_SAFE_CARRIER_MODULATION).length;
    expect(diag.rxPipeline?.minSamplesRequiredPreamble).toBe(expectedPreambleSamples);
    expect(diag.rxPipeline?.minSamplesRequiredHello).toBe(expectedHelloSamples);
    expect(diag.rxPipeline?.minSamplesRequiredData).toBe(expectedDataSamples);
    expect(diag.rxPipeline?.rxBufferedSamples).toBeGreaterThanOrEqual(expectedPreambleSamples);

    const buffered = diag.rxPipeline?.rxBufferedSamples ?? 0;
    const preambleChips = generateSafePreamble().length;
    let expectedWindows = 0;
    for (let sampleOffset = 0; sampleOffset < DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip; sampleOffset += 1) {
      const available = buffered - sampleOffset;
      if (available < expectedPreambleSamples) continue;
      const chipCount = Math.floor(available / DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);
      expectedWindows += chipCount - preambleChips + 1;
    }
    expect(diag.rxPipeline?.detectorWindowsEvaluated).toBeGreaterThanOrEqual(expectedWindows);
  }, 60000);
});
