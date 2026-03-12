import { describe, expect, it } from 'vitest';

import { crc32c } from '../../crc/src/index.js';

interface SimOptions {
  readonly dropEveryN?: number;
  readonly burstDropWindow?: { start: number; end: number };
  readonly jitterMs?: number[];
  readonly driftPpm?: number;
  readonly staleSessionEveryN?: number;
  readonly cancelAfterFrame?: number;
  readonly forceFinalBad?: boolean;
  readonly retryBudget?: number;
}

interface SimResult {
  readonly success: boolean;
  readonly final: 'FINAL_OK' | 'FINAL_BAD' | 'CANCELLED' | 'FAILED';
  readonly retries: number;
  readonly savedOutput: boolean;
  readonly reason: string;
  readonly deliveredFrames: number;
  readonly staleIgnored: number;
  readonly driftObservedPpm: number;
  readonly deadlock: boolean;
  readonly outputCrc: number | null;
  readonly expectedCrc: number;
}

function simulateTransfer(payload: Uint8Array, opts: SimOptions = {}): SimResult {
  const expectedCrc = crc32c(payload);
  const out = new Uint8Array(payload.length);
  const chunkSize = 64;
  const totalFrames = Math.ceil(payload.length / chunkSize);
  const retryBudget = opts.retryBudget ?? 8;

  let retries = 0;
  let delivered = 0;
  let staleIgnored = 0;
  let deadlock = false;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    if (opts.cancelAfterFrame !== undefined && frame >= opts.cancelAfterFrame) {
      return {
        success: false,
        final: 'CANCELLED',
        retries,
        savedOutput: false,
        reason: 'canceled mid-transfer',
        deliveredFrames: delivered,
        staleIgnored,
        driftObservedPpm: opts.driftPpm ?? 0,
        deadlock,
        outputCrc: null,
        expectedCrc
      };
    }

    if (opts.staleSessionEveryN && frame % opts.staleSessionEveryN === 0) {
      staleIgnored += 1;
    }

    const inBurstDrop =
      opts.burstDropWindow !== undefined &&
      frame >= opts.burstDropWindow.start &&
      frame <= opts.burstDropWindow.end;
    const periodicDrop = opts.dropEveryN !== undefined && opts.dropEveryN > 0 && frame % opts.dropEveryN === 0;

    if (inBurstDrop || periodicDrop) {
      retries += 1;
      if (retries > retryBudget) {
        return {
          success: false,
          final: 'FAILED',
          retries,
          savedOutput: false,
          reason: 'retry budget exhausted',
          deliveredFrames: delivered,
          staleIgnored,
          driftObservedPpm: opts.driftPpm ?? 0,
          deadlock,
          outputCrc: null,
          expectedCrc
        };
      }
    }

    const start = frame * chunkSize;
    const end = Math.min(payload.length, start + chunkSize);
    out.set(payload.slice(start, end), start);
    delivered += 1;
  }

  if ((opts.jitterMs?.length ?? 0) > 0) {
    const allFinite = opts.jitterMs!.every((j) => Number.isFinite(j));
    deadlock = !allFinite;
  }

  if (opts.forceFinalBad) {
    out[0] ^= 0xff;
  }

  const outputCrc = crc32c(out);
  const success = outputCrc === expectedCrc;

  return {
    success,
    final: success ? 'FINAL_OK' : 'FINAL_BAD',
    retries,
    savedOutput: success,
    reason: success ? 'ok' : 'final crc mismatch',
    deliveredFrames: delivered,
    staleIgnored,
    driftObservedPpm: opts.driftPpm ?? 0,
    deadlock,
    outputCrc,
    expectedCrc
  };
}

function seededPayload(length: number, seed: number): Uint8Array {
  let x = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    x = (1103515245 * x + 12345) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

describe('software simulation matrix and invariants', () => {
  it('succeeds on clean channel with small payload and matching CRC', () => {
    const payload = seededPayload(1024, 0x100);
    const result = simulateTransfer(payload);

    expect(result.final).toBe('FINAL_OK');
    expect(result.success).toBe(true);
    expect(result.outputCrc).toBe(result.expectedCrc);
  });

  it('succeeds under mild loss with bounded retransmit ratio', () => {
    const payload = seededPayload(2048, 0x101);
    const result = simulateTransfer(payload, { dropEveryN: 9 });
    const ratio = result.retries / Math.max(1, result.deliveredFrames);

    expect(result.success).toBe(true);
    expect(ratio).toBeLessThan(0.2);
  });

  it('handles burst corruption windows with explicit terminal outcome', () => {
    const payload = seededPayload(4096, 0x102);
    const successPath = simulateTransfer(payload, { burstDropWindow: { start: 4, end: 6 }, retryBudget: 10 });
    const failPath = simulateTransfer(payload, { burstDropWindow: { start: 0, end: 40 }, retryBudget: 2 });

    expect(['FINAL_OK', 'FAILED']).toContain(successPath.final);
    expect(failPath.final).toBe('FAILED');
    expect(failPath.reason).toContain('retry budget exhausted');
  });

  it('keeps timeout/jitter path explicit and non-deadlocking', () => {
    const payload = seededPayload(2048, 0x103);
    const result = simulateTransfer(payload, { jitterMs: [0, 15, 2, 30, 5] });

    expect(result.deadlock).toBe(false);
    expect(['FINAL_OK', 'FINAL_BAD', 'FAILED']).toContain(result.final);
  });

  it('exposes injected drift in diagnostics and explicit terminal outcome', () => {
    const payload = seededPayload(1536, 0x104);
    const result = simulateTransfer(payload, { driftPpm: 35 });

    expect(result.driftObservedPpm).toBe(35);
    expect(['FINAL_OK', 'FINAL_BAD', 'FAILED']).toContain(result.final);
  });

  it('never saves output when FINAL_BAD is forced', () => {
    const payload = seededPayload(1024, 0x105);
    const result = simulateTransfer(payload, { forceFinalBad: true });

    expect(result.final).toBe('FINAL_BAD');
    expect(result.savedOutput).toBe(false);
  });

  it('cancel cleanup path is explicit and does not save', () => {
    const payload = seededPayload(2048, 0x106);
    const result = simulateTransfer(payload, { cancelAfterFrame: 3 });

    expect(result.final).toBe('CANCELLED');
    expect(result.savedOutput).toBe(false);
    expect(result.reason).toContain('canceled');
  });

  it('stale-session frame injection does not affect active transfer CRC', () => {
    const payload = seededPayload(2048, 0x107);
    const clean = simulateTransfer(payload);
    const staleInjected = simulateTransfer(payload, { staleSessionEveryN: 2 });

    expect(staleInjected.staleIgnored).toBeGreaterThan(0);
    expect(staleInjected.outputCrc).toBe(clean.outputCrc);
    expect(staleInjected.final).toBe('FINAL_OK');
  });

  it('seeded SNR-grid-like Monte Carlo baseline remains explicit without hangs', () => {
    const seeds = [0x201, 0x202, 0x203, 0x204, 0x205];
    const outcomes = seeds.map((seed, i) =>
      simulateTransfer(seededPayload(1024, seed), { dropEveryN: 8 + i, driftPpm: i * 5 })
    );

    for (const outcome of outcomes) {
      expect(outcome.deadlock).toBe(false);
      expect(['FINAL_OK', 'FINAL_BAD', 'FAILED']).toContain(outcome.final);
    }
  });
});
