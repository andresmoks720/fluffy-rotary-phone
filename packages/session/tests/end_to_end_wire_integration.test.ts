import { describe, expect, it } from 'vitest';

import {
  FLAGS_MVP_DEFAULT,
  FRAME_TYPES,
  PROFILE_DEFAULTS,
  PROFILE_IDS,
  PROTOCOL_VERSION
} from '../../contract/src/index.js';
import { crc32c } from '../../crc/src/index.js';
import {
  buildAckBitmap,
  decodeFrame,
  encodeFrame,
  missingSlotsFromAckBitmap
} from '../../protocol/src/index.js';
import { ReceiverController, SenderController } from '../src/index.js';

function buildPayload(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (i * 13 + 7) & 0xff;
  }
  return out;
}

function dataFrameFor(
  sessionId: number,
  burstId: number,
  slotIndex: number,
  payloadFileOffset: number,
  payload: Uint8Array
): Uint8Array {
  return encodeFrame({
    version: PROTOCOL_VERSION,
    frameType: FRAME_TYPES.DATA,
    flags: FLAGS_MVP_DEFAULT,
    profileId: PROFILE_IDS.SAFE,
    sessionId,
    burstId,
    slotIndex,
    payloadFileOffset,
    payload
  });
}

describe('wire-level integration and end-to-end outcomes', () => {
  it('completes wire-level transfer with selective retransmit and FINAL_OK', () => {
    const sessionId = 0x55000001;
    const { payloadBytesPerFrame, framesPerBurst } = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const file = buildPayload(payloadBytesPerFrame * 3 + 73);
    const receiverFile = new Uint8Array(file.length);

    const sender = new SenderController();
    const receiver = new ReceiverController();

    sender.dispatch({ type: 'START', sessionId });
    sender.dispatch({ type: 'HELLO_SENT' });
    receiver.dispatch({ type: 'HELLO', sessionId, valid: true });
    sender.dispatch({ type: 'HELLO_ACK', sessionId, accepted: true });

    sender.dispatch({ type: 'BURST_SENT' });
    receiver.dispatch({ type: 'DATA_START', sessionId });

    const totalFrames = Math.ceil(file.length / payloadBytesPerFrame);
    const receivedSlots: number[] = [];

    for (let i = 0; i < totalFrames; i += 1) {
      const slotIndex = i;
      const offset = i * payloadBytesPerFrame;
      const payload = file.slice(offset, Math.min(file.length, offset + payloadBytesPerFrame));
      const bytes = dataFrameFor(sessionId, 0, slotIndex, offset, payload);

      const decoded = decodeFrame(bytes, {
        expectedVersion: PROTOCOL_VERSION,
        expectedSessionId: sessionId,
        expectedProfileId: PROFILE_IDS.SAFE,
        expectedTurnOwner: 'sender'
      });

      // deterministically drop slot 2 in first pass to force selective retransmit
      if (slotIndex === 2) {
        continue;
      }

      if (decoded.frameType !== FRAME_TYPES.DATA) {
        throw new Error('expected DATA frame');
      }

      receiverFile.set(decoded.payload, decoded.payloadFileOffset);
      receivedSlots.push(decoded.slotIndex);
    }

    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId });

    const ackBitmap = buildAckBitmap(framesPerBurst, receivedSlots);
    const ackBytes = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.BURST_ACK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId,
      burstId: 0,
      slotCount: framesPerBurst,
      ackBitmap
    });
    receiver.dispatch({ type: 'BURST_ACK_SENT' });

    const ack = decodeFrame(ackBytes, {
      expectedVersion: PROTOCOL_VERSION,
      expectedSessionId: sessionId,
      expectedProfileId: PROFILE_IDS.SAFE,
      expectedTurnOwner: 'receiver'
    });
    if (ack.frameType !== FRAME_TYPES.BURST_ACK) {
      throw new Error('expected BURST_ACK frame');
    }

    const missing = missingSlotsFromAckBitmap(ack.slotCount, ack.ackBitmap).filter((s) => s < totalFrames);
    expect(missing).toEqual([2]);

    sender.dispatch({ type: 'BURST_ACK', sessionId, allAcked: false });
    sender.dispatch({ type: 'RETX_SENT' });
    receiver.dispatch({ type: 'DATA_START', sessionId });

    for (const slotIndex of missing) {
      const offset = slotIndex * payloadBytesPerFrame;
      const payload = file.slice(offset, Math.min(file.length, offset + payloadBytesPerFrame));
      const retx = decodeFrame(dataFrameFor(sessionId, 0, slotIndex, offset, payload));
      if (retx.frameType !== FRAME_TYPES.DATA) {
        throw new Error('expected DATA retransmit');
      }
      receiverFile.set(retx.payload, retx.payloadFileOffset);
    }

    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId });
    receiver.dispatch({ type: 'BURST_ACK_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId, allAcked: true });

    receiver.dispatch({ type: 'DATA_COMPLETE', sessionId });
    sender.dispatch({ type: 'END_SENT' });

    const end = decodeFrame(
      encodeFrame({
        version: PROTOCOL_VERSION,
        frameType: FRAME_TYPES.END,
        flags: FLAGS_MVP_DEFAULT,
        profileId: PROFILE_IDS.SAFE,
        sessionId,
        fileSizeBytes: BigInt(file.length),
        totalDataFrames: totalFrames,
        fileCrc32c: crc32c(file)
      })
    );

    if (end.frameType !== FRAME_TYPES.END) {
      throw new Error('expected END');
    }

    const observed = crc32c(receiverFile);
    const ok = observed === end.fileCrc32c;
    receiver.dispatch({ type: 'END', sessionId, valid: ok });
    receiver.dispatch({ type: 'FINAL_SENT' });
    sender.dispatch({ type: 'FINAL', sessionId, ok });

    expect(ok).toBe(true);
    expect(sender.snapshot().state).toBe('SUCCESS');
    expect(receiver.snapshot().state).toBe('SUCCESS');
  });

  it('emits FINAL_BAD and preserves no-save invariant on CRC mismatch', () => {
    const sessionId = 0x55000002;
    const { payloadBytesPerFrame } = PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    const file = buildPayload(payloadBytesPerFrame + 5);
    const receiverFile = new Uint8Array(file);
    let savedOutput: Uint8Array | null = null;

    const sender = new SenderController();
    const receiver = new ReceiverController();

    sender.dispatch({ type: 'START', sessionId });
    sender.dispatch({ type: 'HELLO_SENT' });
    receiver.dispatch({ type: 'HELLO', sessionId, valid: true });
    sender.dispatch({ type: 'HELLO_ACK', sessionId, accepted: true });

    sender.dispatch({ type: 'BURST_SENT' });
    receiver.dispatch({ type: 'DATA_START', sessionId });

    const data = decodeFrame(
      dataFrameFor(sessionId, 0, 0, 0, file.slice(0, payloadBytesPerFrame))
    );
    if (data.frameType !== FRAME_TYPES.DATA) {
      throw new Error('expected DATA');
    }
    receiverFile.set(data.payload, data.payloadFileOffset);

    receiver.dispatch({ type: 'BURST_COMPLETE', sessionId });
    receiver.dispatch({ type: 'BURST_ACK_SENT' });
    sender.dispatch({ type: 'BURST_ACK', sessionId, allAcked: true });
    receiver.dispatch({ type: 'DATA_COMPLETE', sessionId });
    sender.dispatch({ type: 'END_SENT' });

    // force corruption before END validation
    receiverFile[0] ^= 0xff;

    const end = decodeFrame(
      encodeFrame({
        version: PROTOCOL_VERSION,
        frameType: FRAME_TYPES.END,
        flags: FLAGS_MVP_DEFAULT,
        profileId: PROFILE_IDS.SAFE,
        sessionId,
        fileSizeBytes: BigInt(file.length),
        totalDataFrames: 2,
        fileCrc32c: crc32c(file)
      })
    );

    if (end.frameType !== FRAME_TYPES.END) {
      throw new Error('expected END');
    }

    const ok = crc32c(receiverFile) === end.fileCrc32c;
    receiver.dispatch({ type: 'END', sessionId, valid: ok });
    receiver.dispatch({ type: 'FINAL_SENT' });
    sender.dispatch({ type: 'FINAL', sessionId, ok });

    if (ok) {
      savedOutput = new Uint8Array(receiverFile);
    }

    expect(ok).toBe(false);
    expect(savedOutput).toBeNull();
    expect(sender.snapshot().state).toBe('FAILED');
    expect(receiver.snapshot().state).toBe('FAILED');
  });

  it('rejects stale-session DATA injection without affecting active session state', () => {
    const activeSessionId = 0x55000003;
    const staleSessionId = 0x44000003;

    const sender = new SenderController();
    const receiver = new ReceiverController();

    sender.dispatch({ type: 'START', sessionId: activeSessionId });
    sender.dispatch({ type: 'HELLO_SENT' });
    receiver.dispatch({ type: 'HELLO', sessionId: activeSessionId, valid: true });
    sender.dispatch({ type: 'HELLO_ACK', sessionId: activeSessionId, accepted: true });

    sender.dispatch({ type: 'BURST_SENT' });
    receiver.dispatch({ type: 'DATA_START', sessionId: activeSessionId });

    const staleBytes = dataFrameFor(staleSessionId, 0, 0, 0, Uint8Array.from([1, 2, 3]));

    expect(() =>
      decodeFrame(staleBytes, {
        expectedVersion: PROTOCOL_VERSION,
        expectedProfileId: PROFILE_IDS.SAFE,
        expectedSessionId: activeSessionId,
        expectedTurnOwner: 'sender'
      })
    ).toThrow(/invalid session ID/);

    expect(receiver.snapshot().sessionId).toBe(activeSessionId);
    expect(receiver.snapshot().state).toBe('RECV_BURST');
  });
});
