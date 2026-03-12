import {
  FLAGS_MVP_DEFAULT,
  FRAME_TYPES,
  HELLO_REJECT_CODES,
  PROFILE_DEFAULTS,
  PROFILE_IDS,
  PROTOCOL_VERSION
} from '../../contract/src/index.js';
import { decodeFrame, encodeFrame, type HelloFrame } from '../../protocol/src/index.js';
import { ReceiverController } from './receiver/receiver_controller.js';
import { SenderController } from './sender/sender_controller.js';

export const MVP_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface SenderHandshakeInput {
  sessionId: number;
  fileNameUtf8: Uint8Array;
  fileSizeBytes: bigint;
  fileCrc32c: number;
  profileId: number;
}

export interface HandshakeDiagnostics {
  sessionId: number | null;
  currentTurnOwner: 'sender' | 'receiver';
  result: 'pending' | 'accepted' | 'rejected';
  reason: string | null;
}

export interface ReceiverHandshakeOptions {
  supportedProfiles: readonly number[];
  memoryBudgetBytes: number;
}

function toReason(code: number): string {
  switch (code) {
    case 0x00:
      return 'accepted';
    case HELLO_REJECT_CODES.UNSUPPORTED_PROFILE:
      return 'unsupported profile';
    case HELLO_REJECT_CODES.FILE_TOO_LARGE:
      return 'file exceeds MVP max size';
    case HELLO_REJECT_CODES.MEMORY_UNAVAILABLE:
      return 'receiver memory unavailable';
    case HELLO_REJECT_CODES.INVALID_METADATA:
      return 'invalid HELLO metadata';
    case HELLO_REJECT_CODES.BUSY:
      return 'receiver busy with accepted session';
    default:
      return `unknown reject code 0x${code.toString(16).padStart(2, '0')}`;
  }
}

export class LiveSenderHandshake {
  private readonly controller = new SenderController();
  private result: HandshakeDiagnostics['result'] = 'pending';
  private reason: string | null = null;

  emitHello(input: SenderHandshakeInput): Uint8Array {
    const defaults = PROFILE_DEFAULTS[input.profileId as keyof typeof PROFILE_DEFAULTS];
    if (!defaults) {
      throw new Error(`unsupported profile ID for sender HELLO: ${input.profileId}`);
    }

    if (input.fileSizeBytes < 1n) {
      throw new Error('file_size_bytes must be at least 1 for MVP live handshake');
    }

    const payloadBytesPerFrame = defaults.payloadBytesPerFrame;
    const totalDataFrames = Number((input.fileSizeBytes + BigInt(payloadBytesPerFrame) - 1n) / BigInt(payloadBytesPerFrame));

    this.controller.dispatch({ type: 'START', sessionId: input.sessionId });
    const helloBytes = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO,
      flags: FLAGS_MVP_DEFAULT,
      profileId: input.profileId,
      sessionId: input.sessionId,
      fileNameUtf8: input.fileNameUtf8,
      fileSizeBytes: input.fileSizeBytes,
      totalDataFrames,
      payloadBytesPerFrame,
      framesPerBurst: defaults.framesPerBurst,
      fileCrc32c: input.fileCrc32c
    });
    this.controller.dispatch({ type: 'HELLO_SENT' });
    this.result = 'pending';
    this.reason = null;
    return helloBytes;
  }

  acceptHelloAck(ackBytes: Uint8Array): HandshakeDiagnostics {
    const ack = decodeFrame(ackBytes, { expectedVersion: PROTOCOL_VERSION, expectedTurnOwner: 'receiver' });
    if (ack.frameType !== FRAME_TYPES.HELLO_ACK) {
      throw new Error(`expected HELLO_ACK but received frame type 0x${ack.frameType.toString(16).padStart(2, '0')}`);
    }

    const accepted = ack.acceptCode === 0x00;
    this.controller.dispatch({ type: 'HELLO_ACK', sessionId: ack.sessionId, accepted });
    this.result = accepted ? 'accepted' : 'rejected';
    this.reason = accepted ? null : toReason(ack.acceptCode);
    return this.diagnostics();
  }

  diagnostics(): HandshakeDiagnostics {
    const snapshot = this.controller.snapshot();
    return {
      sessionId: snapshot.sessionId,
      currentTurnOwner: snapshot.expectedTurn,
      result: this.result,
      reason: this.reason
    };
  }
}

export class LiveReceiverHandshake {
  private readonly controller = new ReceiverController();
  private readonly options: ReceiverHandshakeOptions;
  private lockedSessionId: number | null = null;
  private result: HandshakeDiagnostics['result'] = 'pending';
  private reason: string | null = null;

  constructor(options: Partial<ReceiverHandshakeOptions> = {}) {
    this.options = {
      supportedProfiles: options.supportedProfiles ?? [PROFILE_IDS.SAFE],
      memoryBudgetBytes: options.memoryBudgetBytes ?? MVP_MAX_FILE_SIZE_BYTES
    };
  }

  handleHello(helloBytes: Uint8Array): { helloAckBytes: Uint8Array; diagnostics: HandshakeDiagnostics } {
    const decoded = decodeFrame(helloBytes, { expectedVersion: PROTOCOL_VERSION, expectedTurnOwner: 'sender' });
    if (decoded.frameType !== FRAME_TYPES.HELLO) {
      throw new Error(`expected HELLO but received frame type 0x${decoded.frameType.toString(16).padStart(2, '0')}`);
    }

    const hello = decoded as HelloFrame;
    const validation = this.validateHello(hello);

    if (validation.acceptCode === 0x00 && this.lockedSessionId === null) {
      this.lockedSessionId = hello.sessionId;
      this.controller.dispatch({ type: 'HELLO', sessionId: hello.sessionId, valid: true });
      this.result = 'accepted';
      this.reason = null;
    } else {
      this.result = 'rejected';
      this.reason = toReason(validation.acceptCode);
      if (this.controller.snapshot().state === 'LISTEN') {
        this.controller.dispatch({ type: 'HELLO', sessionId: hello.sessionId, valid: false });
      }
    }

    const helloAckBytes = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO_ACK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: hello.profileId,
      sessionId: hello.sessionId,
      acceptCode: validation.acceptCode,
      acceptedPayloadBytesPerFrame: hello.payloadBytesPerFrame,
      acceptedFramesPerBurst: hello.framesPerBurst
    });

    return {
      helloAckBytes,
      diagnostics: this.diagnostics()
    };
  }

  diagnostics(): HandshakeDiagnostics {
    const snapshot = this.controller.snapshot();
    return {
      sessionId: this.lockedSessionId ?? snapshot.sessionId,
      currentTurnOwner: snapshot.expectedTurn,
      result: this.result,
      reason: this.reason
    };
  }

  private validateHello(hello: HelloFrame): { acceptCode: number } {
    if (this.lockedSessionId !== null && hello.sessionId !== this.lockedSessionId) {
      return { acceptCode: HELLO_REJECT_CODES.BUSY };
    }
    if (!this.options.supportedProfiles.includes(hello.profileId)) {
      return { acceptCode: HELLO_REJECT_CODES.UNSUPPORTED_PROFILE };
    }

    const fileSize = Number(hello.fileSizeBytes);
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      return { acceptCode: HELLO_REJECT_CODES.INVALID_METADATA };
    }
    if (fileSize > MVP_MAX_FILE_SIZE_BYTES) {
      return { acceptCode: HELLO_REJECT_CODES.FILE_TOO_LARGE };
    }
    if (fileSize > this.options.memoryBudgetBytes) {
      return { acceptCode: HELLO_REJECT_CODES.MEMORY_UNAVAILABLE };
    }

    if (hello.totalDataFrames < 1 || hello.payloadBytesPerFrame < 1 || hello.framesPerBurst < 1) {
      return { acceptCode: HELLO_REJECT_CODES.INVALID_METADATA };
    }

    const computedFrames = Math.ceil(fileSize / hello.payloadBytesPerFrame);
    if (computedFrames !== hello.totalDataFrames) {
      return { acceptCode: HELLO_REJECT_CODES.INVALID_METADATA };
    }

    return { acceptCode: 0x00 };
  }
}
