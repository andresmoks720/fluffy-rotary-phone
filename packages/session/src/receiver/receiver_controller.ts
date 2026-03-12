import { SessionControllerError, type TurnOwner } from '../shared.js';
import { nextReceiverState } from './receiver_fsm.js';
import type { ReceiverState } from './receiver_state.js';

type ReceiverEvent =
  | { type: 'HELLO'; sessionId: number; valid: boolean }
  | { type: 'DATA_START'; sessionId: number }
  | { type: 'BURST_COMPLETE'; sessionId: number }
  | { type: 'DATA_COMPLETE'; sessionId: number }
  | { type: 'BURST_ACK_SENT' }
  | { type: 'END'; sessionId: number; valid: boolean }
  | { type: 'FINAL_SENT' }
  | { type: 'TIMEOUT' }
  | { type: 'PROTOCOL_ERROR' }
  | { type: 'CANCEL' }
  | { type: 'RESET' };

export interface ReceiverControllerSnapshot {
  state: ReceiverState;
  sessionId: number | null;
  expectedTurn: TurnOwner;
}

export class ReceiverController {
  private state: ReceiverState = 'LISTEN';
  private sessionId: number | null = null;
  private expectedTurn: TurnOwner = 'sender';

  snapshot(): ReceiverControllerSnapshot {
    return { state: this.state, sessionId: this.sessionId, expectedTurn: this.expectedTurn };
  }

  dispatch(event: ReceiverEvent): ReceiverControllerSnapshot {
    switch (event.type) {
      case 'HELLO':
        this.requireTurn('sender');
        if (event.valid) {
          this.sessionId = event.sessionId;
          this.state = nextReceiverState(this.state, 'HELLO_VALID');
          this.expectedTurn = 'sender';
        } else {
          this.state = nextReceiverState(this.state, 'HELLO_INVALID');
        }
        return this.snapshot();

      case 'DATA_START':
        this.requireTurn('sender');
        this.requireSession(event.sessionId);
        this.state = nextReceiverState(this.state, 'DATA_TURN_STARTED');
        return this.snapshot();

      case 'BURST_COMPLETE':
        this.requireSession(event.sessionId);
        this.state = nextReceiverState(this.state, 'BURST_COMPLETE');
        this.expectedTurn = 'receiver';
        return this.snapshot();

      case 'DATA_COMPLETE':
        this.requireSession(event.sessionId);
        this.state = nextReceiverState(this.state, 'DATA_COMPLETE');
        this.expectedTurn = 'sender';
        return this.snapshot();


      case 'BURST_ACK_SENT':
        this.requireTurn('receiver');
        if (this.state !== 'WAIT_DATA') {
          throw new SessionControllerError('BURST_ACK_SENT only valid in WAIT_DATA');
        }
        this.expectedTurn = 'sender';
        return this.snapshot();

      case 'END':
        this.requireTurn('sender');
        this.requireSession(event.sessionId);
        if (this.state === 'SUCCESS' && event.valid) {
          this.state = nextReceiverState(this.state, 'DUPLICATE_END');
          this.expectedTurn = 'receiver';
          return this.snapshot();
        }
        this.state = nextReceiverState(this.state, event.valid ? 'END_VALID' : 'END_INVALID');
        this.expectedTurn = 'receiver';
        return this.snapshot();

      case 'FINAL_SENT':
        this.requireTurn('receiver');
        this.state = nextReceiverState(this.state, 'FINAL_SENT');
        this.expectedTurn = 'sender';
        return this.snapshot();

      case 'TIMEOUT':
        this.state = nextReceiverState(this.state, 'TIMEOUT');
        this.expectedTurn = 'sender';
        return this.snapshot();

      case 'PROTOCOL_ERROR':
        this.state = nextReceiverState(this.state, 'PROTOCOL_ERROR');
        this.expectedTurn = 'sender';
        return this.snapshot();

      case 'CANCEL':
        this.state = nextReceiverState(this.state, 'CANCEL');
        this.expectedTurn = 'sender';
        return this.snapshot();

      case 'RESET':
        this.state = nextReceiverState(this.state, 'RESET');
        this.sessionId = null;
        this.expectedTurn = 'sender';
        return this.snapshot();
    }
  }

  private requireSession(sessionId: number): void {
    if (this.sessionId === null || this.sessionId !== sessionId) {
      throw new SessionControllerError('invalid session ID');
    }
  }

  private requireTurn(owner: TurnOwner): void {
    if (this.expectedTurn !== owner) {
      throw new SessionControllerError(`invalid turn owner: expected ${this.expectedTurn}, got ${owner}`);
    }
  }
}
