import {
  CANCEL_REASON_CODES,
  FINAL_BAD_REASON_CODES,
  FLAGS_MVP_DEFAULT,
  FRAME_TYPES,
  PROFILE_DEFAULTS,
  PROFILE_IDS,
  RETRY_LIMITS
} from '../../contract/src/index.js';
import { crc32c } from '../../crc/src/index.js';
import { buildAckBitmap, decodeFrame, encodeFrame, missingSlotsFromAckBitmap } from '../../protocol/src/index.js';

interface SenderPlanInput {
  sessionId: number;
  profileId: number;
  fileBytes: Uint8Array;
}

export interface SenderStepResult {
  readonly txFrames: Uint8Array[];
  readonly done: boolean;
  readonly failed: boolean;
}

export class LiveSenderTransfer {
  private readonly sessionId: number;
  private readonly profileId: number;
  private readonly fileBytes: Uint8Array;
  private readonly payloadBytesPerFrame: number;
  private readonly framesPerBurst: number;
  private readonly totalDataFrames: number;
  private readonly totalBursts: number;

  private burstId = 0;
  private burstRetryCount = 0;
  private endRetryCount = 0;
  private state: 'send_data' | 'wait_burst_ack' | 'wait_final' | 'success' | 'failed' = 'send_data';

  constructor(input: SenderPlanInput) {
    const profile = PROFILE_DEFAULTS[input.profileId as keyof typeof PROFILE_DEFAULTS] ?? PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    this.sessionId = input.sessionId;
    this.profileId = input.profileId;
    this.fileBytes = input.fileBytes;
    this.payloadBytesPerFrame = profile.payloadBytesPerFrame;
    this.framesPerBurst = profile.framesPerBurst;
    this.totalDataFrames = Math.ceil(input.fileBytes.length / this.payloadBytesPerFrame);
    this.totalBursts = Math.ceil(this.totalDataFrames / this.framesPerBurst);
  }

  initialBurstFrames(): SenderStepResult {
    return this.emitBurst();
  }

  onBurstAck(ackBytes: Uint8Array): SenderStepResult {
    if (this.state !== 'wait_burst_ack') {
      return { txFrames: [], done: false, failed: true };
    }
    const decoded = decodeFrame(ackBytes, { expectedSessionId: this.sessionId });
    if (decoded.frameType !== FRAME_TYPES.BURST_ACK) {
      return { txFrames: [], done: false, failed: true };
    }

    const missing = missingSlotsFromAckBitmap(decoded.slotCount, decoded.ackBitmap);
    if (missing.length === 0) {
      this.burstRetryCount = 0;
      this.burstId += 1;
      if (this.burstId >= this.totalBursts) {
        const endFrame = this.encodeEnd();
        this.state = 'wait_final';
        return { txFrames: [endFrame], done: false, failed: false };
      }
      this.state = 'send_data';
      return this.emitBurst();
    }

    this.burstRetryCount += 1;
    if (this.burstRetryCount > RETRY_LIMITS.PER_BURST) {
      this.state = 'failed';
      return { txFrames: [this.encodeCancel(CANCEL_REASON_CODES.LOCAL_TIMEOUT)], done: false, failed: true };
    }

    this.state = 'wait_burst_ack';
    return this.emitBurst(missing);
  }

  onFinal(finalBytes: Uint8Array): SenderStepResult {
    if (this.state !== 'wait_final') {
      return { txFrames: [], done: false, failed: true };
    }
    const decoded = decodeFrame(finalBytes, { expectedSessionId: this.sessionId });
    if (decoded.frameType === FRAME_TYPES.FINAL_OK) {
      this.state = 'success';
      return { txFrames: [], done: true, failed: false };
    }
    if (decoded.frameType === FRAME_TYPES.FINAL_BAD) {
      this.state = 'failed';
      return { txFrames: [], done: false, failed: true };
    }
    return { txFrames: [], done: false, failed: true };
  }

  onFinalTimeout(): SenderStepResult {
    if (this.state !== 'wait_final') {
      return { txFrames: [], done: false, failed: true };
    }
    this.endRetryCount += 1;
    if (this.endRetryCount > RETRY_LIMITS.END_FINAL_CONFIRMATION) {
      this.state = 'failed';
      return { txFrames: [this.encodeCancel(CANCEL_REASON_CODES.LOCAL_TIMEOUT)], done: false, failed: true };
    }
    return { txFrames: [this.encodeEnd()], done: false, failed: false };
  }

  private emitBurst(onlyMissingSlots?: readonly number[]): SenderStepResult {
    const slotCount = Math.min(this.framesPerBurst, this.totalDataFrames - this.burstId * this.framesPerBurst);
    const slots = onlyMissingSlots ?? Array.from({ length: slotCount }, (_, i) => i);
    const txFrames: Uint8Array[] = [];
    for (const slotIndex of slots) {
      const globalIndex = this.burstId * this.framesPerBurst + slotIndex;
      const start = globalIndex * this.payloadBytesPerFrame;
      if (start >= this.fileBytes.length) continue;
      const end = Math.min(this.fileBytes.length, start + this.payloadBytesPerFrame);
      txFrames.push(encodeFrame({
        version: 0x01,
        frameType: FRAME_TYPES.DATA,
        flags: FLAGS_MVP_DEFAULT,
        profileId: this.profileId,
        sessionId: this.sessionId,
        burstId: this.burstId,
        slotIndex,
        payloadFileOffset: start,
        payload: this.fileBytes.slice(start, end)
      }));
    }
    this.state = 'wait_burst_ack';
    return { txFrames, done: false, failed: false };
  }

  private encodeEnd(): Uint8Array {
    return encodeFrame({
      version: 0x01,
      frameType: FRAME_TYPES.END,
      flags: FLAGS_MVP_DEFAULT,
      profileId: this.profileId,
      sessionId: this.sessionId,
      fileSizeBytes: BigInt(this.fileBytes.length),
      totalDataFrames: this.totalDataFrames,
      fileCrc32c: crc32c(this.fileBytes)
    });
  }

  private encodeCancel(reasonCode: number): Uint8Array {
    return encodeFrame({
      version: 0x01,
      frameType: FRAME_TYPES.CANCEL,
      flags: FLAGS_MVP_DEFAULT,
      profileId: this.profileId,
      sessionId: this.sessionId,
      reasonCode
    });
  }
}

interface ReceiverTransferInput {
  sessionId: number;
  profileId: number;
  fileSizeBytes: number;
  fileCrc32c: number;
  totalDataFrames: number;
}

export class LiveReceiverTransfer {
  private readonly sessionId: number;
  private readonly profileId: number;
  private readonly fileSizeBytes: number;
  private readonly fileCrc32c: number;
  private readonly totalDataFrames: number;
  private readonly payloadBytesPerFrame: number;
  private readonly framesPerBurst: number;
  private readonly out: Uint8Array;
  private readonly receivedFrames = new Set<number>();
  private readonly burstSlots = new Set<number>();
  private activeBurstId: number | null = null;
  private success = false;

  constructor(input: ReceiverTransferInput) {
    const profile = PROFILE_DEFAULTS[input.profileId as keyof typeof PROFILE_DEFAULTS] ?? PROFILE_DEFAULTS[PROFILE_IDS.SAFE];
    this.sessionId = input.sessionId;
    this.profileId = input.profileId;
    this.fileSizeBytes = input.fileSizeBytes;
    this.fileCrc32c = input.fileCrc32c;
    this.totalDataFrames = input.totalDataFrames;
    this.payloadBytesPerFrame = profile.payloadBytesPerFrame;
    this.framesPerBurst = profile.framesPerBurst;
    this.out = new Uint8Array(input.fileSizeBytes);
  }

  onData(dataBytes: Uint8Array): void {
    const decoded = decodeFrame(dataBytes, { expectedSessionId: this.sessionId });
    if (decoded.frameType !== FRAME_TYPES.DATA) {
      throw new Error('expected DATA frame');
    }
    if (this.activeBurstId === null) {
      this.activeBurstId = decoded.burstId;
    }
    if (decoded.burstId !== this.activeBurstId) {
      throw new Error('mixed burst IDs before ACK');
    }

    const frameIndex = decoded.burstId * this.framesPerBurst + decoded.slotIndex;
    if (!this.receivedFrames.has(frameIndex)) {
      this.out.set(decoded.payload, decoded.payloadFileOffset);
      this.receivedFrames.add(frameIndex);
    }
    this.burstSlots.add(decoded.slotIndex);
  }

  emitBurstAck(): Uint8Array {
    if (this.activeBurstId === null) {
      throw new Error('no active burst');
    }
    const slotCount = Math.min(this.framesPerBurst, this.totalDataFrames - this.activeBurstId * this.framesPerBurst);
    const ackBitmap = buildAckBitmap(slotCount, Array.from(this.burstSlots));
    const out = encodeFrame({
      version: 0x01,
      frameType: FRAME_TYPES.BURST_ACK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: this.profileId,
      sessionId: this.sessionId,
      burstId: this.activeBurstId,
      slotCount,
      ackBitmap
    });
    const missing = missingSlotsFromAckBitmap(slotCount, ackBitmap);
    if (missing.length === 0) {
      this.activeBurstId = null;
      this.burstSlots.clear();
    }
    return out;
  }

  onEnd(endBytes: Uint8Array): Uint8Array {
    const decoded = decodeFrame(endBytes, { expectedSessionId: this.sessionId });
    if (decoded.frameType !== FRAME_TYPES.END) {
      throw new Error('expected END frame');
    }
    if (
      Number(decoded.fileSizeBytes) !== this.fileSizeBytes
      || decoded.totalDataFrames !== this.totalDataFrames
      || decoded.fileCrc32c !== this.fileCrc32c
    ) {
      return this.finalBad(FINAL_BAD_REASON_CODES.INVALID_END_METADATA, crc32c(this.out));
    }
    if (this.receivedFrames.size !== this.totalDataFrames) {
      return this.finalBad(FINAL_BAD_REASON_CODES.MISSING_DATA_REMAINS, crc32c(this.out));
    }
    const observed = crc32c(this.out);
    if (observed !== this.fileCrc32c) {
      return this.finalBad(FINAL_BAD_REASON_CODES.WHOLE_FILE_CRC_MISMATCH, observed);
    }
    this.success = true;
    return encodeFrame({
      version: 0x01,
      frameType: FRAME_TYPES.FINAL_OK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: this.profileId,
      sessionId: this.sessionId,
      observedFileCrc32c: observed
    });
  }

  savedFileBytes(): Uint8Array | null {
    if (!this.success) {
      return null;
    }
    return this.out.slice();
  }

  private finalBad(reasonCode: number, observedFileCrc32c: number): Uint8Array {
    return encodeFrame({
      version: 0x01,
      frameType: FRAME_TYPES.FINAL_BAD,
      flags: FLAGS_MVP_DEFAULT,
      profileId: this.profileId,
      sessionId: this.sessionId,
      reasonCode,
      observedFileCrc32c
    });
  }
}
