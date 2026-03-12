import { FRAME_TYPES } from './frame_types.js';
import { PROFILE_IDS } from './profile_ids.js';

export const PROTOCOL_VERSION = 0x01;
export const FLAGS_MVP_DEFAULT = 0x00;

export const SESSION_ID_BYTES = 4;
export const COMMON_FRAME_PREFIX_BYTES = 8;

export const TIMEOUTS_MS = {
  HELLO_ACK: 3000,
  BURST_ACK: 3000,
  FINAL_RESULT: 3000
} as const;

export const RETRY_LIMITS = {
  HELLO: 5,
  PER_BURST: 8,
  END_FINAL_CONFIRMATION: 5
} as const;

export const PROFILE_DEFAULTS = {
  [PROFILE_IDS.SAFE]: {
    payloadBytesPerFrame: 512,
    framesPerBurst: 8
  },
  [PROFILE_IDS.NORMAL]: {
    payloadBytesPerFrame: 768,
    framesPerBurst: 16
  },
  [PROFILE_IDS.FAST_TEST]: {
    payloadBytesPerFrame: 1024,
    framesPerBurst: 16
  }
} as const;

export const TURN_OWNER_FRAME_TYPES = {
  sender: [FRAME_TYPES.HELLO, FRAME_TYPES.DATA, FRAME_TYPES.END, FRAME_TYPES.CANCEL],
  receiver: [
    FRAME_TYPES.HELLO_ACK,
    FRAME_TYPES.BURST_ACK,
    FRAME_TYPES.FINAL_OK,
    FRAME_TYPES.FINAL_BAD,
    FRAME_TYPES.CANCEL
  ]
} as const;
