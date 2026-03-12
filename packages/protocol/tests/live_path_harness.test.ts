import { describe, expect, it } from 'vitest';

import {
  INITIAL_LIVE_PATH_FRAME_METRICS,
  classifyDecodeFailure,
  isValidFrameType,
  recordFrameDecodeAttempt
} from '../src/index.js';

describe('live path harness metrics', () => {
  it('accepts only contract-defined frame types', () => {
    expect(isValidFrameType(0x01)).toBe(true);
    expect(isValidFrameType(0x08)).toBe(true);
    expect(isValidFrameType(0x00)).toBe(false);
    expect(isValidFrameType(0x09)).toBe(false);
  });

  it('classifies explicit CRC and frame-type failures', () => {
    expect(classifyDecodeFailure(new Error('header CRC32C mismatch'))).toBe('header_crc_failure');
    expect(classifyDecodeFailure(new Error('payload CRC32C mismatch'))).toBe('payload_crc_failure');
    expect(classifyDecodeFailure(new Error('unknown frame type'))).toBe('invalid_frame_type');
    expect(classifyDecodeFailure(new Error('DATA frame too short'))).toBe('decode_failure');
    expect(classifyDecodeFailure('bad')).toBe('decode_failure');
  });

  it('aggregates counters and success rate deterministically', () => {
    let metrics = INITIAL_LIVE_PATH_FRAME_METRICS;

    metrics = recordFrameDecodeAttempt(metrics, { ok: true });
    metrics = recordFrameDecodeAttempt(metrics, {
      ok: false,
      reason: 'header_crc_failure',
      details: 'header CRC32C mismatch on DATA frame'
    });
    metrics = recordFrameDecodeAttempt(metrics, {
      ok: false,
      reason: 'payload_crc_failure',
      details: 'payload CRC32C mismatch on DATA frame'
    });
    metrics = recordFrameDecodeAttempt(metrics, {
      ok: false,
      reason: 'invalid_frame_type',
      details: 'unknown frame type: 0x99'
    });
    metrics = recordFrameDecodeAttempt(metrics, {
      ok: false,
      reason: 'decode_failure',
      details: 'DATA frame too short'
    });

    expect(metrics.counters.frameAttempts).toBe(5);
    expect(metrics.counters.decodeSuccesses).toBe(1);
    expect(metrics.counters.headerCrcFailures).toBe(1);
    expect(metrics.counters.payloadCrcFailures).toBe(1);
    expect(metrics.counters.invalidFrameTypeFailures).toBe(1);
    expect(metrics.counters.decodeFailures).toBe(1);
    expect(metrics.decodeSuccessRate).toBe(0.2);
    expect(metrics.lastFailureReason).toBe('DATA frame too short');
  });
});
