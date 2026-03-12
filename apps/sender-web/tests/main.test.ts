import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FLAGS_MVP_DEFAULT, FRAME_TYPES, PROFILE_IDS, PROTOCOL_VERSION } from '../../../packages/contract/src/index.js';
import { encodeFrame } from '../../../packages/protocol/src/index.js';
import * as audioBrowser from '../../../packages/audio-browser/src/index.js';

const startTestToneMock = vi.fn();
const stopTestToneMock = vi.fn();

vi.mock('../../../packages/audio-browser/src/index.js', () => {
  return {
    collectAudioRuntimeInfo: () => ({ sampleRate: 48000 }),
    createAudioGraphRuntime: () => ({
      rxAnalyser: {},
      txGain: {},
      testToneFrequencyHz: null,
      testToneStartedAtMs: null,
      startTestTone: startTestToneMock,
      stopTestTone: stopTestToneMock,
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

describe('sender web shell', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    startTestToneMock.mockReset();
    stopTestToneMock.mockReset();
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

  it('handles start/send/cancel and decoded RX HELLO_ACK event flow', async () => {
    await import('../src/main.ts');

    const startBtn = document.querySelector<HTMLButtonElement>('#sender-start');
    startBtn?.click();
    for (let i = 0; i < 20 && document.querySelector('#sender-state')?.textContent !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(document.querySelector('#sender-state')?.textContent).toBe('ready');

    const fileInput = document.querySelector<HTMLInputElement>('#sender-file');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.bin');
    const fileListLike = {
      0: file,
      length: 1,
      item: (index: number) => (index === 0 ? file : null)
    };
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: fileListLike
    });

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
    await Promise.resolve();

    const ackHex = Array.from(encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO_ACK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x12345678,
      acceptCode: 0x00,
      acceptedPayloadBytesPerFrame: 512,
      acceptedFramesPerBurst: 8
    })).map((v) => v.toString(16).padStart(2, '0')).join('');

    window.dispatchEvent(new CustomEvent('fluffy-rotary-phone:sender-decoded-rx-frame', {
      detail: {
        frameHex: ackHex,
        frameType: 'HELLO_ACK',
        classification: 'ok'
      }
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    const burstAckHex = Array.from(encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.BURST_ACK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x12345678,
      burstId: 0,
      slotCount: 1,
      ackBitmap: 0x0001
    })).map((v) => v.toString(16).padStart(2, '0')).join('');

    window.dispatchEvent(new CustomEvent('fluffy-rotary-phone:sender-decoded-rx-frame', {
      detail: {
        frameHex: burstAckHex,
        frameType: 'BURST_ACK',
        classification: 'ok'
      }
    }));

    const finalOkHex = Array.from(encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.FINAL_OK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x12345678,
      observedFileCrc32c: 0x29308cf4
    })).map((v) => v.toString(16).padStart(2, '0')).join('');

    window.dispatchEvent(new CustomEvent('fluffy-rotary-phone:sender-decoded-rx-frame', {
      detail: {
        frameHex: finalOkHex,
        frameType: 'FINAL_OK',
        classification: 'ok'
      }
    }));

    const diag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(diag).toContain('"handshakeResult": "accepted"');
    expect(diag).toContain('"state": "SUCCEEDED"');

    document.querySelector<HTMLButtonElement>('#sender-cancel')?.click();
    expect(document.querySelector('#sender-state')?.textContent).toBe('cancelled');
    expect(document.querySelector('#sender-diag')?.textContent ?? '').toContain('"sessionId": null');
  });

  it('starts runtime automatically before toggling tone', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-tone-toggle')?.click();
    for (let i = 0; i < 20 && document.querySelector('#sender-state')?.textContent !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(document.querySelector('#sender-state')?.textContent).toBe('ready');
    expect(startTestToneMock).toHaveBeenCalledTimes(1);
    expect(startTestToneMock).toHaveBeenCalledWith(1000);
    expect(document.querySelector('#sender-diag')?.textContent ?? '').not.toContain('Start sender runtime before toggling tone');
  });

  it('preserves startup root cause diagnostics when tone auto-start fails', async () => {
    vi.mocked(audioBrowser.requestMicStream).mockRejectedValueOnce(new Error('Permission denied by browser'));
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-tone-toggle')?.click();
    for (let i = 0; i < 20 && document.querySelector('#sender-state')?.textContent !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const diag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(document.querySelector('#sender-state')?.textContent).toBe('failed');
    expect(diag).toContain('Sender runtime startup failed: Error: Permission denied by browser');
    expect(diag).not.toContain('Unable to start sender runtime; cannot toggle tone.');
  });

  it('deduplicates concurrent auto-start requests from rapid tone toggles', async () => {
    let resolveStart: ((value: MediaStream) => void) | null = null;
    const delayedStart = new Promise<MediaStream>((resolve) => {
      resolveStart = resolve;
    });
    vi.mocked(audioBrowser.requestMicStream).mockReturnValueOnce(delayedStart);

    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-tone-toggle')?.click();
    document.querySelector<HTMLButtonElement>('#sender-tone-toggle')?.click();

    expect(audioBrowser.requestMicStream).toHaveBeenCalledTimes(1);

    resolveStart?.({
      getAudioTracks: () => [{ stop: vi.fn() }],
      getTracks: () => [{ stop: vi.fn() }]
    } as unknown as MediaStream);

    for (let i = 0; i < 20 && document.querySelector('#sender-state')?.textContent !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(document.querySelector('#sender-state')?.textContent).toBe('ready');
  });

  it('keeps decoded RX event listener single-mounted across remounts', async () => {
    const senderMain = await import('../src/main.ts');
    const remountRoot = document.createElement('div');
    senderMain.mountSenderShell(remountRoot);

    window.dispatchEvent(new CustomEvent('fluffy-rotary-phone:sender-decoded-rx-frame', {
      detail: {
        frameHex: '00',
        frameType: 'UNEXPECTED_TYPE',
        classification: 'ok'
      }
    }));

    const diag = remountRoot.querySelector('#sender-diag')?.textContent ?? '';
    expect(diag).toContain('unexpected decoded frame type for sender shell: UNEXPECTED_TYPE');
    expect(diag).toContain('"invalidTurnEvents": 1');
  });

  it('captures unexpected tone-toggle runtime errors without unhandled rejection', async () => {
    startTestToneMock.mockImplementationOnce(() => {
      throw new Error('Injected tone failure');
    });
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-tone-toggle')?.click();
    for (let i = 0; i < 20 && document.querySelector('#sender-state')?.textContent !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    const diag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(diag).toContain('Tone toggle failed: Error: Injected tone failure');
    expect(diag).toContain('Unexpected tone toggle failure.');
  });

  it('does not count HELLO transmit attempts when runtime is not started', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();

    const diag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(diag).toContain('Start sender runtime before transmitting HELLO.');
    expect(diag).toContain('"frameTransmitAttempts": 0');
    expect(diag).toContain('"category": "input_validation"');
  });

  it('includes staged startup diagnostics when worklet module registration fails', async () => {
    vi.mocked(audioBrowser.registerWorklet).mockRejectedValue(new DOMException("Unable to load a worklet's module.", 'AbortError'));
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-start')?.click();
    for (let i = 0; i < 20 && document.querySelector('#sender-state')?.textContent !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const diag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(document.querySelector('#sender-state')?.textContent).toBe('failed');
    expect(diag).toContain('"stage": "failed"');
    expect(diag).toContain('"workletModuleCandidates"');
    expect(diag).toContain('"workletModuleErrors"');
    expect(diag).toContain('/meter_processor.js');
    expect(diag).toContain('"lastError": "Error: Unable to register sender worklet.');
  });
});
