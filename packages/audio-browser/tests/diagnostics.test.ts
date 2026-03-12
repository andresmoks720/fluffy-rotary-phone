import { describe, expect, it } from 'vitest';

import { collectAudioRuntimeInfo, readInputTrackDiagnostics } from '../src/index.js';

describe('audio diagnostics helpers', () => {
  it('collects runtime context info', () => {
    const fakeContext = {
      sampleRate: 48000,
      baseLatency: 0.01,
      outputLatency: 0.02,
      state: 'running'
    } as unknown as AudioContext;

    expect(collectAudioRuntimeInfo(fakeContext)).toEqual({
      sampleRate: 48000,
      baseLatency: 0.01,
      outputLatency: 0.02,
      state: 'running'
    });
  });

  it('reads input track settings explicitly', () => {
    const fakeTrack = {
      getSettings: () => ({
        sampleRate: 44100,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      })
    } as unknown as MediaStreamTrack;

    expect(readInputTrackDiagnostics(fakeTrack)).toEqual({
      sampleRate: 44100,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    });
  });
});
