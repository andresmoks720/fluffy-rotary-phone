export type ReceiverState =
  | 'LISTEN'
  | 'WAIT_DATA'
  | 'RECV_BURST'
  | 'WAIT_END'
  | 'SEND_FINAL_OK'
  | 'SEND_FINAL_BAD'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED';

export type ReceiverEvent =
  | 'HELLO_VALID'
  | 'HELLO_INVALID'
  | 'HELLO_ACK_SENT'
  | 'DATA_TURN_STARTED'
  | 'BURST_COMPLETE'
  | 'DATA_COMPLETE'
  | 'END_VALID'
  | 'END_INVALID'
  | 'FINAL_SENT'
  | 'TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'CANCEL'
  | 'RESET'
  | 'DUPLICATE_END';
