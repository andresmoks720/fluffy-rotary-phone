import { describe, expect, it } from 'vitest';

import {
  FLAGS_MVP_DEFAULT,
  FRAME_TYPES,
  PROFILE_DEFAULTS,
  PROFILE_IDS
} from '../../contract/src/index.js';
import { crc32c } from '../../crc/src/index.js';
import { decodeFrame, encodeFrame } from '../../protocol/src/index.js';
import { LiveReceiverTransfer, LiveSenderTransfer } from '../src/index.js';

function runSimulatedWireTransfer(payload: Uint8Array): Uint8Array {
  const sessionId = 0xabc01234;
  const profileId = PROFILE_IDS.SAFE;
  const defaults = PROFILE_DEFAULTS[profileId];
  const totalDataFrames = Math.ceil(payload.length / defaults.payloadBytesPerFrame);
  const crc = crc32c(payload);

  const sender = new LiveSenderTransfer({ sessionId, profileId, fileBytes: payload });
  const receiver = new LiveReceiverTransfer({
    sessionId,
    profileId,
    fileSizeBytes: payload.length,
    fileCrc32c: crc,
    totalDataFrames
  });

  let senderStep = sender.initialBurstFrames();
  for (let loops = 0; loops < 5000 && !senderStep.done && !senderStep.failed; loops += 1) {
    for (const frame of senderStep.txFrames) {
      const decoded = decodeFrame(frame, { expectedSessionId: sessionId });
      if (decoded.frameType === FRAME_TYPES.DATA) {
        receiver.onData(frame);
      } else if (decoded.frameType === FRAME_TYPES.END) {
        const final = receiver.onEnd(frame);
        senderStep = sender.onFinal(final);
      }
    }

    if (senderStep.done || senderStep.failed) {
      break;
    }

    const ack = receiver.emitBurstAck();
    senderStep = sender.onBurstAck(ack);
  }

  const saved = receiver.savedFileBytes();
  if (!saved) {
    throw new Error('expected successful save-after-success path');
  }
  return saved;
}

describe('live transfer integration', () => {
  it('completes DATA/BURST_ACK/END/FINAL_OK flow and only exposes output after success', () => {
    const payload = new Uint8Array(1024 * 128);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

    const saved = runSimulatedWireTransfer(payload);
    expect(saved).toEqual(payload);
  });

  it('supports repeated 10 MiB cable-style simulated transfers', () => {
    const payload = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

    for (let run = 0; run < 3; run += 1) {
      const saved = runSimulatedWireTransfer(payload);
      expect(saved.byteLength).toBe(payload.byteLength);
      expect(saved[0]).toBe(payload[0]);
      expect(saved[saved.length - 1]).toBe(payload[payload.length - 1]);
    }
  });


  it('retries full burst on BURST_ACK timeout then cancels after exhaustion', () => {
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

    const sender = new LiveSenderTransfer({ sessionId: 7, profileId: PROFILE_IDS.SAFE, fileBytes: payload });
    const first = sender.initialBurstFrames();
    expect(first.txFrames.length).toBeGreaterThan(0);

    let cancelSeen = false;
    for (let i = 0; i < 16; i += 1) {
      const retry = sender.onBurstAckTimeout();
      if (retry.failed && retry.txFrames.length > 0) {
        const decoded = decodeFrame(retry.txFrames[0] as Uint8Array, { expectedSessionId: 7 });
        if (decoded.frameType === FRAME_TYPES.CANCEL) {
          cancelSeen = true;
          break;
        }
      }
    }

    expect(cancelSeen).toBe(true);
  });

  it('fails deterministically when BURST_ACK burst metadata mismatches active burst', () => {
    const payload = new Uint8Array(2048);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

    const sender = new LiveSenderTransfer({ sessionId: 55, profileId: PROFILE_IDS.SAFE, fileBytes: payload });
    sender.initialBurstFrames();

    const badAck = encodeFrame({
      version: 0x01,
      frameType: FRAME_TYPES.BURST_ACK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 55,
      burstId: 99,
      slotCount: 1,
      ackBitmap: 0x0001
    });

    const result = sender.onBurstAck(badAck);
    expect(result.failed).toBe(true);
    expect(result.txFrames.length).toBe(1);
    const decoded = decodeFrame(result.txFrames[0] as Uint8Array, { expectedSessionId: 55 });
    expect(decoded.frameType).toBe(FRAME_TYPES.CANCEL);
  });

  it('retries END on final timeout then emits CANCEL after exhaustion', () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5]);
    const sender = new LiveSenderTransfer({ sessionId: 1, profileId: PROFILE_IDS.SAFE, fileBytes: payload });

    let step = sender.initialBurstFrames();
    const defaults = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const ack = encodeFrame({
      version: 0x01,
      frameType: FRAME_TYPES.BURST_ACK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 1,
      burstId: 0,
      slotCount: 1,
      ackBitmap: 0x0001
    });
    step = sender.onBurstAck(ack);
    expect(step.txFrames.length).toBe(1);

    let cancelSeen = false;
    for (let i = 0; i < 8; i += 1) {
      step = sender.onFinalTimeout();
      const frame = step.txFrames[0];
      if (frame) {
        const decoded = decodeFrame(frame, { expectedSessionId: 1 });
        if (decoded.frameType === FRAME_TYPES.CANCEL) {
          cancelSeen = true;
        }
      }
    }

    expect(cancelSeen).toBe(true);
    expect(defaults.framesPerBurst).toBeGreaterThan(0);
  });
});
