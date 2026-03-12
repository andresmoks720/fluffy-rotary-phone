import { FRAME_TYPES } from '../../contract/src/index.js';

import { decodeFrame } from './frame_codec.js';
import type { DecodeOptions, Frame } from './types.js';

export interface LiveFrameDiagnosticsCounters {
  frameAttempts: number;
  decodeSuccesses: number;
  headerCrcFailures: number;
  payloadCrcFailures: number;
  invalidFrameTypeFailures: number;
  otherDecodeFailures: number;
  lastFailureReason: string | null;
}

export interface LiveFrameDecodeResult {
  ok: boolean;
  frame: Frame | null;
  failureReason: string | null;
}

export function createLiveFrameDiagnosticsCounters(): LiveFrameDiagnosticsCounters {
  return {
    frameAttempts: 0,
    decodeSuccesses: 0,
    headerCrcFailures: 0,
    payloadCrcFailures: 0,
    invalidFrameTypeFailures: 0,
    otherDecodeFailures: 0,
    lastFailureReason: null
  };
}

export function readFrameDecodeSuccessRate(counters: LiveFrameDiagnosticsCounters): number {
  if (counters.frameAttempts === 0) {
    return 0;
  }
  return counters.decodeSuccesses / counters.frameAttempts;
}

function isValidFrameType(frameType: number): boolean {
  return frameType === FRAME_TYPES.HELLO
    || frameType === FRAME_TYPES.HELLO_ACK
    || frameType === FRAME_TYPES.DATA
    || frameType === FRAME_TYPES.BURST_ACK
    || frameType === FRAME_TYPES.END
    || frameType === FRAME_TYPES.FINAL_OK
    || frameType === FRAME_TYPES.FINAL_BAD
    || frameType === FRAME_TYPES.CANCEL;
}

function classifyFailureReason(reason: string): keyof Pick<LiveFrameDiagnosticsCounters,
  'headerCrcFailures' | 'payloadCrcFailures' | 'invalidFrameTypeFailures' | 'otherDecodeFailures'> {
  const normalized = reason.toLowerCase();
  if (normalized.includes('header crc32c mismatch')) {
    return 'headerCrcFailures';
  }
  if (normalized.includes('payload crc32c mismatch')) {
    return 'payloadCrcFailures';
  }
  if (normalized.includes('unknown frame type') || normalized.includes('invalid frame type')) {
    return 'invalidFrameTypeFailures';
  }
  return 'otherDecodeFailures';
}

export function decodeSingleFrameForLiveHarness(
  bytes: Uint8Array,
  options: DecodeOptions | undefined,
  counters: LiveFrameDiagnosticsCounters
): LiveFrameDecodeResult {
  counters.frameAttempts += 1;

  if (bytes.length < 2) {
    const failureReason = 'invalid frame: too short to contain frame type';
    counters.otherDecodeFailures += 1;
    counters.lastFailureReason = failureReason;
    return { ok: false, frame: null, failureReason };
  }

  const frameType = bytes[1];
  if (frameType === undefined || !isValidFrameType(frameType)) {
    const failureReason = `invalid frame type: 0x${(frameType ?? 0).toString(16).padStart(2, '0')}`;
    counters.invalidFrameTypeFailures += 1;
    counters.lastFailureReason = failureReason;
    return { ok: false, frame: null, failureReason };
  }

  try {
    const frame = decodeFrame(bytes, options);
    counters.decodeSuccesses += 1;
    return { ok: true, frame, failureReason: null };
  } catch (error) {
    const failureReason = String(error);
    const counterName = classifyFailureReason(failureReason);
    counters[counterName] += 1;
    counters.lastFailureReason = failureReason;
    return { ok: false, frame: null, failureReason };
  }
}
