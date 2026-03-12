import { describe, expect, it } from 'vitest';

import {
  CANCEL_REASON_CODES,
  FINAL_BAD_REASON_CODES,
  FRAME_TYPES,
  HELLO_REJECT_CODES,
  PROFILE_DEFAULTS,
  PROFILE_IDS,
  PROTOCOL_VERSION,
  RETRY_LIMITS,
  TIMEOUTS_MS
} from '../src/index.js';

describe('MVP contract constants', () => {
  it('keeps protocol version fixed at 0x01', () => {
    expect(PROTOCOL_VERSION).toBe(0x01);
  });

  it('maps frame types to frozen codes', () => {
    expect(FRAME_TYPES).toEqual({
      HELLO: 0x01,
      HELLO_ACK: 0x02,
      DATA: 0x03,
      BURST_ACK: 0x04,
      END: 0x05,
      FINAL_OK: 0x06,
      FINAL_BAD: 0x07,
      CANCEL: 0x08
    });
  });

  it('maps profile IDs and payload defaults', () => {
    expect(PROFILE_IDS).toEqual({ SAFE: 0x01, NORMAL: 0x02, FAST_TEST: 0x03 });
    expect(PROFILE_DEFAULTS[PROFILE_IDS.SAFE]).toEqual({ payloadBytesPerFrame: 512, framesPerBurst: 8 });
    expect(PROFILE_DEFAULTS[PROFILE_IDS.NORMAL]).toEqual({ payloadBytesPerFrame: 768, framesPerBurst: 16 });
    expect(PROFILE_DEFAULTS[PROFILE_IDS.FAST_TEST]).toEqual({ payloadBytesPerFrame: 1024, framesPerBurst: 16 });
  });

  it('maps reason and reject codes', () => {
    expect(HELLO_REJECT_CODES).toEqual({
      UNSUPPORTED_PROFILE: 0x01,
      FILE_TOO_LARGE: 0x02,
      MEMORY_UNAVAILABLE: 0x03,
      INVALID_METADATA: 0x04,
      BUSY: 0x05
    });

    expect(FINAL_BAD_REASON_CODES).toEqual({
      MISSING_DATA_REMAINS: 0x01,
      FILE_LENGTH_MISMATCH: 0x02,
      WHOLE_FILE_CRC_MISMATCH: 0x03,
      INVALID_END_METADATA: 0x04
    });

    expect(CANCEL_REASON_CODES).toEqual({
      USER_CANCEL: 0x01,
      LOCAL_TIMEOUT: 0x02,
      UNRECOVERABLE_PROTOCOL_ERROR: 0x03
    });
  });

  it('keeps timeout and retry defaults', () => {
    expect(TIMEOUTS_MS).toEqual({ HELLO_ACK: 3000, BURST_ACK: 3000, FINAL_RESULT: 3000 });
    expect(RETRY_LIMITS).toEqual({ HELLO: 5, PER_BURST: 8, END_FINAL_CONFIRMATION: 5 });
  });
});
