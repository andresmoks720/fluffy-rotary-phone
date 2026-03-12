import { describe, expect, it } from 'vitest';

import { nextSenderState, type SenderState } from '../src/index.js';

describe('sender FSM', () => {
  it('follows valid success flow deterministically', () => {
    let s: SenderState = 'IDLE';
    s = nextSenderState(s, 'START');
    expect(s).toBe('HELLO_TX');
    s = nextSenderState(s, 'HELLO_SENT');
    expect(s).toBe('WAIT_HELLO_ACK');
    s = nextSenderState(s, 'HELLO_ACK_ACCEPT');
    expect(s).toBe('SEND_BURST');
    s = nextSenderState(s, 'BURST_SENT');
    expect(s).toBe('WAIT_BURST_ACK');
    s = nextSenderState(s, 'BURST_ACK_ALL');
    expect(s).toBe('SEND_END');
    s = nextSenderState(s, 'END_SENT');
    expect(s).toBe('WAIT_FINAL');
    s = nextSenderState(s, 'FINAL_OK');
    expect(s).toBe('SUCCESS');
  });

  it('handles timeout retry and retry exhaustion explicitly', () => {
    expect(nextSenderState('WAIT_HELLO_ACK', 'TIMEOUT_RETRY')).toBe('HELLO_TX');
    expect(nextSenderState('WAIT_BURST_ACK', 'TIMEOUT_RETRY')).toBe('RETX_BURST');
    expect(nextSenderState('WAIT_FINAL', 'TIMEOUT_RETRY')).toBe('SEND_END');

    expect(nextSenderState('WAIT_HELLO_ACK', 'RETRY_EXHAUSTED')).toBe('FAILED');
    expect(nextSenderState('WAIT_BURST_ACK', 'RETRY_EXHAUSTED')).toBe('FAILED');
    expect(nextSenderState('WAIT_FINAL', 'RETRY_EXHAUSTED')).toBe('FAILED');
  });

  it('handles cancel from active states', () => {
    expect(nextSenderState('WAIT_BURST_ACK', 'CANCEL')).toBe('CANCELLED');
    expect(nextSenderState('IDLE', 'CANCEL')).toBe('IDLE');
  });


  it('ignores duplicate FINAL_OK in SUCCESS', () => {
    expect(nextSenderState('SUCCESS', 'FINAL_OK')).toBe('SUCCESS');
  });

  it('ignores optional CANCEL in FAILED', () => {
    expect(nextSenderState('FAILED', 'CANCEL')).toBe('FAILED');
  });

  it('rejects invalid transition', () => {
    expect(() => nextSenderState('IDLE', 'FINAL_OK')).toThrow(/invalid sender transition/);
  });
});
