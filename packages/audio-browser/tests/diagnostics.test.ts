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
