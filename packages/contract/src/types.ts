import type { FrameTypeCode } from './frame_types.js';
import type { ProfileIdCode } from './profile_ids.js';

export interface CommonFramePrefix {
  version: number;
  frameType: FrameTypeCode;
  flags: number;
  profileId: ProfileIdCode;
  sessionId: number;
}
