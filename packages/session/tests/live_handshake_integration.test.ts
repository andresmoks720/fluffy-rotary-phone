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
});
