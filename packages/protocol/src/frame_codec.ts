import { crc32c } from '../../crc/src/index.js';
import { FLAGS_MVP_DEFAULT, FRAME_TYPES, PROTOCOL_VERSION, TURN_OWNER_FRAME_TYPES } from '../../contract/src/index.js';

import { validateSlotCount } from './ack_bitmap/ack_bitmap.js';
import type {
  BurstAckFrame,
  CancelFrame,
  DataFrame,
  DecodeOptions,
  EndFrame,
  FinalBadFrame,
  FinalOkFrame,
  Frame,
  HelloAckFrame,
  HelloFrame,
  TurnOwner
} from './types.js';
import { FrameValidationError, assert } from './validation/errors.js';

function withView(size: number): [Uint8Array, DataView] {
  const out = new Uint8Array(size);
  return [out, new DataView(out.buffer)];
}

function writeCommonPrefix(view: DataView, frame: Frame): number {
  view.setUint8(0, frame.version);
  view.setUint8(1, frame.frameType);
  view.setUint8(2, frame.flags);
  view.setUint8(3, frame.profileId);
  view.setUint32(4, frame.sessionId);
  return 8;
}


function assertUint(value: number, max: number, label: string): void {
  assert(Number.isInteger(value), `${label} must be an integer`);
  assert(value >= 0 && value <= max, `${label} out of range`);
}

function assertBigUint64(value: bigint, label: string): void {
  assert(value >= 0n && value <= 0xffffffffffffffffn, `${label} out of range`);
}

function assertCommon(frame: Frame): void {
  assertUint(frame.version, 0xff, 'version');
  assertUint(frame.flags, 0xff, 'flags');
  assertUint(frame.profileId, 0xff, 'profile_id');
  assertUint(frame.sessionId, 0xffffffff, 'session_id');
}

export function encodeFrame(frame: Frame): Uint8Array {
  assertCommon(frame);

  if (frame.frameType === FRAME_TYPES.HELLO) {
    const f = frame as HelloFrame;
    assertBigUint64(f.fileSizeBytes, 'file_size_bytes');
    assertUint(f.totalDataFrames, 0xffffffff, 'total_data_frames');
    assertUint(f.payloadBytesPerFrame, 0xffff, 'payload_bytes_per_frame');
    assertUint(f.framesPerBurst, 0xffff, 'frames_per_burst');
    assertUint(f.fileCrc32c, 0xffffffff, 'file_crc32c');
    const fileNameLen = f.fileNameUtf8.length;
    assertUint(fileNameLen, 0xffff, 'file_name_len');
    const headerLen = 8 + 8 + 4 + 2 + 2 + 4 + 2 + fileNameLen;
    const [bytes, view] = withView(headerLen + 4);
    let o = writeCommonPrefix(view, f);
    view.setBigUint64(o, f.fileSizeBytes);
    o += 8;
    view.setUint32(o, f.totalDataFrames);
    o += 4;
    view.setUint16(o, f.payloadBytesPerFrame);
    o += 2;
    view.setUint16(o, f.framesPerBurst);
    o += 2;
    view.setUint32(o, f.fileCrc32c);
    o += 4;
    view.setUint16(o, fileNameLen);
    o += 2;
    bytes.set(f.fileNameUtf8, o);
    o += fileNameLen;
    view.setUint32(o, crc32c(bytes.subarray(0, o)));
    return bytes;
  }

  if (frame.frameType === FRAME_TYPES.HELLO_ACK) {
    const f = frame as HelloAckFrame;
    assertUint(f.acceptCode, 0xff, 'accept_code');
    assertUint(f.acceptedPayloadBytesPerFrame, 0xffff, 'accepted_payload_bytes_per_frame');
    assertUint(f.acceptedFramesPerBurst, 0xffff, 'accepted_frames_per_burst');
    const [bytes, view] = withView(8 + 1 + 1 + 2 + 2 + 2 + 4);
    let o = writeCommonPrefix(view, f);
    view.setUint8(o, f.acceptCode);
    o += 1;
    view.setUint8(o, 0);
    o += 1;
    view.setUint16(o, f.acceptedPayloadBytesPerFrame);
    o += 2;
    view.setUint16(o, f.acceptedFramesPerBurst);
    o += 2;
    view.setUint16(o, 0);
    o += 2;
    view.setUint32(o, crc32c(bytes.subarray(0, o)));
    return bytes;
  }

  if (frame.frameType === FRAME_TYPES.DATA) {
    const f = frame as DataFrame;
    assertUint(f.burstId, 0xffffffff, 'burst_id');
    assertUint(f.slotIndex, 0xffff, 'slot_index');
    assertUint(f.payloadFileOffset, 0xffffffff, 'payload_file_offset');
    const payloadLen = f.payload.length;
    assertUint(payloadLen, 0xffff, 'payload_len');
    const [bytes, view] = withView(8 + 4 + 2 + 4 + 2 + 4 + payloadLen + 4);
    let o = writeCommonPrefix(view, f);
    view.setUint32(o, f.burstId);
    o += 4;
    view.setUint16(o, f.slotIndex);
    o += 2;
    view.setUint32(o, f.payloadFileOffset);
    o += 4;
    view.setUint16(o, payloadLen);
    o += 2;
    view.setUint32(o, crc32c(bytes.subarray(0, o)));
    o += 4;
    bytes.set(f.payload, o);
    o += payloadLen;
    view.setUint32(o, crc32c(f.payload));
    return bytes;
  }

  if (frame.frameType === FRAME_TYPES.BURST_ACK) {
    const f = frame as BurstAckFrame;
    assertUint(f.burstId, 0xffffffff, 'burst_id');
    validateSlotCount(f.slotCount);
    assertUint(f.ackBitmap, 0xffff, 'ack_bitmap');
    const [bytes, view] = withView(8 + 4 + 2 + 2 + 4);
    let o = writeCommonPrefix(view, f);
    view.setUint32(o, f.burstId);
    o += 4;
    view.setUint16(o, f.slotCount);
    o += 2;
    view.setUint16(o, f.ackBitmap);
    o += 2;
    view.setUint32(o, crc32c(bytes.subarray(0, o)));
    return bytes;
  }

  if (frame.frameType === FRAME_TYPES.END) {
    const f = frame as EndFrame;
    assertBigUint64(f.fileSizeBytes, 'file_size_bytes');
    assertUint(f.totalDataFrames, 0xffffffff, 'total_data_frames');
    assertUint(f.fileCrc32c, 0xffffffff, 'file_crc32c');
    const [bytes, view] = withView(8 + 8 + 4 + 4 + 4);
    let o = writeCommonPrefix(view, f);
    view.setBigUint64(o, f.fileSizeBytes);
    o += 8;
    view.setUint32(o, f.totalDataFrames);
    o += 4;
    view.setUint32(o, f.fileCrc32c);
    o += 4;
    view.setUint32(o, crc32c(bytes.subarray(0, o)));
    return bytes;
  }

  if (frame.frameType === FRAME_TYPES.FINAL_OK) {
    const f = frame as FinalOkFrame;
    assertUint(f.observedFileCrc32c, 0xffffffff, 'observed_file_crc32c');
    const [bytes, view] = withView(8 + 4 + 4);
    let o = writeCommonPrefix(view, f);
    view.setUint32(o, f.observedFileCrc32c);
    o += 4;
    view.setUint32(o, crc32c(bytes.subarray(0, o)));
    return bytes;
  }

  if (frame.frameType === FRAME_TYPES.FINAL_BAD) {
    const f = frame as FinalBadFrame;
    assertUint(f.reasonCode, 0xff, 'reason_code');
    assertUint(f.observedFileCrc32c, 0xffffffff, 'observed_file_crc32c');
    const [bytes, view] = withView(8 + 1 + 3 + 4 + 4);
    let o = writeCommonPrefix(view, f);
    view.setUint8(o, f.reasonCode);
    o += 1;
    view.setUint8(o, 0);
    o += 1;
    view.setUint8(o, 0);
    o += 1;
    view.setUint8(o, 0);
    o += 1;
    view.setUint32(o, f.observedFileCrc32c);
    o += 4;
    view.setUint32(o, crc32c(bytes.subarray(0, o)));
    return bytes;
  }

  if (frame.frameType === FRAME_TYPES.CANCEL) {
    const f = frame as CancelFrame;
    assertUint(f.reasonCode, 0xff, 'reason_code');
    const [bytes, view] = withView(8 + 1 + 3 + 4);
    let o = writeCommonPrefix(view, f);
    view.setUint8(o, f.reasonCode);
    o += 1;
    view.setUint8(o, 0);
    o += 1;
    view.setUint8(o, 0);
    o += 1;
    view.setUint8(o, 0);
    o += 1;
    view.setUint32(o, crc32c(bytes.subarray(0, o)));
    return bytes;
  }

  throw new FrameValidationError('unsupported frame type for encode');
}

function verifyHeaderCrc(bytes: Uint8Array, headerCrcOffset: number): void {
  const got = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(headerCrcOffset);
  const want = crc32c(bytes.subarray(0, headerCrcOffset));
  assert(got === want, 'header CRC32C mismatch');
}

function parseCommon(bytes: Uint8Array): { version: number; frameType: number; flags: number; profileId: number; sessionId: number } {
  assert(bytes.length >= 8, 'frame too short for common prefix');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint8(0),
    frameType: view.getUint8(1),
    flags: view.getUint8(2),
    profileId: view.getUint8(3),
    sessionId: view.getUint32(4)
  };
}


function validateTurnOwnership(frameType: number, expectedTurnOwner: TurnOwner): void {
  const senderOwned = TURN_OWNER_FRAME_TYPES.sender.includes(frameType as never);
  const receiverOwned = TURN_OWNER_FRAME_TYPES.receiver.includes(frameType as never);

  if (expectedTurnOwner === 'sender') {
    assert(senderOwned, 'invalid turn ownership for sender turn');
    return;
  }

  assert(receiverOwned, 'invalid turn ownership for receiver turn');
}

function validateExpectations(frame: { version: number; sessionId: number; profileId: number; flags: number; frameType: number }, options?: DecodeOptions): void {
  const expectedVersion = options?.expectedVersion ?? PROTOCOL_VERSION;
  assert(frame.version === expectedVersion, 'invalid version');
  if (options?.expectedSessionId !== undefined) {
    assert(frame.sessionId === options.expectedSessionId, 'invalid session ID');
  }
  if (options?.expectedProfileId !== undefined) {
    assert(frame.profileId === options.expectedProfileId, 'invalid profile ID');
  }
  assert(frame.flags === FLAGS_MVP_DEFAULT, 'invalid flags for MVP');
  if (options?.expectedTurnOwner !== undefined) {
    validateTurnOwnership(frame.frameType, options.expectedTurnOwner);
  }
}

export function decodeFrame(bytes: Uint8Array, options?: DecodeOptions): Frame {
  const common = parseCommon(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (common.frameType) {
    case FRAME_TYPES.HELLO: {
      assert(bytes.length >= 8 + 8 + 4 + 2 + 2 + 4 + 2 + 4, 'HELLO frame too short');
      const fileNameLen = view.getUint16(28);
      const expectedLen = 8 + 8 + 4 + 2 + 2 + 4 + 2 + fileNameLen + 4;
      assert(bytes.length === expectedLen, 'HELLO frame length mismatch');
      verifyHeaderCrc(bytes, expectedLen - 4);
      validateExpectations(common, options);
      return {
        ...common,
        frameType: FRAME_TYPES.HELLO,
        fileSizeBytes: view.getBigUint64(8),
        totalDataFrames: view.getUint32(16),
        payloadBytesPerFrame: view.getUint16(20),
        framesPerBurst: view.getUint16(22),
        fileCrc32c: view.getUint32(24),
        fileNameUtf8: bytes.slice(30, 30 + fileNameLen)
      };
    }
    case FRAME_TYPES.HELLO_ACK: {
      const len = 8 + 1 + 1 + 2 + 2 + 2 + 4;
      assert(bytes.length === len, 'HELLO_ACK frame length mismatch');
      verifyHeaderCrc(bytes, len - 4);
      validateExpectations(common, options);
      assert(view.getUint8(9) === 0, 'HELLO_ACK reserved0 must be zero');
      assert(view.getUint16(14) === 0, 'HELLO_ACK reserved1 must be zero');
      return {
        ...common,
        frameType: FRAME_TYPES.HELLO_ACK,
        acceptCode: view.getUint8(8),
        acceptedPayloadBytesPerFrame: view.getUint16(10),
        acceptedFramesPerBurst: view.getUint16(12)
      };
    }
    case FRAME_TYPES.DATA: {
      assert(bytes.length >= 8 + 4 + 2 + 4 + 2 + 4 + 4, 'DATA frame too short');
      const payloadLen = view.getUint16(18);
      const expectedLen = 8 + 4 + 2 + 4 + 2 + 4 + payloadLen + 4;
      assert(bytes.length === expectedLen, 'DATA frame length mismatch');
      verifyHeaderCrc(bytes, 20);
      const payload = bytes.slice(24, 24 + payloadLen);
      const payloadCrc = view.getUint32(24 + payloadLen);
      assert(crc32c(payload) === payloadCrc, 'payload CRC32C mismatch');
      validateExpectations(common, options);
      return {
        ...common,
        frameType: FRAME_TYPES.DATA,
        burstId: view.getUint32(8),
        slotIndex: view.getUint16(12),
        payloadFileOffset: view.getUint32(14),
        payload
      };
    }
    case FRAME_TYPES.BURST_ACK: {
      const len = 8 + 4 + 2 + 2 + 4;
      assert(bytes.length === len, 'BURST_ACK frame length mismatch');
      verifyHeaderCrc(bytes, len - 4);
      validateExpectations(common, options);
      const slotCount = view.getUint16(12);
      validateSlotCount(slotCount);
      return {
        ...common,
        frameType: FRAME_TYPES.BURST_ACK,
        burstId: view.getUint32(8),
        slotCount,
        ackBitmap: view.getUint16(14)
      };
    }
    case FRAME_TYPES.END: {
      const len = 8 + 8 + 4 + 4 + 4;
      assert(bytes.length === len, 'END frame length mismatch');
      verifyHeaderCrc(bytes, len - 4);
      validateExpectations(common, options);
      return {
        ...common,
        frameType: FRAME_TYPES.END,
        fileSizeBytes: view.getBigUint64(8),
        totalDataFrames: view.getUint32(16),
        fileCrc32c: view.getUint32(20)
      };
    }
    case FRAME_TYPES.FINAL_OK: {
      const len = 8 + 4 + 4;
      assert(bytes.length === len, 'FINAL_OK frame length mismatch');
      verifyHeaderCrc(bytes, len - 4);
      validateExpectations(common, options);
      return {
        ...common,
        frameType: FRAME_TYPES.FINAL_OK,
        observedFileCrc32c: view.getUint32(8)
      };
    }
    case FRAME_TYPES.FINAL_BAD: {
      const len = 8 + 1 + 3 + 4 + 4;
      assert(bytes.length === len, 'FINAL_BAD frame length mismatch');
      verifyHeaderCrc(bytes, len - 4);
      validateExpectations(common, options);
      assert(view.getUint8(9) === 0 && view.getUint8(10) === 0 && view.getUint8(11) === 0, 'FINAL_BAD reserved bytes must be zero');
      return {
        ...common,
        frameType: FRAME_TYPES.FINAL_BAD,
        reasonCode: view.getUint8(8),
        observedFileCrc32c: view.getUint32(12)
      };
    }
    case FRAME_TYPES.CANCEL: {
      const len = 8 + 1 + 3 + 4;
      assert(bytes.length === len, 'CANCEL frame length mismatch');
      verifyHeaderCrc(bytes, len - 4);
      validateExpectations(common, options);
      assert(view.getUint8(9) === 0 && view.getUint8(10) === 0 && view.getUint8(11) === 0, 'CANCEL reserved bytes must be zero');
      return {
        ...common,
        frameType: FRAME_TYPES.CANCEL,
        reasonCode: view.getUint8(8)
      };
    }
    default:
      throw new FrameValidationError('unknown frame type');
  }
}
