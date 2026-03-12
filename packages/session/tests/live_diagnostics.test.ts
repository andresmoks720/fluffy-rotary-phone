import { describe, expect, it } from 'vitest';

import { createInitialLiveDiagnostics } from '../src/index.js';

describe('live diagnostics model', () => {
  it('initializes deterministic zeroed counters and failure state', () => {
    const d = createInitialLiveDiagnostics({ state: 'LISTEN', currentTurnOwner: 'sender' });

    expect(d.state).toBe('LISTEN');
    expect(d.currentTurnOwner).toBe('sender');
    expect(d.counters.retransmissions).toBe(0);
    expect(d.counters.crcFailuresHeader).toBe(0);
    expect(d.counters.crcFailuresPayload).toBe(0);
    expect(d.counters.timeoutsHelloAck).toBe(0);
    expect(d.effectiveGoodputBps).toBe(0);
    expect(d.failure).toEqual({ category: 'none', reason: null });
  });
});
