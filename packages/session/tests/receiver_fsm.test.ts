import { describe, expect, it } from 'vitest';

import { nextReceiverState, type ReceiverState } from '../src/index.js';

describe('receiver FSM', () => {
  it('follows valid success flow deterministically', () => {
    let s: ReceiverState = 'LISTEN';
    s = nextReceiverState(s, 'HELLO_VALID');
    expect(s).toBe('WAIT_DATA');
    s = nextReceiverState(s, 'DATA_TURN_STARTED');
    expect(s).toBe('RECV_BURST');
    s = nextReceiverState(s, 'BURST_COMPLETE');
    expect(s).toBe('WAIT_DATA');
    s = nextReceiverState(s, 'DATA_COMPLETE');
    expect(s).toBe('WAIT_END');
    s = nextReceiverState(s, 'END_VALID');
    expect(s).toBe('SEND_FINAL_OK');
    s = nextReceiverState(s, 'FINAL_SENT');
    expect(s).toBe('SUCCESS');
  });

  it('handles invalid HELLO and invalid END deterministically', () => {
    expect(nextReceiverState('LISTEN', 'HELLO_INVALID')).toBe('LISTEN');
    expect(nextReceiverState('WAIT_END', 'END_INVALID')).toBe('SEND_FINAL_BAD');
    expect(nextReceiverState('SEND_FINAL_BAD', 'FINAL_SENT')).toBe('FAILED');
  });

  it('handles timeout and protocol error as failure', () => {
    expect(nextReceiverState('WAIT_DATA', 'TIMEOUT')).toBe('FAILED');
    expect(nextReceiverState('RECV_BURST', 'PROTOCOL_ERROR')).toBe('FAILED');
  });

  it('handles cancel and duplicate END after success', () => {
    expect(nextReceiverState('WAIT_DATA', 'CANCEL')).toBe('CANCELLED');
    expect(nextReceiverState('SUCCESS', 'DUPLICATE_END')).toBe('SUCCESS');
  });


  it('ignores duplicate CANCEL in SUCCESS and in FAILED', () => {
    expect(nextReceiverState('SUCCESS', 'CANCEL')).toBe('SUCCESS');
    expect(nextReceiverState('FAILED', 'CANCEL')).toBe('FAILED');
  });

  it('rejects invalid transition', () => {
    expect(() => nextReceiverState('LISTEN', 'FINAL_SENT')).toThrow(/invalid receiver transition/);
  });
});
