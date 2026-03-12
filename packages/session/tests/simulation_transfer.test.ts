import { describe, expect, it } from 'vitest';

import { ReceiverController, SenderController } from '../src/index.js';

describe('simulated transfer flow', () => {
  it('simulates HELLO to FINAL_OK', () => {
    const sessionId = 0xabcdef01;
    const sender = new SenderController();
    const receiver = new ReceiverController();

    sender.dispatch({ type: 'START', sessionId });
    sender.dispatch({ type: 'HELLO_SENT' });

    receiver.dispatch({ type: 'HELLO', sessionId, valid: true });
    sender.dispatch({ type: 'HELLO_ACK', sessionId, accepted: true });

    sender.dispatch({ type: 'BURST_SENT' });
    receiver.dispatch({ type: 'DATA_START', sessionId });
    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId });
    receiver.dispatch({ type: 'BURST_ACK_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId, allAcked: false });

    sender.dispatch({ type: 'RETX_SENT' });
    receiver.dispatch({ type: 'DATA_START', sessionId });
    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId });
    receiver.dispatch({ type: 'BURST_ACK_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId, allAcked: true });

    receiver.dispatch({ type: 'DATA_COMPLETE', sessionId });
    sender.dispatch({ type: 'END_SENT' });
    receiver.dispatch({ type: 'END', sessionId, valid: true });
    receiver.dispatch({ type: 'FINAL_SENT' });
    const senderFinal = sender.dispatch({ type: 'FINAL', sessionId, ok: true });
    const duplicateFinal = sender.dispatch({ type: 'FINAL', sessionId, ok: true });

    expect(senderFinal.state).toBe('SUCCESS');
    expect(duplicateFinal.state).toBe('SUCCESS');
    expect(receiver.snapshot().state).toBe('SUCCESS');
  });

  it('simulates FINAL_BAD and cancel paths', () => {
    const sessionId = 0xabcdef02;
    const sender = new SenderController();
    const receiver = new ReceiverController();

    sender.dispatch({ type: 'START', sessionId });
    sender.dispatch({ type: 'HELLO_SENT' });
    receiver.dispatch({ type: 'HELLO', sessionId, valid: true });
    sender.dispatch({ type: 'HELLO_ACK', sessionId, accepted: true });
    sender.dispatch({ type: 'BURST_SENT' });
    receiver.dispatch({ type: 'DATA_START', sessionId });
    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId });
    receiver.dispatch({ type: 'BURST_ACK_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId, allAcked: true });
    receiver.dispatch({ type: 'DATA_COMPLETE', sessionId });
    sender.dispatch({ type: 'END_SENT' });
    receiver.dispatch({ type: 'END', sessionId, valid: false });
    receiver.dispatch({ type: 'FINAL_SENT' });

    expect(sender.dispatch({ type: 'FINAL', sessionId, ok: false }).state).toBe('FAILED');

    const sender2 = new SenderController();
    sender2.dispatch({ type: 'START', sessionId: 0xabcdef03 });
    expect(sender2.dispatch({ type: 'CANCEL' }).state).toBe('CANCELLED');
  });

  it('retries END after final timeout and accepts duplicate END replay semantics', () => {
    const sessionId = 0xabcdef10;
    const sender = new SenderController();
    const receiver = new ReceiverController();

    sender.dispatch({ type: 'START', sessionId });
    sender.dispatch({ type: 'HELLO_SENT' });
    receiver.dispatch({ type: 'HELLO', sessionId, valid: true });
    sender.dispatch({ type: 'HELLO_ACK', sessionId, accepted: true });

    sender.dispatch({ type: 'BURST_SENT' });
    receiver.dispatch({ type: 'DATA_START', sessionId });
    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId });
    receiver.dispatch({ type: 'BURST_ACK_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId, allAcked: true });
    receiver.dispatch({ type: 'DATA_COMPLETE', sessionId });

    sender.dispatch({ type: 'END_SENT' });
    sender.dispatch({ type: 'TIMEOUT', phase: 'FINAL' });
    sender.dispatch({ type: 'END_SENT' });

    receiver.dispatch({ type: 'END', sessionId, valid: true });
    receiver.dispatch({ type: 'FINAL_SENT' });

    expect(receiver.dispatch({ type: 'END', sessionId, valid: true }).state).toBe('SUCCESS');
    const final = sender.dispatch({ type: 'FINAL', sessionId, ok: true });
    expect(final.state).toBe('SUCCESS');
  });

  it('supports cancel from receiver side as explicit cancellation', () => {
    const sessionId = 0xabcdef11;
    const sender = new SenderController();
    const receiver = new ReceiverController();

    sender.dispatch({ type: 'START', sessionId });
    sender.dispatch({ type: 'HELLO_SENT' });
    receiver.dispatch({ type: 'HELLO', sessionId, valid: true });
    sender.dispatch({ type: 'HELLO_ACK', sessionId, accepted: true });

    expect(receiver.dispatch({ type: 'CANCEL' }).state).toBe('CANCELLED');
    expect(sender.dispatch({ type: 'CANCEL' }).state).toBe('CANCELLED');
  });

});
