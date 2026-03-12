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


  it('increments timeout retry counters exactly once per timeout event', () => {
    const sender = new SenderController();
    sender.dispatch({ type: 'START', sessionId: 0x77777777 });
    sender.dispatch({ type: 'HELLO_SENT' });

    const t1 = sender.dispatch({ type: 'TIMEOUT', phase: 'HELLO_ACK' });
    expect(t1.retries.hello).toBe(1);
    sender.dispatch({ type: 'HELLO_SENT' });

    const t2 = sender.dispatch({ type: 'TIMEOUT', phase: 'HELLO_ACK' });
    expect(t2.retries.hello).toBe(2);
    expect(t2.state).toBe('HELLO_TX');
  });

  it('rejects duplicate final frames once sender is terminal failed', () => {
    const sid = 0x88888888;
    const sender = new SenderController();

    sender.dispatch({ type: 'START', sessionId: sid });
    sender.dispatch({ type: 'HELLO_SENT' });
    sender.dispatch({ type: 'HELLO_ACK', sessionId: sid, accepted: true });
    sender.dispatch({ type: 'BURST_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId: sid, allAcked: true });
    sender.dispatch({ type: 'END_SENT' });
    sender.dispatch({ type: 'FINAL', sessionId: sid, ok: false });

    expect(() => sender.dispatch({ type: 'FINAL', sessionId: sid, ok: false })).toThrow(/invalid turn owner/);
    expect(sender.snapshot().state).toBe('FAILED');
  });

  it('is idempotent for duplicate END on receiver after success', () => {
    const sid = 0x99999999;
    const receiver = new ReceiverController();

    receiver.dispatch({ type: 'HELLO', sessionId: sid, valid: true });
    receiver.dispatch({ type: 'DATA_START', sessionId: sid });
    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId: sid });
    receiver.dispatch({ type: 'DATA_COMPLETE', sessionId: sid });
    receiver.dispatch({ type: 'END', sessionId: sid, valid: true });
    receiver.dispatch({ type: 'FINAL_SENT' });

    const duplicateEnd = receiver.dispatch({ type: 'END', sessionId: sid, valid: true });
    expect(duplicateEnd.state).toBe('SUCCESS');
    expect(receiver.snapshot().sessionId).toBe(sid);
  });

});
