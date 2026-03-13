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
  sampleRate = 48000;
  audioWorklet = { addModule: async () => undefined };
  destination = {};
  createBuffer(_ch: number, len: number): AudioBuffer {
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
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  it('handles start/decoded HELLO/cancel flow', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(document.querySelector('#receiver-state')?.textContent).toBe('listen');

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

    const dataHex = Array.from(encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.DATA,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x10000001,
      burstId: 0,
      slotIndex: 0,
      payloadFileOffset: 0,
      payload: new Uint8Array([1, 2, 3, 4])
    })).map((v) => v.toString(16).padStart(2, '0')).join('');

    window.dispatchEvent(new CustomEvent('fluffy-rotary-phone:receiver-decoded-rx-frame', {
      detail: {
        frameHex: dataHex,
        frameType: 'DATA',
        classification: 'ok'
      }
    }));

    const endHex = Array.from(encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.END,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x10000001,
      fileSizeBytes: 1024n,
      totalDataFrames: 2,
      fileCrc32c: 0x12345678
    })).map((v) => v.toString(16).padStart(2, '0')).join('');

    window.dispatchEvent(new CustomEvent('fluffy-rotary-phone:receiver-decoded-rx-frame', {
      detail: {
        frameHex: endHex,
        frameType: 'END',
        classification: 'ok'
      }
    }));

    const diag = document.querySelector('#receiver-diag')?.textContent ?? '';
    expect(diag).toContain('"handshakeResult": "accepted"');
    expect(diag).toContain('"processedHelloCount": 1');
    expect(diag).toContain('"lastFinalResponseHex"');

    document.querySelector<HTMLButtonElement>('#receiver-cancel')?.click();
    expect(document.querySelector('#receiver-state')?.textContent).toBe('cancelled');
    expect(document.querySelector('#receiver-diag')?.textContent ?? '').toContain('"sessionId": null');
  });

  it('exposes receiver pipeline diagnostics fields on startup', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    let diag: { rxPipeline?: { rxPipelineStage?: string; rxProcessorRole?: string; channelPolicy?: string } } = {};
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
      diag = JSON.parse(diagRaw) as { rxPipeline?: { rxPipelineStage?: string; rxProcessorRole?: string; channelPolicy?: string } };
      if (diag.rxPipeline?.rxPipelineStage && diag.rxPipeline.rxPipelineStage !== 'meter_only') {
        break;
      }
    }
    expect(diag.rxPipeline).toBeDefined();
    expect(diag.rxPipeline?.rxPipelineStage).not.toBe('meter_only');
    expect(diag.rxPipeline?.rxProcessorRole).toBe('rx_pipeline');
    expect(diag.rxPipeline?.channelPolicy).toBe('downmix_to_mono');
  });

  it('warns when audio is present but decode pipeline activity stays zero', async () => {
    vi.useFakeTimers();
    try {
      mockSampleAnalyserLevels.mockReturnValue({ rms: 0.2, peakAbs: 0.3, clipping: false });
      await import('../src/main.ts');

      document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
      await vi.advanceTimersByTimeAsync(4200);

      const diag = document.querySelector('#receiver-diag')?.textContent ?? '';
      expect(diag).toContain('audio present but no decode pipeline activity');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs decode pipeline and emits decoded HELLO into session path', async () => {
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
    mockCaptureAnalyserTimeDomain.mockReturnValue(waveform);

    await import('../src/main.ts');
    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const diagRaw = document.querySelector('#receiver-diag')?.textContent ?? '{}';
    const diag = JSON.parse(diagRaw) as {
      processedHelloCount?: number;
      rxPipeline?: { helloFramesSeen?: number; preambleDetectorHits?: number };
    };
    expect(diag.processedHelloCount).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.helloFramesSeen).toBeGreaterThanOrEqual(1);
    expect(diag.rxPipeline?.preambleDetectorHits).toBeGreaterThanOrEqual(1);
  });
});
