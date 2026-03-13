import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  modulateSafeBpsk
} from '../../../packages/phy-safe/src/index.js';

const mockCaptureAnalyserTimeDomain = vi.fn(() => new Float32Array([0.1, 0.2]));
const mockSampleAnalyserLevels = vi.fn(() => ({ rms: 0.005, peakAbs: 0.2, clipping: false }));

vi.mock('../../../packages/audio-browser/src/index.js', () => {
  return {
    appendWaveformDebugEntry: (_buf: unknown[], entry: unknown) => [entry],
    captureAnalyserTimeDomain: mockCaptureAnalyserTimeDomain,
    collectAudioRuntimeInfo: () => ({ sampleRate: 48000 }),
    createAudioGraphRuntime: () => ({
      rxAnalyser: {},
      rxChannelPolicy: 'downmix_to_mono',
      txGain: {},
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

describe('receiver web shell', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockCaptureAnalyserTimeDomain.mockReset();
    mockCaptureAnalyserTimeDomain.mockReturnValue(new Float32Array([0.1, 0.2]));
    mockSampleAnalyserLevels.mockReset();
    mockSampleAnalyserLevels.mockReturnValue({ rms: 0.005, peakAbs: 0.2, clipping: false });
    document.body.innerHTML = '<div id="app"></div>';
    FakeAudioContext.createdBufferLengths = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  it('handles start/decoded HELLO/cancel flow and transmits preamble-framed replies', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(document.querySelector('#receiver-state')?.textContent).toBe('listen');
    expect(document.querySelector<HTMLInputElement>('#receiver-carrier-frequency')?.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#receiver-bandwidth')?.disabled).toBe(true);

    const defaults = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const helloHex = Array.from(encodeFrame({
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
    })).map((v) => v.toString(16).padStart(2, '0')).join('');

    window.dispatchEvent(new CustomEvent('fluffy-rotary-phone:receiver-decoded-rx-frame', {
      detail: {
        frameHex: helloHex,
        frameType: 'HEADER',
        classification: 'ok'
      }
    }));

    const diag = document.querySelector('#receiver-diag')?.textContent ?? '';
    expect(diag).toContain('"handshakeResult": "accepted"');
    expect(FakeAudioContext.createdBufferLengths.some((len) => (
      len >= generateSafePreamble().length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip
    ))).toBe(true);
  }, 10000);

  it('warns when audio is present but detector path cannot progress', async () => {
    vi.useFakeTimers();
    try {
      mockSampleAnalyserLevels.mockReturnValue({ rms: 0.2, peakAbs: 0.3, clipping: false });
      await import('../src/main.ts');
      document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
      await vi.advanceTimersByTimeAsync(4200);

      const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
      const diag = JSON.parse(diagRaw) as { rxPipeline?: { warning?: string | null } };
      expect(
        diag.rxPipeline?.warning === 'audio present but no detector activity'
        || diag.rxPipeline?.warning === 'audio present but preamble correlation remains below threshold'
        || diag.rxPipeline?.warning === 'audio present but buffered samples are insufficient for preamble detection'
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

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
    const chips = new Float32Array(generateSafePreamble().length + helloBytes.length * 8);
    chips.set(generateSafePreamble(), 0);
    chips.set(modulateSafeBpsk(helloBytes), generateSafePreamble().length);
    const sampleOffsetShift = 7;
    const sampleCount = chips.length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip;
    const waveform = new Float32Array(sampleCount + sampleOffsetShift);
    for (let chipIndex = 0; chipIndex < chips.length; chipIndex += 1) {
      const chip = chips[chipIndex] ?? 0;
      for (let sampleOffset = 0; sampleOffset < DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip; sampleOffset += 1) {
        const sampleIndex = sampleOffsetShift + chipIndex * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip + sampleOffset;
        const phase = (2 * Math.PI * DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz * sampleIndex) / 48000;
        waveform[sampleIndex] = chip * DEFAULT_SAFE_CARRIER_MODULATION.amplitude * Math.sin(phase);
      }
    }
    mockCaptureAnalyserTimeDomain.mockReturnValueOnce(waveform);
    mockCaptureAnalyserTimeDomain.mockReturnValue(new Float32Array(2048));

    await import('../src/main.ts');
    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

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

    expect(diag.rxPipeline?.detectorWindowsEvaluated).toBeGreaterThanOrEqual(0);
    expect(diag.rxPipeline?.detectorInputSource).toBe('rx_analyser_time_domain_snapshot');
    expect(diag.rxPipeline?.detectorOffsetsEvaluated).toBeGreaterThanOrEqual(DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);
    expect(diag.rxPipeline?.bestSampleOffset).toBeGreaterThanOrEqual(0);
    expect(diag.rxPipeline?.bestOffsetCorrelationScore).toBeGreaterThanOrEqual(-1);
    expect(diag.rxPipeline?.minSamplesRequiredHello).toBeGreaterThanOrEqual(0);
    expect(diag.rxPipeline?.minSamplesRequiredData).toBeGreaterThanOrEqual(0);
    expect(diag.rxPipeline?.rxBufferedSamples).toBeGreaterThanOrEqual(0);
  }, 60000);
});
