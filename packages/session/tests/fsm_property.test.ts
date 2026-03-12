import { describe, expect, it } from 'vitest';

import {
  nextReceiverState,
  nextSenderState,
  type ReceiverState,
  type SenderState
} from '../src/index.js';

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (1103515245 * x + 12345) >>> 0;
    return x / 0x100000000;
  };
}

const senderEvents = [
  'START',
  'HELLO_SENT',
  'HELLO_ACK_ACCEPT',
  'HELLO_ACK_REJECT',
  'BURST_SENT',
  'BURST_ACK_PARTIAL',
  'BURST_ACK_ALL',
  'RETX_SENT',
  'END_SENT',
  'FINAL_OK',
  'FINAL_BAD',
  'TIMEOUT_RETRY',
  'RETRY_EXHAUSTED',
  'CANCEL',
  'RESET'
] as const;

const receiverEvents = [
  'HELLO_VALID',
  'HELLO_INVALID',
  'DATA_TURN_STARTED',
  'BURST_COMPLETE',
  'DATA_COMPLETE',
  'END_VALID',
  'END_INVALID',
  'FINAL_SENT',
  'TIMEOUT',
  'PROTOCOL_ERROR',
  'DUPLICATE_END',
  'CANCEL',
  'RESET'
] as const;

const senderStates = new Set<SenderState>([
  'IDLE',
  'HELLO_TX',
  'WAIT_HELLO_ACK',
  'SEND_BURST',
  'WAIT_BURST_ACK',
  'RETX_BURST',
  'SEND_END',
  'WAIT_FINAL',
  'SUCCESS',
  'FAILED',
  'CANCELLED'
]);

const receiverStates = new Set<ReceiverState>([
  'LISTEN',
  'WAIT_DATA',
  'RECV_BURST',
  'WAIT_END',
  'SEND_FINAL_OK',
  'SEND_FINAL_BAD',
  'SUCCESS',
  'FAILED',
  'CANCELLED'
]);

describe('fsm bounded illegal-order properties', () => {
  it('sender FSM never leaves declared state space', () => {
    const rand = lcg(0x7001);
    let state: SenderState = 'IDLE';

    for (let i = 0; i < 500; i += 1) {
      const event = senderEvents[Math.floor(rand() * senderEvents.length)];
      try {
        state = nextSenderState(state, event);
        expect(senderStates.has(state)).toBe(true);
      } catch (error) {
        expect(String(error)).toMatch(/invalid sender transition/);
        expect(senderStates.has(state)).toBe(true);
      }
    }
  });

  it('receiver FSM never leaves declared state space', () => {
    const rand = lcg(0x7002);
    let state: ReceiverState = 'LISTEN';

    for (let i = 0; i < 500; i += 1) {
      const event = receiverEvents[Math.floor(rand() * receiverEvents.length)];
      try {
        state = nextReceiverState(state, event);
        expect(receiverStates.has(state)).toBe(true);
      } catch (error) {
        expect(String(error)).toMatch(/invalid receiver transition/);
        expect(receiverStates.has(state)).toBe(true);
      }
    }
  });
});
