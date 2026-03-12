export interface InputTrackDiagnostics {
  readonly sampleRate: number | null;
  readonly channelCount: number | null;
  readonly echoCancellation: boolean | null;
  readonly noiseSuppression: boolean | null;
  readonly autoGainControl: boolean | null;
}

export function readInputTrackDiagnostics(track: MediaStreamTrack): InputTrackDiagnostics {
  const settings = track.getSettings();
  return {
    sampleRate: settings.sampleRate ?? null,
    channelCount: settings.channelCount ?? null,
    echoCancellation: settings.echoCancellation ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
    autoGainControl: settings.autoGainControl ?? null
  };
}
