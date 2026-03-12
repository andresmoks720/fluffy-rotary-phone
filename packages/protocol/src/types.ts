export type Frame =
  | HelloFrame
  | HelloAckFrame
  | DataFrame
  | BurstAckFrame
  | EndFrame
  | FinalOkFrame
  | FinalBadFrame
  | CancelFrame;

export interface BaseFrame {
  version: number;
  frameType: number;
  flags: number;
  profileId: number;
  sessionId: number;
}

export interface HelloFrame extends BaseFrame {
  frameType: 0x01;
  fileSizeBytes: bigint;
  totalDataFrames: number;
  payloadBytesPerFrame: number;
  framesPerBurst: number;
  fileCrc32c: number;
  fileNameUtf8: Uint8Array;
}

export interface HelloAckFrame extends BaseFrame {
  frameType: 0x02;
  acceptCode: number;
  acceptedPayloadBytesPerFrame: number;
  acceptedFramesPerBurst: number;
}

export interface DataFrame extends BaseFrame {
  frameType: 0x03;
  burstId: number;
  slotIndex: number;
  payloadFileOffset: number;
  payload: Uint8Array;
}

export interface BurstAckFrame extends BaseFrame {
  frameType: 0x04;
  burstId: number;
  slotCount: number;
  ackBitmap: number;
}

export interface EndFrame extends BaseFrame {
  frameType: 0x05;
  fileSizeBytes: bigint;
  totalDataFrames: number;
  fileCrc32c: number;
}

export interface FinalOkFrame extends BaseFrame {
  frameType: 0x06;
  observedFileCrc32c: number;
}

export interface FinalBadFrame extends BaseFrame {
  frameType: 0x07;
  reasonCode: number;
  observedFileCrc32c: number;
}

export interface CancelFrame extends BaseFrame {
  frameType: 0x08;
  reasonCode: number;
}

export interface DecodeOptions {
  expectedVersion?: number;
  expectedSessionId?: number;
  expectedProfileId?: number;
  expectedTurnOwner?: TurnOwner;
}

export type TurnOwner = 'sender' | 'receiver';
