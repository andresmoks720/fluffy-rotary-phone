import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SAFE_CARRIER_MODULATION, generateSafePreamble } from '../../../packages/phy-safe/src/index.js';

const createdBuffers: Float32Array[] = [];

vi.mock('../../../packages/audio-browser/src/index.js', () => ({
  collectAudioRuntimeInfo: () => ({ sampleRate: 48000 }),
  createAudioGraphRuntime: () => ({
    rxAnalyser: {},
    txGain: {},
    testToneFrequencyHz: null,
    testToneStartedAtMs: null,
    startTestTone: vi.fn(),
    stopTestTone: vi.fn(),
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
  sampleAnalyserLevels: () => ({ rms: 0.1, peakAbs: 0.2, clipping: false })
}));

class FakeAudioContext {
  sampleRate = 48000;
  currentTime = 0;
  state: AudioContextState = 'running';
  audioWorklet = { addModule: async () => undefined };
  destination = {};

  createBuffer(_channels: number, length: number): AudioBuffer {
    const channel = new Float32Array(length);
    createdBuffers.push(channel);
    return {
      getChannelData: () => channel
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return {
      connect: () => undefined,
      disconnect: () => undefined,
      start: () => undefined,
      buffer: null
    } as unknown as AudioBufferSourceNode;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('sender TX preamble behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    createdBuffers.length = 0;
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal('AudioContext', FakeAudioContext);

    const cryptoObj = {
      getRandomValues: (arr: Uint32Array) => {
        arr[0] = 0x12345678;
        return arr;
      }
    };
    Object.defineProperty(window, 'crypto', {
      configurable: true,
      value: cryptoObj
    });

    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      value: async function arrayBuffer(): Promise<ArrayBuffer> {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      }
    });
  });

  it('prepends safe preamble samples for live HELLO TX waveform', async () => {
    await import('../src/main.ts');

    const fileInput = document.querySelector<HTMLInputElement>('#sender-file');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'hello.bin');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) }
    });

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
    for (let i = 0; i < 30 && createdBuffers.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const transmitted = createdBuffers[0];
    expect(transmitted).toBeDefined();

    const preambleSamples = generateSafePreamble().length * DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip;
    expect(transmitted.length).toBeGreaterThan(preambleSamples);

    const preambleSlice = transmitted.slice(0, preambleSamples);
    const peak = Math.max(...Array.from(preambleSlice).map((v) => Math.abs(v)));
    expect(peak).toBeGreaterThan(0.01);

    const rms = Math.sqrt(Array.from(preambleSlice).reduce((sum, v) => sum + (v * v), 0) / preambleSlice.length);
    expect(rms).toBeGreaterThan(0.005);
  }, 15000);
});
