import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FLAGS_MVP_DEFAULT,
  FRAME_TYPES,
  PROFILE_IDS,
  PROFILE_DEFAULTS,
  PROTOCOL_VERSION
} from '../../../packages/contract/src/index.js';
import { encodeFrame } from '../../../packages/protocol/src/index.js';

vi.mock('../../../packages/audio-browser/src/index.js', () => {
  return {
    appendWaveformDebugEntry: (_buf: unknown[], entry: unknown) => [entry],
    captureAnalyserTimeDomain: () => new Float32Array([0.1, 0.2]),
    collectAudioRuntimeInfo: () => ({ sampleRate: 48000 }),
    createAudioGraphRuntime: () => ({
      rxAnalyser: {},
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
    sampleAnalyserLevels: () => ({ rms: 0.1, peakAbs: 0.2, clipping: false }),
    summarizeAudioLevels: () => ({ rms: 0.1, peakAbs: 0.2, clipping: false })
  };
});

vi.mock('../../../packages/phy-safe/src/index.js', () => ({
  modulateSafeBpsk: () => new Int8Array([1, -1, 1, -1])
}));

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
    vi.restoreAllMocks();
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  it('handles start/decoded HELLO/cancel flow', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#receiver-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#receiver-state')?.textContent !== 'listen'; i += 1) {
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
        frameType: 'HELLO',
        classification: 'ok'
      }
    }));

    const diag = document.querySelector('#receiver-diag')?.textContent ?? '';
    expect(diag).toContain('"handshakeResult": "accepted"');
    expect(diag).toContain('"processedHelloCount": 1');

    document.querySelector<HTMLButtonElement>('#receiver-cancel')?.click();
    expect(document.querySelector('#receiver-state')?.textContent).toBe('cancelled');
    expect(document.querySelector('#receiver-diag')?.textContent ?? '').toContain('"sessionId": null');
  });
});
