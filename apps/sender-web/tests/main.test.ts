import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FLAGS_MVP_DEFAULT, FRAME_TYPES, PROFILE_IDS, PROTOCOL_VERSION } from '../../../packages/contract/src/index.js';
import { encodeFrame } from '../../../packages/protocol/src/index.js';
import * as audioBrowser from '../../../packages/audio-browser/src/index.js';

const startTestToneMock = vi.fn();
const stopTestToneMock = vi.fn();
const sourceStartTimes: number[] = [];

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
  DEFAULT_SAFE_CARRIER_MODULATION: {
    carrierFrequencyHz: 1500,
    samplesPerChip: 24,
    amplitude: 0.1
  },
  modulateSafeBpskToWaveform: () => new Float32Array([0.1, -0.1, 0.1, -0.1])
}));

class FakeAudioContext {
  sampleRate = 48000;
  currentTime = 0;
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
      disconnect: () => undefined,
      start: (when?: number) => {
        sourceStartTimes.push(when ?? 0);
      },
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
    sourceStartTimes.length = 0;
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
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => undefined)
      }
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
    expect(diag).toContain('"senderState": "SUCCEEDED"');

    document.querySelector<HTMLButtonElement>('#sender-cancel')?.click();
    expect(document.querySelector('#sender-state')?.textContent).toBe('cancelled');
    expect(document.querySelector('#sender-diag')?.textContent ?? '').toContain('"sessionId": null');
  });

  it('supports separate status and verbose diagnostics views', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-diag-tab-verbose')?.click();
    const verbose = document.querySelector('#sender-diag-verbose')?.textContent ?? '';
    expect(verbose).toContain('Sender shell mounted. Diagnostics initialized.');

    document.querySelector<HTMLButtonElement>('#sender-diag-tab-status')?.click();
    const status = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(status).toContain('"senderState"');
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

  it('auto-starts runtime before HELLO and keeps attempts at zero when no file is selected', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
    for (let i = 0; i < 20 && document.querySelector('#sender-state')?.textContent !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const diag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(document.querySelector('#sender-state')?.textContent).toBe('ready');
    expect(diag).toContain('Select a file before sending HELLO.');
    expect(diag).toContain('"frameTransmitAttempts": 0');
    expect(diag).toContain('"category": "input_validation"');
  });

  it('freezes diagnostics rendering and resumes with latest pending snapshot', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-diag-freeze-toggle')?.click();
    const frozenSnapshot = document.querySelector('#sender-diag')?.textContent ?? '';

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('#sender-diag')?.textContent ?? '').toBe(frozenSnapshot);
    expect(document.querySelector('#sender-diag-freeze-status')?.textContent).toContain('frozen');

    document.querySelector<HTMLButtonElement>('#sender-diag-freeze-toggle')?.click();
    const resumedSnapshot = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(resumedSnapshot).toContain('Select a file before sending HELLO.');
    expect(document.querySelector('#sender-diag-freeze-status')?.textContent).toContain('live');
  });
  it('allows starting a new HELLO attempt without requiring manual reset', async () => {
    await import('../src/main.ts');

    const fileInput = document.querySelector<HTMLInputElement>('#sender-file');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.bin');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) }
    });

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
    for (let i = 0; i < 20 && document.querySelector('#sender-state')?.textContent !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const diag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(diag).toContain('HELLO transmitted over live TX path');
    expect(diag).not.toContain('sender START only valid in IDLE');
    expect(diag).toContain('"frameTransmitAttempts": 2');
  });

  it('schedules burst frame starts monotonically to avoid overlap', async () => {
    await import('../src/main.ts');

    const fileInput = document.querySelector<HTMLInputElement>('#sender-file');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.bin');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) }
    });

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
    await Promise.resolve();
    const helloStart = sourceStartTimes[sourceStartTimes.length - 1] ?? 0;

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
      detail: { frameHex: ackHex, frameType: 'HELLO_ACK', classification: 'ok' }
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const burstStart = sourceStartTimes[sourceStartTimes.length - 1] ?? 0;
    expect(sourceStartTimes.length).toBeGreaterThanOrEqual(2);
    expect(burstStart).toBeGreaterThan(helloStart);
  });


  it('prevents overlapping HELLO-start requests while file bytes are still loading', async () => {
    let unblock: (() => void) | null = null;
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      value: () => new Promise<ArrayBuffer>((resolve) => {
        unblock = () => resolve(new Uint8Array([1, 2, 3, 4]).buffer);
      })
    });

    await import('../src/main.ts');

    const fileInput = document.querySelector<HTMLInputElement>('#sender-file');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.bin');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) }
    });

    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
    document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();

    const pendingDiag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(pendingDiag).toContain('HELLO transmit request ignored because a previous HELLO attempt is still preparing.');

    unblock?.();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const snapshot = document.querySelector('#sender-diag')?.textContent ?? '';
      if (snapshot.includes('HELLO transmitted over live TX path')) {
        break;
      }
    }

    const finalDiag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(finalDiag).toContain('"frameTransmitAttempts": 1');
    expect(finalDiag).not.toContain('sender START only valid in IDLE');
  });

  it('retransmits HELLO on timeout and fails after retry limit', async () => {
    vi.useFakeTimers();
    try {
      await import('../src/main.ts');

      const fileInput = document.querySelector<HTMLInputElement>('#sender-file');
      const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.bin');
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) }
      });

      document.querySelector<HTMLButtonElement>('#sender-send-hello')?.click();
      await vi.advanceTimersByTimeAsync(50);

      for (let i = 0; i < 6; i += 1) {
        await vi.advanceTimersByTimeAsync(3200);
      }

      const diag = document.querySelector('#sender-diag')?.textContent ?? '';
      expect(diag).toContain('"timeoutsHelloAck": 6');
      expect(diag).toContain('"retransmissions": 5');
      expect(diag).toContain('"state": "FAILED"');
      expect(diag).toContain('HELLO_ACK retry limit reached in live sender shell.');
    } finally {
      vi.useRealTimers();
    }
  });


  it('copies diagnostics snapshot to clipboard', async () => {
    await import('../src/main.ts');

    document.querySelector<HTMLButtonElement>('#sender-diag-copy')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const writeText = vi.mocked(navigator.clipboard.writeText);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect((writeText.mock.calls[0]?.[0] ?? '')).toContain('"senderState"');

    const diag = document.querySelector('#sender-diag')?.textContent ?? '';
    expect(diag).toContain('Diagnostics copied to clipboard.');
    expect(diag).toContain('"clipboard"');
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
