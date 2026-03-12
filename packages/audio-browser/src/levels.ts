export interface AudioLevelSummary {
  readonly rms: number;
  readonly peakAbs: number;
  readonly clipping: boolean;
}

export interface AnalyserLike {
  readonly fftSize: number;
  getFloatTimeDomainData(target: Float32Array): void;
}

export interface WaveformDebugEntry {
  readonly timestampMs: number;
  readonly levels: AudioLevelSummary;
}

export function summarizeAudioLevels(samples: Float32Array, clippingThreshold = 0.98): AudioLevelSummary {
  let sumSquares = 0;
  let peakAbs = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!;
    const abs = Math.abs(v);
    sumSquares += v * v;
    if (abs > peakAbs) {
      peakAbs = abs;
    }
  }

  const rms = samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);
  return {
    rms,
    peakAbs,
    clipping: peakAbs >= clippingThreshold
  };
}

export function captureAnalyserTimeDomain(analyser: AnalyserLike, maxSamples = 256): Float32Array {
  const requestedCount = Math.max(1, Math.floor(maxSamples));
  const sampleCount = Math.min(analyser.fftSize, requestedCount);
  const fullWindow = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(fullWindow);
  return fullWindow.slice(0, sampleCount);
}

export function appendWaveformDebugEntry(
  buffer: readonly WaveformDebugEntry[],
  entry: WaveformDebugEntry,
  maxEntries = 64
): readonly WaveformDebugEntry[] {
  const cappedCount = Math.max(1, Math.floor(maxEntries));
  const next = [...buffer, entry];
  if (next.length <= cappedCount) {
    return next;
  }

  return next.slice(next.length - cappedCount);
}

export function sampleAnalyserLevels(analyser: AnalyserLike, clippingThreshold = 0.98): AudioLevelSummary {
  const samples = captureAnalyserTimeDomain(analyser, analyser.fftSize);
  return summarizeAudioLevels(samples, clippingThreshold);
}
