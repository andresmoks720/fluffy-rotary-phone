import { RETRY_LIMITS } from '../../../contract/src/index.js';
import { SessionControllerError, type TurnOwner } from '../shared.js';
import { nextSenderState } from './sender_fsm.js';
import type { SenderState } from './sender_state.js';

type SenderEvent =
  | { type: 'START'; sessionId: number }
  | { type: 'HELLO_SENT' }
  | { type: 'HELLO_ACK'; sessionId: number; accepted: boolean }
  | { type: 'BURST_SENT' }
  | { type: 'BURST_ACK'; sessionId: number; allAcked: boolean }
  | { type: 'RETX_SENT' }
  | { type: 'END_SENT' }
  | { type: 'FINAL'; sessionId: number; ok: boolean }
  | { type: 'TIMEOUT'; phase: 'HELLO_ACK' | 'BURST_ACK' | 'FINAL' }
  | { type: 'CANCEL' }
  | { type: 'RESET' };

export interface SenderControllerSnapshot {
  state: SenderState;
  sessionId: number | null;
  expectedTurn: TurnOwner;
  retries: {
    hello: number;
    burst: number;
    end: number;
  };
}

export class SenderController {
  private state: SenderState = 'IDLE';
  private sessionId: number | null = null;
  private expectedTurn: TurnOwner = 'sender';
  private retries = { hello: 0, burst: 0, end: 0 };

  snapshot(): SenderControllerSnapshot {
    return {
      state: this.state,
      sessionId: this.sessionId,
      expectedTurn: this.expectedTurn,
      retries: { ...this.retries }
    };
  }

  dispatch(event: SenderEvent): SenderControllerSnapshot {
    switch (event.type) {
      case 'START': {
        if (this.state !== 'IDLE') {
          throw new SessionControllerError('sender START only valid in IDLE');
        }
        this.sessionId = event.sessionId;
        this.state = nextSenderState(this.state, 'START');
        this.expectedTurn = 'sender';
        this.retries = { hello: 0, burst: 0, end: 0 };
        return this.snapshot();
      }

      case 'HELLO_SENT':
        this.requireTurn('sender');
        this.state = nextSenderState(this.state, 'HELLO_SENT');
        this.expectedTurn = 'receiver';
        return this.snapshot();

      case 'HELLO_ACK':
        this.requireSession(event.sessionId);
        this.requireTurn('receiver');
        this.state = nextSenderState(this.state, event.accepted ? 'HELLO_ACK_ACCEPT' : 'HELLO_ACK_REJECT');
        this.expectedTurn = this.state === 'SEND_BURST' ? 'sender' : this.expectedTurn;
        return this.snapshot();

      case 'BURST_SENT':
        this.requireTurn('sender');
        this.state = nextSenderState(this.state, 'BURST_SENT');
        this.expectedTurn = 'receiver';
        return this.snapshot();

      case 'BURST_ACK':
        this.requireSession(event.sessionId);
        this.requireTurn('receiver');
        this.state = nextSenderState(this.state, event.allAcked ? 'BURST_ACK_ALL' : 'BURST_ACK_PARTIAL');
        this.expectedTurn = 'sender';
        this.retries.burst = 0;
        return this.snapshot();

      case 'RETX_SENT':
        this.requireTurn('sender');
        this.state = nextSenderState(this.state, 'RETX_SENT');
        this.expectedTurn = 'receiver';
        return this.snapshot();

      case 'END_SENT':
        this.requireTurn('sender');
        this.state = nextSenderState(this.state, 'END_SENT');
        this.expectedTurn = 'receiver';
        return this.snapshot();

      case 'FINAL':
        this.requireSession(event.sessionId);
        if (this.state === 'SUCCESS' && event.ok) {
          this.state = nextSenderState(this.state, 'FINAL_OK');
          return this.snapshot();
        }
        this.requireTurn('receiver');
        this.state = nextSenderState(this.state, event.ok ? 'FINAL_OK' : 'FINAL_BAD');
        this.expectedTurn = 'sender';
        return this.snapshot();

      case 'TIMEOUT': {
        this.requireTurn('receiver');
        if (event.phase === 'HELLO_ACK') {
          return this.handleRetry('hello', RETRY_LIMITS.HELLO);
        }
        if (event.phase === 'BURST_ACK') {
          return this.handleRetry('burst', RETRY_LIMITS.PER_BURST);
        }
        return this.handleRetry('end', RETRY_LIMITS.END_FINAL_CONFIRMATION);
      }

      case 'CANCEL':
        this.state = nextSenderState(this.state, 'CANCEL');
        this.expectedTurn = 'sender';
        return this.snapshot();

      case 'RESET':
        this.state = nextSenderState(this.state, 'RESET');
        this.sessionId = null;
        this.expectedTurn = 'sender';
        this.retries = { hello: 0, burst: 0, end: 0 };
        return this.snapshot();
    }
  }

  private handleRetry(key: 'hello' | 'burst' | 'end', limit: number): SenderControllerSnapshot {
    this.retries[key] += 1;
    if (this.retries[key] > limit) {
      this.state = nextSenderState(this.state, 'RETRY_EXHAUSTED');
      this.expectedTurn = 'sender';
      return this.snapshot();
    }

    this.state = nextSenderState(this.state, 'TIMEOUT_RETRY');
    this.expectedTurn = 'sender';
    return this.snapshot();
  }

  private requireSession(sessionId: number): void {
    if (this.sessionId === null || sessionId !== this.sessionId) {
      throw new SessionControllerError('invalid session ID');
    }
  }

  private requireTurn(owner: TurnOwner): void {
    if (this.expectedTurn !== owner) {
      throw new SessionControllerError(`invalid turn owner: expected ${this.expectedTurn}, got ${owner}`);
    }
  }
}
