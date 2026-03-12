import { describe, expect, it } from 'vitest';

import { FRAME_TYPES, HELLO_REJECT_CODES, PROFILE_IDS } from '../../contract/src/index.js';
import { decodeFrame } from '../../protocol/src/index.js';
import {
  LiveReceiverHandshake,
  LiveSenderHandshake,
  MVP_MAX_FILE_SIZE_BYTES
} from '../src/index.js';

function asUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('live handshake integration', () => {
  it('accepts HELLO over live-like frame wiring and locks receiver session ID', () => {
    const sender = new LiveSenderHandshake();
    const receiver = new LiveReceiverHandshake({
      supportedProfiles: [PROFILE_IDS.SAFE],
      memoryBudgetBytes: MVP_MAX_FILE_SIZE_BYTES
    });

    const helloBytes = sender.emitHello({
      sessionId: 0x10000001,
      fileNameUtf8: asUtf8('a.bin'),
      fileSizeBytes: 1024n,
      fileCrc32c: 0x12345678,
      profileId: PROFILE_IDS.SAFE
    });

    const first = receiver.handleHello(helloBytes);
    const senderDiag = sender.acceptHelloAck(first.helloAckBytes);

    const ack1 = decodeFrame(first.helloAckBytes);
    if (ack1.frameType !== FRAME_TYPES.HELLO_ACK) {
      throw new Error('expected HELLO_ACK frame');
    }

    expect(ack1.acceptCode).toBe(0x00);
    expect(senderDiag.result).toBe('accepted');
    expect(senderDiag.sessionId).toBe(0x10000001);
    expect(receiver.diagnostics().sessionId).toBe(0x10000001);

    const secondSender = new LiveSenderHandshake();
    const secondHello = secondSender.emitHello({
      sessionId: 0x10000002,
      fileNameUtf8: asUtf8('b.bin'),
      fileSizeBytes: 1024n,
      fileCrc32c: 0x12345678,
      profileId: PROFILE_IDS.SAFE
    });
    const second = receiver.handleHello(secondHello);
    const ack2 = decodeFrame(second.helloAckBytes);
    if (ack2.frameType !== FRAME_TYPES.HELLO_ACK) {
      throw new Error('expected HELLO_ACK frame');
    }

    expect(ack2.acceptCode).toBe(HELLO_REJECT_CODES.BUSY);
    expect(receiver.diagnostics().sessionId).toBe(0x10000001);
    expect(receiver.diagnostics().reason).toContain('busy');
  });

  it('rejects HELLO deterministically for unsupported profile with explicit reason', () => {
    const sender = new LiveSenderHandshake();
    const receiver = new LiveReceiverHandshake({ supportedProfiles: [PROFILE_IDS.SAFE] });

    const helloBytes = sender.emitHello({
      sessionId: 0x20000001,
      fileNameUtf8: asUtf8('profile-reject.bin'),
      fileSizeBytes: 4096n,
      fileCrc32c: 0x87654321,
      profileId: PROFILE_IDS.NORMAL
    });

    const { helloAckBytes, diagnostics: receiverDiag } = receiver.handleHello(helloBytes);
    const senderDiag = sender.acceptHelloAck(helloAckBytes);

    const ack = decodeFrame(helloAckBytes);
    if (ack.frameType !== FRAME_TYPES.HELLO_ACK) {
      throw new Error('expected HELLO_ACK frame');
    }

    expect(ack.acceptCode).toBe(HELLO_REJECT_CODES.UNSUPPORTED_PROFILE);
    expect(receiverDiag.result).toBe('rejected');
    expect(receiverDiag.reason).toContain('unsupported profile');
    expect(senderDiag.result).toBe('rejected');
    expect(senderDiag.reason).toContain('unsupported profile');
  });


  it('rejects HELLO deterministically for oversize file and accepts exact 10 MiB boundary', () => {
    const sender = new LiveSenderHandshake();
    const receiver = new LiveReceiverHandshake({ supportedProfiles: [PROFILE_IDS.SAFE] });

    const boundaryHello = sender.emitHello({
      sessionId: 0x20000011,
      fileNameUtf8: asUtf8('boundary.bin'),
      fileSizeBytes: BigInt(MVP_MAX_FILE_SIZE_BYTES),
      fileCrc32c: 0x11111111,
      profileId: PROFILE_IDS.SAFE
    });

    const boundaryResult = receiver.handleHello(boundaryHello);
    const boundaryAck = decodeFrame(boundaryResult.helloAckBytes);
    if (boundaryAck.frameType !== FRAME_TYPES.HELLO_ACK) {
      throw new Error('expected HELLO_ACK frame');
    }
    expect(boundaryAck.acceptCode).toBe(0x00);

    const sender2 = new LiveSenderHandshake();
    const oversizeHello = sender2.emitHello({
      sessionId: 0x20000012,
      fileNameUtf8: asUtf8('too-big.bin'),
      fileSizeBytes: BigInt(MVP_MAX_FILE_SIZE_BYTES + 1),
      fileCrc32c: 0x22222222,
      profileId: PROFILE_IDS.SAFE
    });

    const receiverFresh = new LiveReceiverHandshake({ supportedProfiles: [PROFILE_IDS.SAFE] });
    const oversizeResult = receiverFresh.handleHello(oversizeHello);
    const oversizeAck = decodeFrame(oversizeResult.helloAckBytes);
    if (oversizeAck.frameType !== FRAME_TYPES.HELLO_ACK) {
      throw new Error('expected HELLO_ACK frame');
    }

    expect(oversizeAck.acceptCode).toBe(HELLO_REJECT_CODES.FILE_TOO_LARGE);
    expect(oversizeResult.diagnostics.reason).toContain('exceeds MVP max size');
  });


  it('rejects zero-byte files before HELLO encode to avoid invalid metadata', () => {
    const sender = new LiveSenderHandshake();

    expect(() => sender.emitHello({
      sessionId: 0x30000001,
      fileNameUtf8: asUtf8('empty.bin'),
      fileSizeBytes: 0n,
      fileCrc32c: 0x00000000,
      profileId: PROFILE_IDS.SAFE
    })).toThrow(/at least 1/);
  });

  it('rejects HELLO deterministically when memory preflight budget is insufficient', () => {
    const sender = new LiveSenderHandshake();
    const receiver = new LiveReceiverHandshake({
      supportedProfiles: [PROFILE_IDS.SAFE],
      memoryBudgetBytes: 1024
    });

    const helloBytes = sender.emitHello({
      sessionId: 0x20000021,
      fileNameUtf8: asUtf8('mem.bin'),
      fileSizeBytes: 4096n,
      fileCrc32c: 0x33333333,
      profileId: PROFILE_IDS.SAFE
    });

    const { helloAckBytes, diagnostics } = receiver.handleHello(helloBytes);
    const ack = decodeFrame(helloAckBytes);
    if (ack.frameType !== FRAME_TYPES.HELLO_ACK) {
      throw new Error('expected HELLO_ACK frame');
    }

    expect(ack.acceptCode).toBe(HELLO_REJECT_CODES.MEMORY_UNAVAILABLE);
    expect(diagnostics.reason).toContain('memory unavailable');
  });

});
