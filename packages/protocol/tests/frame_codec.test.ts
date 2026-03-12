import { FRAME_TYPES, PROFILE_IDS, PROTOCOL_VERSION } from '../../contract/src/index.js';
import { crc32c } from '../../crc/src/index.js';
import { describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame, type Frame } from '../src/index.js';

function clone(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function roundTrip(frame: Frame): Frame {
  return decodeFrame(encodeFrame(frame), {
    expectedVersion: PROTOCOL_VERSION,
    expectedProfileId: frame.profileId,
    expectedSessionId: frame.sessionId
  });
}

describe('frame codec', () => {
  const base = {
    version: PROTOCOL_VERSION,
    flags: 0x00,
    profileId: PROFILE_IDS.SAFE,
    sessionId: 0xa1b2c3d4
  };

  it('round-trips all frame layouts deterministically', () => {
    const frames: Frame[] = [
      {
        ...base,
        frameType: FRAME_TYPES.HELLO,
        fileSizeBytes: 1234n,
        totalDataFrames: 3,
        payloadBytesPerFrame: 512,
        framesPerBurst: 8,
        fileCrc32c: 0x12345678,
        fileNameUtf8: new TextEncoder().encode('file.bin')
      },
      {
        ...base,
        frameType: FRAME_TYPES.HELLO_ACK,
        acceptCode: 0,
        acceptedPayloadBytesPerFrame: 512,
        acceptedFramesPerBurst: 8
      },
      {
        ...base,
        frameType: FRAME_TYPES.DATA,
        burstId: 1,
        slotIndex: 2,
        payloadFileOffset: 1024,
        payload: Uint8Array.from([1, 2, 3, 4])
      },
      {
        ...base,
        frameType: FRAME_TYPES.BURST_ACK,
        burstId: 1,
        slotCount: 8,
        ackBitmap: 0x00b7
      },
      {
        ...base,
        frameType: FRAME_TYPES.END,
        fileSizeBytes: 1234n,
        totalDataFrames: 3,
        fileCrc32c: 0x12345678
      },
      {
        ...base,
        frameType: FRAME_TYPES.FINAL_OK,
        observedFileCrc32c: 0x12345678
      },
      {
        ...base,
        frameType: FRAME_TYPES.FINAL_BAD,
        reasonCode: 0x03,
        observedFileCrc32c: 0xdeadc0de
      },
      {
        ...base,
        frameType: FRAME_TYPES.CANCEL,
        reasonCode: 0x02
      }
    ];

    for (const frame of frames) {
      expect(roundTrip(frame)).toEqual(frame);
    }
  });

  it('rejects malformed DATA payload CRC', () => {
    const encoded = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.DATA,
      burstId: 1,
      slotIndex: 0,
      payloadFileOffset: 0,
      payload: Uint8Array.from([9, 8, 7])
    });

    const broken = clone(encoded);
    broken[broken.length - 1] ^= 0xff;
    expect(() => decodeFrame(broken)).toThrow(/payload CRC32C mismatch/);
  });

  it('rejects malformed header CRC', () => {
    const encoded = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.HELLO_ACK,
      acceptCode: 0,
      acceptedPayloadBytesPerFrame: 512,
      acceptedFramesPerBurst: 8
    });

    const broken = clone(encoded);
    broken[0] ^= 0x01;
    expect(() => decodeFrame(broken)).toThrow(/header CRC32C mismatch/);
  });

  it('rejects invalid version/session/profile expectations', () => {
    const encoded = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.FINAL_OK,
      observedFileCrc32c: 0x12345678
    });

    expect(() => decodeFrame(encoded, { expectedVersion: 0x02 })).toThrow(/invalid version/);
    expect(() => decodeFrame(encoded, { expectedSessionId: 0x00000001 })).toThrow(/invalid session ID/);
    expect(() => decodeFrame(encoded, { expectedProfileId: PROFILE_IDS.NORMAL })).toThrow(/invalid profile ID/);
  });



  it('rejects invalid turn ownership expectations', () => {
    const helloAck = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.HELLO_ACK,
      acceptCode: 0,
      acceptedPayloadBytesPerFrame: 512,
      acceptedFramesPerBurst: 8
    });

    const data = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.DATA,
      burstId: 1,
      slotIndex: 0,
      payloadFileOffset: 0,
      payload: Uint8Array.from([1])
    });

    expect(() => decodeFrame(helloAck, { expectedTurnOwner: 'sender' })).toThrow(/turn ownership/);
    expect(() => decodeFrame(data, { expectedTurnOwner: 'receiver' })).toThrow(/turn ownership/);
  });

  it('rejects malformed encode inputs', () => {
    expect(() =>
      encodeFrame({
        ...base,
        frameType: FRAME_TYPES.HELLO,
        fileSizeBytes: -1n,
        totalDataFrames: 1,
        payloadBytesPerFrame: 512,
        framesPerBurst: 8,
        fileCrc32c: 0,
        fileNameUtf8: new Uint8Array()
      })
    ).toThrow(/file_size_bytes/);

    expect(() =>
      encodeFrame({
        ...base,
        frameType: FRAME_TYPES.DATA,
        burstId: 1,
        slotIndex: 0,
        payloadFileOffset: 0,
        payload: new Uint8Array(70000)
      })
    ).toThrow(/payload_len/);
  });

  it('rejects malformed reserved bytes on decode', () => {
    const encoded = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.CANCEL,
      reasonCode: 0x02
    });

    const broken = clone(encoded);
    broken[9] = 0x01;
    const view = new DataView(broken.buffer, broken.byteOffset, broken.byteLength);
    view.setUint32(12, crc32c(broken.subarray(0, 12)));

    expect(() => decodeFrame(broken)).toThrow(/reserved bytes/);
  });

  it('rejects invalid BURST_ACK slot_count', () => {
    const encoded = encodeFrame({
      ...base,
      frameType: FRAME_TYPES.BURST_ACK,
      burstId: 1,
      slotCount: 8,
      ackBitmap: 0x00ff
    });

    const broken = clone(encoded);
    const view = new DataView(broken.buffer, broken.byteOffset, broken.byteLength);
    view.setUint16(12, 0); // break slot_count
    view.setUint32(16, crc32c(broken.subarray(0, 16))); // keep CRC valid so slot_count validation runs

    expect(() => decodeFrame(broken)).toThrow(/slot_count/);
  });
});
