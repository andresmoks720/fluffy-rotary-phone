import { describe, expect, it } from 'vitest';

import { PROFILE_IDS, RETRY_LIMITS } from '../../contract/src/index.js';
import { LiveReceiverHandshake, LiveSenderHandshake, SenderController } from '../src/index.js';

describe('long-session reliability', () => {
  it('supports repeated handshake cycles without state leakage', () => {
    const cycles = 200;

    for (let i = 0; i < cycles; i += 1) {
      const sessionId = 0x50000000 + i;
      const sender = new LiveSenderHandshake();
      const receiver = new LiveReceiverHandshake({ supportedProfiles: [PROFILE_IDS.SAFE] });

      const hello = sender.emitHello({
        sessionId,
        fileNameUtf8: new TextEncoder().encode(`cycle-${i}.bin`),
        fileSizeBytes: 1024n,
        fileCrc32c: 0xabcdef12,
        profileId: PROFILE_IDS.SAFE
      });

      const { helloAckBytes } = receiver.handleHello(hello);
      const senderDiag = sender.acceptHelloAck(helloAckBytes);
      const receiverDiag = receiver.diagnostics();

      expect(senderDiag.result).toBe('accepted');
      expect(senderDiag.sessionId).toBe(sessionId);
      expect(receiverDiag.result).toBe('accepted');
      expect(receiverDiag.sessionId).toBe(sessionId);
    }
  });

  it('tracks timeout/retry counters and exhausts deterministically across repeated sessions', () => {
    const sessions = 50;

    for (let i = 0; i < sessions; i += 1) {
      const sid = 0x60000000 + i;
      const controller = new SenderController();
      controller.dispatch({ type: 'START', sessionId: sid });
      controller.dispatch({ type: 'HELLO_SENT' });

      for (let retry = 1; retry <= RETRY_LIMITS.HELLO; retry += 1) {
        const timeout = controller.dispatch({ type: 'TIMEOUT', phase: 'HELLO_ACK' });
        expect(timeout.retries.hello).toBe(retry);
        expect(timeout.state).toBe('HELLO_TX');
        controller.dispatch({ type: 'HELLO_SENT' });
      }

      const exhausted = controller.dispatch({ type: 'TIMEOUT', phase: 'HELLO_ACK' });
      expect(exhausted.retries.hello).toBe(RETRY_LIMITS.HELLO + 1);
      expect(exhausted.state).toBe('FAILED');
    }
  });
});
