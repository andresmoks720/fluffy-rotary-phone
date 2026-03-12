import { StateTransitionError } from '../errors.js';
import type { SenderEvent, SenderState } from './sender_state.js';

export function nextSenderState(state: SenderState, event: SenderEvent): SenderState {
  switch (state) {
    case 'IDLE':
      if (event === 'START') return 'HELLO_TX';
      if (event === 'RESET') return 'IDLE';
      if (event === 'CANCEL') return 'IDLE';
      break;

    case 'HELLO_TX':
      if (event === 'HELLO_SENT') return 'WAIT_HELLO_ACK';
      if (event === 'ENCODE_ERROR') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'WAIT_HELLO_ACK':
      if (event === 'HELLO_ACK_ACCEPT') return 'SEND_BURST';
      if (event === 'HELLO_ACK_REJECT') return 'FAILED';
      if (event === 'TIMEOUT_RETRY') return 'HELLO_TX';
      if (event === 'RETRY_EXHAUSTED') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'SEND_BURST':
      if (event === 'BURST_SENT') return 'WAIT_BURST_ACK';
      if (event === 'ENCODE_ERROR') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'WAIT_BURST_ACK':
      if (event === 'BURST_ACK_ALL') return 'SEND_END';
      if (event === 'BURST_ACK_PARTIAL') return 'RETX_BURST';
      if (event === 'TIMEOUT_RETRY') return 'RETX_BURST';
      if (event === 'RETRY_EXHAUSTED') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'RETX_BURST':
      if (event === 'RETX_SENT') return 'WAIT_BURST_ACK';
      if (event === 'ENCODE_ERROR') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'SEND_END':
      if (event === 'END_SENT') return 'WAIT_FINAL';
      if (event === 'ENCODE_ERROR') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'WAIT_FINAL':
      if (event === 'FINAL_OK') return 'SUCCESS';
      if (event === 'FINAL_BAD') return 'FAILED';
      if (event === 'TIMEOUT_RETRY') return 'SEND_END';
      if (event === 'RETRY_EXHAUSTED') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'SUCCESS':
      if (event === 'FINAL_OK') return 'SUCCESS';
      if (event === 'RESET') return 'IDLE';
      if (event === 'CANCEL') return 'SUCCESS';
      break;

    case 'FAILED':
      if (event === 'RESET') return 'IDLE';
      if (event === 'CANCEL') return 'FAILED';
      break;

    case 'CANCELLED':
      if (event === 'RESET') return 'IDLE';
      if (event === 'CANCEL') return 'CANCELLED';
      break;
  }

  throw new StateTransitionError(`invalid sender transition: state=${state}, event=${event}`);
}
