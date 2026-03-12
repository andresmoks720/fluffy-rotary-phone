import { FRAME_TYPES } from '../../contract/src/index.js';

export type FrameDecodeFailureReason =
  | 'none'
  | 'invalid_frame_type'
  | 'header_crc_failure'
  | 'payload_crc_failure'
  | 'decode_failure';

export interface LivePathFrameCounters {
  readonly frameAttempts: number;
  readonly decodeSuccesses: number;
  readonly headerCrcFailures: number;
  readonly payloadCrcFailures: number;
  readonly invalidFrameTypeFailures: number;
  readonly decodeFailures: number;
}

export interface LivePathFrameMetrics {
  readonly counters: LivePathFrameCounters;
  readonly decodeSuccessRate: number;
  readonly lastFailureReason: string | null;
}

export const INITIAL_LIVE_PATH_FRAME_METRICS: LivePathFrameMetrics = {
  counters: {
    frameAttempts: 0,
    decodeSuccesses: 0,
    headerCrcFailures: 0,
    payloadCrcFailures: 0,
    invalidFrameTypeFailures: 0,
    decodeFailures: 0
  },
  decodeSuccessRate: 0,
  lastFailureReason: null
};

export function isValidFrameType(frameType: number): boolean {
  return Object.values(FRAME_TYPES).includes(frameType as never);
}

export function classifyDecodeFailure(error: unknown): FrameDecodeFailureReason {
  if (!(error instanceof Error)) {
    return 'decode_failure';
  }

  if (error.message.includes('header CRC32C mismatch')) {
    return 'header_crc_failure';
  }

  if (error.message.includes('payload CRC32C mismatch')) {
    return 'payload_crc_failure';
  }

  if (error.message.includes('unknown frame type')) {
    return 'invalid_frame_type';
  }

  return 'decode_failure';
}

export function recordFrameDecodeAttempt(
  metrics: LivePathFrameMetrics,
  outcome: { readonly ok: true } | { readonly ok: false; readonly reason: FrameDecodeFailureReason; readonly details: string }
): LivePathFrameMetrics {
  let nextCounters: LivePathFrameCounters = {
    ...metrics.counters,
    frameAttempts: metrics.counters.frameAttempts + 1
  };

  let lastFailureReason = metrics.lastFailureReason;

  if (outcome.ok) {
    nextCounters = {
      ...nextCounters,
      decodeSuccesses: nextCounters.decodeSuccesses + 1
    };
  } else {
    lastFailureReason = outcome.details;
    if (outcome.reason === 'header_crc_failure') {
      nextCounters = { ...nextCounters, headerCrcFailures: nextCounters.headerCrcFailures + 1 };
    } else if (outcome.reason === 'payload_crc_failure') {
      nextCounters = { ...nextCounters, payloadCrcFailures: nextCounters.payloadCrcFailures + 1 };
    } else if (outcome.reason === 'invalid_frame_type') {
      nextCounters = { ...nextCounters, invalidFrameTypeFailures: nextCounters.invalidFrameTypeFailures + 1 };
    } else {
      nextCounters = { ...nextCounters, decodeFailures: nextCounters.decodeFailures + 1 };
    }
  }

  const decodeSuccessRate = nextCounters.frameAttempts === 0 ? 0 : nextCounters.decodeSuccesses / nextCounters.frameAttempts;
  return {
    counters: nextCounters,
    decodeSuccessRate,
    lastFailureReason
  };
}

