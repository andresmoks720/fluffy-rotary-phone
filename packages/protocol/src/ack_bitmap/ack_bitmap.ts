import { FrameValidationError, assert } from '../validation/errors.js';

export const MAX_ACK_SLOTS = 16;

export function validateSlotCount(slotCount: number): void {
  assert(Number.isInteger(slotCount), 'slot_count must be an integer');
  assert(slotCount >= 1 && slotCount <= MAX_ACK_SLOTS, 'slot_count must be between 1 and 16');
}

export function buildAckBitmap(slotCount: number, validSlots: ReadonlyArray<number>): number {
  validateSlotCount(slotCount);

  let bitmap = 0;
  for (const slot of validSlots) {
    assert(Number.isInteger(slot), 'slot index must be an integer');
    assert(slot >= 0 && slot < slotCount, 'slot index is out of bounds for slot_count');
    bitmap |= 1 << slot;
  }

  return bitmap & 0xffff;
}

export function isSlotAcked(ackBitmap: number, slotIndex: number): boolean {
  if (!Number.isInteger(ackBitmap) || ackBitmap < 0 || ackBitmap > 0xffff) {
    throw new FrameValidationError('ack_bitmap must be a uint16');
  }

  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_ACK_SLOTS) {
    throw new FrameValidationError('slotIndex must be an integer from 0 to 15');
  }

  return ((ackBitmap >>> slotIndex) & 0x1) === 1;
}

export function missingSlotsFromAckBitmap(slotCount: number, ackBitmap: number): number[] {
  validateSlotCount(slotCount);
  if (!Number.isInteger(ackBitmap) || ackBitmap < 0 || ackBitmap > 0xffff) {
    throw new FrameValidationError('ack_bitmap must be a uint16');
  }

  const missing: number[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    if (((ackBitmap >>> i) & 0x1) === 0) {
      missing.push(i);
    }
  }

  return missing;
}
