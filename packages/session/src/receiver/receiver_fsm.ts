import { StateTransitionError } from '../errors.js';
import type { ReceiverEvent, ReceiverState } from './receiver_state.js';

export function nextReceiverState(state: ReceiverState, event: ReceiverEvent): ReceiverState {
  switch (state) {
    case 'LISTEN':
      if (event === 'HELLO_VALID') return 'WAIT_DATA';
      if (event === 'HELLO_INVALID') return 'LISTEN';
      if (event === 'CANCEL') return 'CANCELLED';
      if (event === 'RESET') return 'LISTEN';
      break;

    case 'WAIT_DATA':
      if (event === 'DATA_TURN_STARTED') return 'RECV_BURST';
      if (event === 'DATA_COMPLETE') return 'WAIT_END';
      if (event === 'END_VALID') return 'SEND_FINAL_OK';
      if (event === 'END_INVALID') return 'SEND_FINAL_BAD';
      if (event === 'TIMEOUT') return 'FAILED';
      if (event === 'PROTOCOL_ERROR') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'RECV_BURST':
      if (event === 'BURST_COMPLETE') return 'WAIT_DATA';
      if (event === 'PROTOCOL_ERROR') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'WAIT_END':
      if (event === 'DATA_COMPLETE') return 'WAIT_END';
      if (event === 'END_VALID') return 'SEND_FINAL_OK';
      if (event === 'END_INVALID') return 'SEND_FINAL_BAD';
      if (event === 'TIMEOUT') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'SEND_FINAL_OK':
      if (event === 'FINAL_SENT') return 'SUCCESS';
      if (event === 'PROTOCOL_ERROR') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'SEND_FINAL_BAD':
      if (event === 'FINAL_SENT') return 'FAILED';
      if (event === 'PROTOCOL_ERROR') return 'FAILED';
      if (event === 'CANCEL') return 'CANCELLED';
      break;

    case 'SUCCESS':
      if (event === 'DUPLICATE_END') return 'SUCCESS';
      if (event === 'CANCEL') return 'SUCCESS';
      if (event === 'RESET') return 'LISTEN';
      break;

    case 'FAILED':
      if (event === 'CANCEL') return 'FAILED';
      if (event === 'RESET') return 'LISTEN';
      break;

    case 'CANCELLED':
      if (event === 'CANCEL') return 'CANCELLED';
      if (event === 'RESET') return 'LISTEN';
      break;
  }

  throw new StateTransitionError(`invalid receiver transition: state=${state}, event=${event}`);
}
