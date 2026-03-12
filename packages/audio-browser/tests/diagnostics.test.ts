import { describe, expect, it } from 'vitest';

import {
  LinkTimingEstimator,
  collectAudioRuntimeInfo,
  readInputTrackDiagnostics
} from '../src/index.js';

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

  it('estimates stable one-way latency with near-zero drift', () => {
    const estimator = new LinkTimingEstimator({ shortWindowSize: 4, longWindowSize: 16 });

    for (let i = 0; i < 8; i += 1) {
      const txStartMs = i * 1000;
      estimator.recordTxToneStart(txStartMs);
      estimator.recordRxSample(txStartMs + 120, 0.2, true);
      estimator.recordRxSample(txStartMs + 130, 0, false);
    }

    const snapshot = estimator.snapshot();
    expect(snapshot.oneWayLatencyEstimateMs).toBeCloseTo(120, 6);
    expect(snapshot.driftTrendPpm).toBeCloseTo(0, 6);
    expect(snapshot.driftTrendMsPerMin).toBeCloseTo(0, 6);
    expect(snapshot.matchedLatencySampleCount).toBe(8);
    expect(snapshot.pendingTxToneCount).toBe(0);
  });

  it('reports positive drift when latency rises over time', () => {
    const estimator = new LinkTimingEstimator({ longWindowSize: 16 });

    for (let i = 0; i < 6; i += 1) {
      const txStartMs = i * 1000;
      estimator.recordTxToneStart(txStartMs);
      estimator.recordRxSample(txStartMs + 100 + i * 5, 0.2, true);
      estimator.recordRxSample(txStartMs + 150 + i * 5, 0, false);
    }

    const snapshot = estimator.snapshot();
    expect(snapshot.driftTrendPpm).not.toBeNull();
    expect(snapshot.driftTrendMsPerMin).not.toBeNull();
    expect(snapshot.driftTrendPpm!).toBeGreaterThan(0);
    expect(snapshot.driftTrendMsPerMin!).toBeGreaterThan(0);
  });

  it('reports negative drift when latency drops over time', () => {
    const estimator = new LinkTimingEstimator({ longWindowSize: 16 });

    for (let i = 0; i < 6; i += 1) {
      const txStartMs = i * 1000;
      estimator.recordTxToneStart(txStartMs);
      estimator.recordRxSample(txStartMs + 140 - i * 4, 0.2, true);
      estimator.recordRxSample(txStartMs + 180 - i * 4, 0, false);
    }

    const snapshot = estimator.snapshot();
    expect(snapshot.driftTrendPpm).not.toBeNull();
    expect(snapshot.driftTrendMsPerMin).not.toBeNull();
    expect(snapshot.driftTrendPpm!).toBeLessThan(0);
    expect(snapshot.driftTrendMsPerMin!).toBeLessThan(0);
  });



  it('exposes requested vs applied settings distinctly', () => {
    const requested = {
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    };
    const fakeTrack = {
      getSettings: () => ({
        sampleRate: 48000,
        channelCount: 2,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      })
    } as unknown as MediaStreamTrack;

    const applied = readInputTrackDiagnostics(fakeTrack);
    expect(requested.audio.channelCount).toBe(1);
    expect(applied.channelCount).toBe(2);
    expect(requested.audio.echoCancellation).toBe(false);
    expect(applied.echoCancellation).toBe(true);
  });

  it('reports actual audio context sample rate explicitly', () => {
    const fakeContext = {
      sampleRate: 44100,
      baseLatency: 0.01,
      outputLatency: 0.02,
      state: 'running'
    } as unknown as AudioContext;

    const runtime = collectAudioRuntimeInfo(fakeContext);
    expect(runtime.sampleRate).toBe(44100);
  });

  it('returns null estimates when data is insufficient', () => {
    const estimator = new LinkTimingEstimator();

    let snapshot = estimator.snapshot();
    expect(snapshot.oneWayLatencyEstimateMs).toBeNull();
    expect(snapshot.driftTrendPpm).toBeNull();
    expect(snapshot.driftTrendMsPerMin).toBeNull();

    estimator.recordTxToneStart(1000);
    estimator.recordRxSample(1120, 0.2, true);
    estimator.recordRxSample(1150, 0, false);

    snapshot = estimator.snapshot();
    expect(snapshot.oneWayLatencyEstimateMs).toBeCloseTo(120, 6);
    expect(snapshot.driftTrendPpm).toBeNull();
    expect(snapshot.driftTrendMsPerMin).toBeNull();
  });
});


describe('diagnostics estimator invariants', () => {
  it('converges after a latency step change within bounded samples', () => {
    const estimator = new LinkTimingEstimator({ shortWindowSize: 4, longWindowSize: 32 });

    for (let i = 0; i < 8; i += 1) {
      const tx = i * 100;
      estimator.recordTxToneStart(tx);
      estimator.recordRxSample(tx + 80, 0.2, true);
      estimator.recordRxSample(tx + 90, 0, false);
    }

    for (let i = 8; i < 20; i += 1) {
      const tx = i * 100;
      estimator.recordTxToneStart(tx);
      estimator.recordRxSample(tx + 140, 0.2, true);
      estimator.recordRxSample(tx + 150, 0, false);
    }

    const snapshot = estimator.snapshot();
    expect(snapshot.oneWayLatencyEstimateMs).toBeCloseTo(140, 6);
    expect(snapshot.matchedLatencySampleCount).toBe(20);
  });

  it('keeps diagnostics finite under stress updates', () => {
    const estimator = new LinkTimingEstimator({ shortWindowSize: 8, longWindowSize: 16 });

    for (let i = 0; i < 100; i += 1) {
      const tx = i * 33;
      estimator.recordTxToneStart(tx);
      estimator.recordRxSample(tx + 100 + (i % 3), 0.2, true);
      estimator.recordRxSample(tx + 110 + (i % 3), 0, false);
    }

    const snapshot = estimator.snapshot();
    expect(Number.isFinite(snapshot.oneWayLatencyEstimateMs!)).toBe(true);
    expect(Number.isFinite(snapshot.driftTrendPpm!)).toBe(true);
    expect(Number.isFinite(snapshot.driftTrendMsPerMin!)).toBe(true);
    expect(Number.isFinite(snapshot.matchedLatencySampleCount)).toBe(true);
    expect(Number.isFinite(snapshot.pendingTxToneCount)).toBe(true);
  });

  it('maintains counter invariants for matched and pending counts', () => {
    const estimator = new LinkTimingEstimator({ longWindowSize: 8 });

    estimator.recordTxToneStart(1000);
    estimator.recordTxToneStart(2000);
    estimator.recordTxToneStart(3000);

    estimator.recordRxSample(1100, 0.2, true);
    estimator.recordRxSample(1150, 0, false);
    estimator.recordRxSample(2200, 0.2, true);
    estimator.recordRxSample(2250, 0, false);

    const snapshot = estimator.snapshot();
    expect(snapshot.matchedLatencySampleCount).toBe(2);
    expect(snapshot.pendingTxToneCount).toBe(1);
    expect(snapshot.matchedLatencySampleCount + snapshot.pendingTxToneCount).toBe(3);
  });
});
