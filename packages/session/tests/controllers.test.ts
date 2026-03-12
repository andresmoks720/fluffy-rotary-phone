import { describe, expect, it } from 'vitest';

import { ReceiverController, SenderController } from '../src/index.js';

describe('session controllers', () => {
  it('enforces session lock and turn ownership', () => {
    const sender = new SenderController();
    sender.dispatch({ type: 'START', sessionId: 0x11111111 });
    sender.dispatch({ type: 'HELLO_SENT' });

    expect(() => sender.dispatch({ type: 'HELLO_ACK', sessionId: 0x22222222, accepted: true })).toThrow(/invalid session ID/);

    const receiver = new ReceiverController();
    receiver.dispatch({ type: 'HELLO', sessionId: 0x11111111, valid: true });
    receiver.dispatch({ type: 'DATA_START', sessionId: 0x11111111 });
    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId: 0x11111111 });

    expect(() => receiver.dispatch({ type: 'DATA_START', sessionId: 0x11111111 })).toThrow(/invalid turn owner/);
    receiver.dispatch({ type: 'BURST_ACK_SENT' });
    expect(receiver.snapshot().expectedTurn).toBe('sender');
  });

  it('applies sender timeout retry budget and fails when exhausted', () => {
    const sender = new SenderController();
    sender.dispatch({ type: 'START', sessionId: 0x11111111 });
    sender.dispatch({ type: 'HELLO_SENT' });

    for (let i = 0; i < 5; i += 1) {
      sender.dispatch({ type: 'TIMEOUT', phase: 'HELLO_ACK' });
      sender.dispatch({ type: 'HELLO_SENT' });
    }

    const endState = sender.dispatch({ type: 'TIMEOUT', phase: 'HELLO_ACK' });
    expect(endState.state).toBe('FAILED');
  });

  it('fails on final timeout retry exhaustion explicitly', () => {
    const sender = new SenderController();
    sender.dispatch({ type: 'START', sessionId: 0x33333333 });
    sender.dispatch({ type: 'HELLO_SENT' });
    sender.dispatch({ type: 'HELLO_ACK', sessionId: 0x33333333, accepted: true });
    sender.dispatch({ type: 'BURST_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId: 0x33333333, allAcked: true });
    sender.dispatch({ type: 'END_SENT' });

    for (let i = 0; i < 5; i += 1) {
      sender.dispatch({ type: 'TIMEOUT', phase: 'FINAL' });
      sender.dispatch({ type: 'END_SENT' });
    }

    expect(sender.dispatch({ type: 'TIMEOUT', phase: 'FINAL' }).state).toBe('FAILED');
  });

  it('ignores duplicate FINAL_OK after sender success', () => {
    const sender = new SenderController();
    const sid = 0x44444444;
    sender.dispatch({ type: 'START', sessionId: sid });
    sender.dispatch({ type: 'HELLO_SENT' });
    sender.dispatch({ type: 'HELLO_ACK', sessionId: sid, accepted: true });
    sender.dispatch({ type: 'BURST_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId: sid, allAcked: true });
    sender.dispatch({ type: 'END_SENT' });
    sender.dispatch({ type: 'FINAL', sessionId: sid, ok: true });

    expect(sender.dispatch({ type: 'FINAL', sessionId: sid, ok: true }).state).toBe('SUCCESS');
  });
});
