export interface InputTrackDiagnostics {
  readonly deviceId: string | null;
  readonly label: string | null;
  readonly enabled: boolean;
  readonly muted: boolean;
  readonly readyState: string;
  readonly sampleRate: number | null;
  readonly channelCount: number | null;
  readonly echoCancellation: boolean | null;
  readonly noiseSuppression: boolean | null;
  readonly autoGainControl: boolean | null;
}

export interface LinkTimingDiagnostics {
  readonly oneWayLatencyEstimateMs: number | null;
  readonly driftTrendPpm: number | null;
  readonly driftTrendMsPerMin: number | null;
  readonly matchedLatencySampleCount: number;
  readonly pendingTxToneCount: number;
}

interface LinkTimingEstimatorOptions {
  readonly shortWindowSize?: number;
  readonly longWindowSize?: number;
  readonly rxDetectRmsThreshold?: number;
}

interface LatencySample {
  readonly txTimestampMs: number;
  readonly latencyMs: number;
}

class FixedRingBuffer<T> {
  private readonly capacity: number;
  private readonly buffer: T[];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Invalid ring buffer capacity: ${capacity}`);
    }

    this.capacity = capacity;
    this.buffer = [];
  }

  append(value: T): void {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }

    this.buffer.push(value);
  }

  shift(): T | undefined {
    return this.buffer.shift();
  }

  get length(): number {
    return this.buffer.length;
  }

  toArray(): readonly T[] {
    return this.buffer;
  }
}

export class LinkTimingEstimator {
  private readonly shortWindowSize: number;
  private readonly rxDetectRmsThreshold: number;
  private readonly pendingTxToneStarts: FixedRingBuffer<number>;
  private readonly latencySamples: FixedRingBuffer<LatencySample>;
  private wasAboveThreshold = false;

  constructor(options: LinkTimingEstimatorOptions = {}) {
    this.shortWindowSize = options.shortWindowSize ?? 8;
    const longWindowSize = options.longWindowSize ?? 32;

    this.rxDetectRmsThreshold = options.rxDetectRmsThreshold ?? 0.05;
    this.pendingTxToneStarts = new FixedRingBuffer<number>(longWindowSize);
    this.latencySamples = new FixedRingBuffer<LatencySample>(longWindowSize);
  }

  recordTxToneStart(timestampMs: number): void {
    this.pendingTxToneStarts.append(timestampMs);
  }

  recordRxSample(timestampMs: number, rmsLevel: number, toneActive: boolean): void {
    const aboveThreshold = rmsLevel >= this.rxDetectRmsThreshold;
    const crossedUp = aboveThreshold && !this.wasAboveThreshold;

    if (!aboveThreshold && !toneActive) {
      this.wasAboveThreshold = false;
      return;
    }

    if (crossedUp && this.pendingTxToneStarts.length > 0) {
      const txStart = this.pendingTxToneStarts.shift();
      if (txStart !== undefined && timestampMs >= txStart) {
        this.latencySamples.append({
          txTimestampMs: txStart,
          latencyMs: timestampMs - txStart
        });
      }
    }

    this.wasAboveThreshold = aboveThreshold;
  }

  snapshot(): LinkTimingDiagnostics {
    const latencyValues = this.latencySamples.toArray();
    const shortWindowStart = Math.max(0, latencyValues.length - this.shortWindowSize);
    const shortWindow = latencyValues.slice(shortWindowStart);
    const oneWayLatencyEstimateMs =
      shortWindow.length > 0
        ? shortWindow.reduce((sum, sample) => sum + sample.latencyMs, 0) / shortWindow.length
        : null;

    const drift = calculateLatencyDrift(latencyValues);

    return {
      oneWayLatencyEstimateMs,
      driftTrendPpm: drift?.ppm ?? null,
      driftTrendMsPerMin: drift?.msPerMin ?? null,
      matchedLatencySampleCount: latencyValues.length,
      pendingTxToneCount: this.pendingTxToneStarts.length
    };
  }
}

function calculateLatencyDrift(
  samples: readonly LatencySample[]
): { readonly ppm: number; readonly msPerMin: number } | null {
  if (samples.length < 2) {
    return null;
  }

  const meanX = samples.reduce((sum, sample) => sum + sample.txTimestampMs, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample.latencyMs, 0) / samples.length;

  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const dx = sample.txTimestampMs - meanX;
    numerator += dx * (sample.latencyMs - meanY);
    denominator += dx * dx;
  }

  if (denominator === 0) {
    return null;
  }

  const slopeMsPerMs = numerator / denominator;
  return {
    ppm: slopeMsPerMs * 1_000_000,
    msPerMin: slopeMsPerMs * 60_000
  };
}

export function readInputTrackDiagnostics(track: MediaStreamTrack): InputTrackDiagnostics {
  const settings = track.getSettings();
  return {
    deviceId: settings.deviceId ?? null,
    label: track.label ?? null,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    sampleRate: settings.sampleRate ?? null,
    channelCount: settings.channelCount ?? null,
    echoCancellation: settings.echoCancellation ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
    autoGainControl: settings.autoGainControl ?? null
  };
}
