import { describe, expect, it } from 'vitest';

import { PROFILE_DEFAULTS, PROFILE_IDS } from '../../contract/src/index.js';
import {
  buildAckBitmap,
  isSlotAcked,
  missingSlotsFromAckBitmap
} from '../../protocol/src/index.js';

interface DataSlot {
  burstId: number;
  slotIndex: number;
  payload: Uint8Array;
  payloadOffset: number;
}

function buildBurstSlots(payload: Uint8Array): DataSlot[] {
  const { payloadBytesPerFrame, framesPerBurst } = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
  const slots: DataSlot[] = [];

  let burstId = 0;
  let slotIndex = 0;
  for (let offset = 0; offset < payload.length; offset += payloadBytesPerFrame) {
    slots.push({
      burstId,
      slotIndex,
      payload: payload.slice(offset, Math.min(payload.length, offset + payloadBytesPerFrame)),
      payloadOffset: offset
    });

    slotIndex += 1;
    if (slotIndex >= framesPerBurst) {
      burstId += 1;
      slotIndex = 0;
    }
  }

  return slots;
}

function selectRetransmit(slots: DataSlot[], missing: number[]): DataSlot[] {
  const missingSet = new Set(missing);
  return slots.filter((s) => missingSet.has(s.slotIndex));
}

function reconstructBurst(slots: DataSlot[], burstCapacityBytes: number): Uint8Array {
  const out = new Uint8Array(burstCapacityBytes);
  const seen = new Set<number>();

  for (const slot of slots) {
    if (seen.has(slot.slotIndex)) {
      continue;
    }
    seen.add(slot.slotIndex);
    out.set(slot.payload, slot.payloadOffset);
  }

  return out;
}

describe('burst transport integration', () => {
  it('emits contiguous burst IDs and slot indices across multiple bursts', () => {
    const { payloadBytesPerFrame, framesPerBurst } = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const payload = new Uint8Array(payloadBytesPerFrame * framesPerBurst * 2 + payloadBytesPerFrame);
    const slots = buildBurstSlots(payload);

    for (let i = 0; i < slots.length; i += 1) {
      const expectedBurstId = Math.floor(i / framesPerBurst);
      const expectedSlotIndex = i % framesPerBurst;
      expect(slots[i]?.burstId).toBe(expectedBurstId);
      expect(slots[i]?.slotIndex).toBe(expectedSlotIndex);
    }
  });

  it('emits only expected final short-burst slots with no phantom slot', () => {
    const { payloadBytesPerFrame, framesPerBurst } = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const totalFrames = framesPerBurst + 3;
    const payload = new Uint8Array(totalFrames * payloadBytesPerFrame - 7);
    const slots = buildBurstSlots(payload);

    const lastBurstSlots = slots.filter((s) => s.burstId === 1);
    expect(lastBurstSlots.map((s) => s.slotIndex)).toEqual([0, 1, 2]);
    expect(lastBurstSlots.some((s) => s.slotIndex === 3)).toBe(false);
  });

  it('builds ACK bitmap exactly for known missing slots', () => {
    const slotCount = 8;
    const received = [0, 1, 3, 5, 6];
    const ack = buildAckBitmap(slotCount, received);

    expect(ack).toBe(0x006b);
    expect(missingSlotsFromAckBitmap(slotCount, ack)).toEqual([2, 4, 7]);
  });

  it('builds all-acked bitmap and selects no retransmit frames', () => {
    const slotCount = 8;
    const received = [0, 1, 2, 3, 4, 5, 6, 7];
    const ack = buildAckBitmap(slotCount, received);
    const missing = missingSlotsFromAckBitmap(slotCount, ack);

    const slots = Array.from({ length: slotCount }, (_, i) => ({
      burstId: 0,
      slotIndex: i,
      payload: new Uint8Array([i]),
      payloadOffset: i
    }));

    expect(missing).toEqual([]);
    expect(selectRetransmit(slots, missing)).toEqual([]);
  });

  it('rejects malformed ACK bitmap deterministically', () => {
    expect(() => missingSlotsFromAckBitmap(0, 0)).toThrow(/slot_count/);
    expect(() => missingSlotsFromAckBitmap(8, -1)).toThrow(/ack_bitmap/);
    expect(() => isSlotAcked(0x1_0000, 0)).toThrow(/ack_bitmap/);
  });

  it('retransmits only missing slots from ACK bitmap', () => {
    const slots: DataSlot[] = Array.from({ length: 8 }, (_, i) => ({
      burstId: 3,
      slotIndex: i,
      payload: new Uint8Array([i]),
      payloadOffset: i
    }));
    const ack = buildAckBitmap(8, [0, 1, 3, 4, 7]);
    const missing = missingSlotsFromAckBitmap(8, ack);

    expect(missing).toEqual([2, 5, 6]);
    expect(selectRetransmit(slots, missing).map((s) => s.slotIndex)).toEqual([2, 5, 6]);
  });

  it('handles duplicate DATA slots without overwrite corruption', () => {
    const burstCapacityBytes = 16;
    const slots: DataSlot[] = [
      { burstId: 0, slotIndex: 0, payload: Uint8Array.from([1, 2]), payloadOffset: 0 },
      { burstId: 0, slotIndex: 1, payload: Uint8Array.from([3, 4]), payloadOffset: 2 },
      { burstId: 0, slotIndex: 1, payload: Uint8Array.from([9, 9]), payloadOffset: 2 }, // duplicate must be ignored
      { burstId: 0, slotIndex: 2, payload: Uint8Array.from([5, 6]), payloadOffset: 4 }
    ];

    const reconstructed = reconstructBurst(slots, burstCapacityBytes);
    expect(Array.from(reconstructed.slice(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
