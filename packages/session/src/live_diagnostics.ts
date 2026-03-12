export type LiveFailureCategory =
  | 'none'
  | 'input_validation'
  | 'decode_error'
  | 'crc_failure'
  | 'timeout'
  | 'retry_exhausted'
  | 'remote_reject'
  | 'protocol_error'
  | 'cancelled'
  | 'unknown';

export interface LiveTransferCounters {
  framesTx: number;
  framesRx: number;
  burstsTx: number;
  burstsRx: number;
  retransmissions: number;
  crcFailuresHeader: number;
  crcFailuresPayload: number;
  decodeFailures: number;
  timeoutsHelloAck: number;
  timeoutsBurstAck: number;
  timeoutsFinal: number;
}

export interface LiveDiagnosticsModel {
  state: string;
  sessionId: number | null;
  currentTurnOwner: 'sender' | 'receiver';
  profileId: number | null;
  elapsedMs: number;
  effectiveGoodputBps: number;
  audio: {
    actualSampleRateHz: number | null;
    inputChannelCount: number | null;
  };
  counters: LiveTransferCounters;
  failure: {
    category: LiveFailureCategory;
    reason: string | null;
  };
}

export function createInitialLiveDiagnostics(
  input: Pick<LiveDiagnosticsModel, 'state' | 'currentTurnOwner'>
): LiveDiagnosticsModel {
  return {
    state: input.state,
    sessionId: null,
    currentTurnOwner: input.currentTurnOwner,
    profileId: null,
    elapsedMs: 0,
    effectiveGoodputBps: 0,
    audio: {
      actualSampleRateHz: null,
      inputChannelCount: null
    },
    counters: {
      framesTx: 0,
      framesRx: 0,
      burstsTx: 0,
      burstsRx: 0,
      retransmissions: 0,
      crcFailuresHeader: 0,
      crcFailuresPayload: 0,
      decodeFailures: 0,
      timeoutsHelloAck: 0,
      timeoutsBurstAck: 0,
      timeoutsFinal: 0
    },
    failure: {
      category: 'none',
      reason: null
    }
  };
}
