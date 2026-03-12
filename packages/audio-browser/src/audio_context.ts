export interface AudioRuntimeInfo {
  readonly sampleRate: number;
  readonly baseLatency: number | null;
  readonly outputLatency: number | null;
  readonly state: AudioContextState;
}

export function collectAudioRuntimeInfo(ctx: AudioContext): AudioRuntimeInfo {
  const outputLatency = 'outputLatency' in ctx ? (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? null : null;

  return {
    sampleRate: ctx.sampleRate,
    baseLatency: Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : null,
    outputLatency,
    state: ctx.state
  };
}
