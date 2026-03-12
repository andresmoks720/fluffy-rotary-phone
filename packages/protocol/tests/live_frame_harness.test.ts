import { FLAGS_MVP_DEFAULT, FRAME_TYPES, PROFILE_IDS, PROTOCOL_VERSION } from '../../contract/src/index.js';
import { describe, expect, it } from 'vitest';

import {
  createLiveFrameDiagnosticsCounters,
  decodeSingleFrameForLiveHarness,
  encodeFrame,
  readFrameDecodeSuccessRate
} from '../src/index.js';

describe('live frame harness diagnostics', () => {
  const base = {
    version: PROTOCOL_VERSION,
    flags: FLAGS_MVP_DEFAULT,
    profileId: PROFILE_IDS.SAFE,
    sessionId: 0x10203040
  };

  it('aggregates attempts and success rate deterministically', () => {
    const counters = createLiveFrameDiagnosticsCounters();
    const frame = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.DATA,
      burstId: 1,
      slotIndex: 0,
      payloadFileOffset: 0,
      payload: Uint8Array.from([0x11, 0x22])
    });

    const first = decodeSingleFrameForLiveHarness(frame, undefined, counters);
    const second = decodeSingleFrameForLiveHarness(frame, undefined, counters);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(counters.frameAttempts).toBe(2);
    expect(counters.decodeSuccesses).toBe(2);
    expect(readFrameDecodeSuccessRate(counters)).toBe(1);
    expect(counters.lastFailureReason).toBeNull();
  });

  it('classifies header crc failure', () => {
    const counters = createLiveFrameDiagnosticsCounters();
    const frame = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.HELLO_ACK,
      acceptCode: 0,
      acceptedPayloadBytesPerFrame: 256,
      acceptedFramesPerBurst: 4
    });
    const broken = new Uint8Array(frame);
    broken[0] ^= 0x01;

    const result = decodeSingleFrameForLiveHarness(broken, undefined, counters);

    expect(result.ok).toBe(false);
    expect(counters.headerCrcFailures).toBe(1);
    expect(counters.payloadCrcFailures).toBe(0);
    expect(counters.invalidFrameTypeFailures).toBe(0);
    expect(counters.lastFailureReason).toMatch(/header crc32c mismatch/i);
    expect(readFrameDecodeSuccessRate(counters)).toBe(0);
  });

  it('classifies payload crc failure', () => {
    const counters = createLiveFrameDiagnosticsCounters();
    const frame = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.DATA,
      burstId: 9,
      slotIndex: 0,
      payloadFileOffset: 0,
      payload: Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
    });
    const broken = new Uint8Array(frame);
    broken[broken.length - 1] ^= 0xff;

    const result = decodeSingleFrameForLiveHarness(broken, undefined, counters);

    expect(result.ok).toBe(false);
    expect(counters.headerCrcFailures).toBe(0);
    expect(counters.payloadCrcFailures).toBe(1);
    expect(counters.invalidFrameTypeFailures).toBe(0);
    expect(counters.lastFailureReason).toMatch(/payload crc32c mismatch/i);
  });

  it('classifies invalid frame type failure explicitly', () => {
    const counters = createLiveFrameDiagnosticsCounters();
    const bytes = new Uint8Array([PROTOCOL_VERSION, 0x99, FLAGS_MVP_DEFAULT, PROFILE_IDS.SAFE, 0, 0, 0, 1]);

    const result = decodeSingleFrameForLiveHarness(bytes, undefined, counters);

    expect(result.ok).toBe(false);
    expect(counters.invalidFrameTypeFailures).toBe(1);
    expect(counters.headerCrcFailures).toBe(0);
    expect(counters.payloadCrcFailures).toBe(0);
    expect(counters.lastFailureReason).toMatch(/invalid frame type/i);
  });
});
