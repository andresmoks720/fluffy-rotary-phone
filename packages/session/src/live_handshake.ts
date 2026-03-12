import {
  FLAGS_MVP_DEFAULT,
  FRAME_TYPES,
  HELLO_REJECT_CODES,
  PROFILE_DEFAULTS,
  PROFILE_IDS,
  PROTOCOL_VERSION,
  type ProfileIdCode
} from '../../contract/src/index.js';
import { decodeFrame, encodeFrame, type HelloAckFrame, type HelloFrame } from '../../protocol/src/index.js';

import { ReceiverController } from './receiver/receiver_controller.js';
import { SenderController } from './sender/sender_controller.js';

const MAX_MVP_FILE_SIZE_BYTES = 10 * 1024 * 1024;

type HandshakeResult =
  | { status: 'idle' | 'pending' | 'accepted' }
  | { status: 'rejected'; reason: string; code: number };

export interface HandshakeDiagnostics {
  sessionId: number | null;
  turnOwner: 'sender' | 'receiver';
  handshake: HandshakeResult;
}

export interface LivePhyTransport {
  send(frameBytes: Uint8Array): void;
}

export interface SenderHandshakeStart {
  fileName: string;
  fileSizeBytes: number;
  profileId: ProfileIdCode;
  fileCrc32c?: number;
  sessionId?: number;
}

export class SenderLiveHandshake {
  private readonly controller = new SenderController();
  private diagnostics: HandshakeDiagnostics = {
    sessionId: null,
    turnOwner: 'sender',
    handshake: { status: 'idle' }
  };

  constructor(private readonly transport: LivePhyTransport) {}

  start(start: SenderHandshakeStart): HandshakeDiagnostics {
    const sessionId = start.sessionId ?? randomSessionId();
    const profileDefaults = PROFILE_DEFAULTS[start.profileId];
    if (!profileDefaults) {
      throw new Error(`Unknown profile: ${start.profileId}`);
    }

    const totalDataFrames = Math.ceil(start.fileSizeBytes / profileDefaults.payloadBytesPerFrame);
    const hello: HelloFrame = {
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO,
      flags: FLAGS_MVP_DEFAULT,
      profileId: start.profileId,
      sessionId,
      fileSizeBytes: BigInt(start.fileSizeBytes),
      totalDataFrames,
      payloadBytesPerFrame: profileDefaults.payloadBytesPerFrame,
      framesPerBurst: profileDefaults.framesPerBurst,
      fileCrc32c: start.fileCrc32c ?? 0,
      fileNameUtf8: new TextEncoder().encode(start.fileName)
    };

    this.controller.dispatch({ type: 'START', sessionId });
    this.controller.dispatch({ type: 'HELLO_SENT' });
    const sender = this.controller.snapshot();
    this.diagnostics = {
      sessionId,
      turnOwner: sender.expectedTurn,
      handshake: { status: 'pending' }
    };

    this.transport.send(encodeFrame(hello));
    return this.snapshot();
  }

  onFrame(frameBytes: Uint8Array): HandshakeDiagnostics {
    const decoded = decodeFrame(frameBytes, { expectedTurnOwner: 'receiver' });
    if (decoded.frameType !== FRAME_TYPES.HELLO_ACK) {
      throw new Error(`Unexpected frame type for sender handshake: ${decoded.frameType}`);
    }

    const helloAck = decoded as HelloAckFrame;
    this.controller.dispatch({
      type: 'HELLO_ACK',
      sessionId: helloAck.sessionId,
      accepted: helloAck.acceptCode === 0
    });

    const sender = this.controller.snapshot();
    this.diagnostics = {
      sessionId: sender.sessionId,
      turnOwner: sender.expectedTurn,
      handshake:
        helloAck.acceptCode === 0
          ? { status: 'accepted' }
          : {
              status: 'rejected',
              reason: helloRejectCodeToReason(helloAck.acceptCode),
              code: helloAck.acceptCode
            }
    };

    return this.snapshot();
  }

  snapshot(): HandshakeDiagnostics {
    return {
      sessionId: this.diagnostics.sessionId,
      turnOwner: this.diagnostics.turnOwner,
      handshake: this.diagnostics.handshake
    };
  }
}

export interface ReceiverHandshakeOptions {
  readonly transport: LivePhyTransport;
  readonly supportedProfiles: readonly ProfileIdCode[];
  readonly canAllocate: (fileSizeBytes: bigint) => boolean;
}

export class ReceiverLiveHandshake {
  private readonly controller = new ReceiverController();
  private readonly supportedProfiles: ReadonlySet<number>;
  private lockedSessionId: number | null = null;
  private diagnostics: HandshakeDiagnostics = {
    sessionId: null,
    turnOwner: 'sender',
    handshake: { status: 'idle' }
  };

  constructor(private readonly options: ReceiverHandshakeOptions) {
    this.supportedProfiles = new Set(options.supportedProfiles);
  }

  onFrame(frameBytes: Uint8Array): HandshakeDiagnostics {
    const decoded = decodeFrame(frameBytes, { expectedTurnOwner: 'sender' });
    if (decoded.frameType !== FRAME_TYPES.HELLO) {
      throw new Error(`Unexpected frame type for receiver handshake: ${decoded.frameType}`);
    }

    const hello = decoded as HelloFrame;
    const rejectionCode = this.validateHello(hello);
    const accepted = rejectionCode === 0;

    const receiverBefore = this.controller.snapshot();
    const canConsumeHello = receiverBefore.state === 'LISTEN';
    if (canConsumeHello) {
      this.controller.dispatch({ type: 'HELLO', sessionId: hello.sessionId, valid: accepted });
    }

    if (accepted) {
      this.lockedSessionId = hello.sessionId;
    }

    const helloAck: HelloAckFrame = {
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.HELLO_ACK,
      flags: FLAGS_MVP_DEFAULT,
      profileId: hello.profileId,
      sessionId: hello.sessionId,
      acceptCode: rejectionCode,
      acceptedPayloadBytesPerFrame: accepted ? hello.payloadBytesPerFrame : 0,
      acceptedFramesPerBurst: accepted ? hello.framesPerBurst : 0
    };

    this.options.transport.send(encodeFrame(helloAck));

    const receiver = this.controller.snapshot();
    this.diagnostics = {
      sessionId: this.lockedSessionId,
      turnOwner: receiver.expectedTurn,
      handshake: accepted
        ? { status: 'accepted' }
        : { status: 'rejected', reason: helloRejectCodeToReason(rejectionCode), code: rejectionCode }
    };

    return this.snapshot();
  }

  snapshot(): HandshakeDiagnostics {
    return {
      sessionId: this.diagnostics.sessionId,
      turnOwner: this.diagnostics.turnOwner,
      handshake: this.diagnostics.handshake
    };
  }

  private validateHello(hello: HelloFrame): number {
    if (this.lockedSessionId !== null && this.lockedSessionId !== hello.sessionId) {
      return HELLO_REJECT_CODES.BUSY;
    }

    if (!this.supportedProfiles.has(hello.profileId)) {
      return HELLO_REJECT_CODES.UNSUPPORTED_PROFILE;
    }

    if (hello.fileSizeBytes > BigInt(MAX_MVP_FILE_SIZE_BYTES)) {
      return HELLO_REJECT_CODES.FILE_TOO_LARGE;
    }

    if (!this.options.canAllocate(hello.fileSizeBytes)) {
      return HELLO_REJECT_CODES.MEMORY_UNAVAILABLE;
    }

    if (hello.totalDataFrames === 0 || hello.payloadBytesPerFrame === 0 || hello.framesPerBurst === 0) {
      return HELLO_REJECT_CODES.INVALID_METADATA;
    }

    return 0;
  }
}

function helloRejectCodeToReason(code: number): string {
  if (code === 0) return 'accepted';
  if (code === HELLO_REJECT_CODES.UNSUPPORTED_PROFILE) return 'unsupported_profile';
  if (code === HELLO_REJECT_CODES.FILE_TOO_LARGE) return 'file_too_large';
  if (code === HELLO_REJECT_CODES.MEMORY_UNAVAILABLE) return 'memory_unavailable';
  if (code === HELLO_REJECT_CODES.INVALID_METADATA) return 'invalid_metadata';
  if (code === HELLO_REJECT_CODES.BUSY) return 'busy';
  return 'unknown_reject_code';
}

function randomSessionId(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

export const LIVE_HANDSHAKE_DEFAULT_PROFILES = [PROFILE_IDS.SAFE] as const;
