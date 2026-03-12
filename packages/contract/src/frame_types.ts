export const FRAME_TYPES = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  DATA: 0x03,
  BURST_ACK: 0x04,
  END: 0x05,
  FINAL_OK: 0x06,
  FINAL_BAD: 0x07,
  CANCEL: 0x08
} as const;

export type FrameTypeName = keyof typeof FRAME_TYPES;
export type FrameTypeCode = (typeof FRAME_TYPES)[FrameTypeName];
