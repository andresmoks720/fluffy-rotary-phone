import { describe, expect, it } from 'vitest';

import {
  appendWaveformDebugEntry,
  captureAnalyserTimeDomain,
  sampleAnalyserLevels,
  summarizeAudioLevels,
  type WaveformDebugEntry
} from '../src/index.js';

describe('summarizeAudioLevels', () => {
  it('computes rms and peak', () => {
    const summary = summarizeAudioLevels(Float32Array.from([0, 0.5, -0.5, 1]));
    expect(summary.peakAbs).toBe(1);
    expect(summary.rms).toBeGreaterThan(0.6);
    expect(summary.rms).toBeLessThan(0.7);
    expect(summary.clipping).toBe(true);
  });

  it('handles empty samples', () => {
    expect(summarizeAudioLevels(new Float32Array())).toEqual({ rms: 0, peakAbs: 0, clipping: false });
  });

  it('samples levels from analyser-like source', () => {
    const analyser = {
      fftSize: 4,
      getFloatTimeDomainData(target: Float32Array) {
        target.set([0.1, -0.2, 0.3, -0.4]);
      }
    };

    const summary = sampleAnalyserLevels(analyser, 0.95);
    expect(summary.peakAbs).toBeCloseTo(0.4, 6);
    expect(summary.clipping).toBe(false);
    expect(summary.rms).toBeGreaterThan(0.26);
    expect(summary.rms).toBeLessThan(0.28);
  });

  it('captures time-domain sample windows with max-sample clamp', () => {
    const analyser = {
      fftSize: 8,
      getFloatTimeDomainData(target: Float32Array) {
        target.set([0.1, 0.2, 0.3, 0.4, -0.1, -0.2, -0.3, -0.4]);
      }
    };

    const snapshot = captureAnalyserTimeDomain(analyser, 3);
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toBeCloseTo(0.1, 6);
    expect(snapshot[1]).toBeCloseTo(0.2, 6);
    expect(snapshot[2]).toBeCloseTo(0.3, 6);
  });

  it('appends debug entries with deterministic capped history', () => {
    const first: WaveformDebugEntry = {
      timestampMs: 1,
      levels: { rms: 0.1, peakAbs: 0.2, clipping: false }
    };
    const second: WaveformDebugEntry = {
      timestampMs: 2,
      levels: { rms: 0.3, peakAbs: 0.5, clipping: false }
    };
    const third: WaveformDebugEntry = {
      timestampMs: 3,
      levels: { rms: 0.8, peakAbs: 1, clipping: true }
    };

    const one = appendWaveformDebugEntry([], first, 2);
    const two = appendWaveformDebugEntry(one, second, 2);
    const three = appendWaveformDebugEntry(two, third, 2);

    expect(one).toEqual([first]);
    expect(two).toEqual([first, second]);
    expect(three).toEqual([second, third]);
  });
});
