export const PROFILE_IDS = {
  SAFE: 0x01,
  NORMAL: 0x02,
  FAST_TEST: 0x03
} as const;

export type ProfileIdName = keyof typeof PROFILE_IDS;
export type ProfileIdCode = (typeof PROFILE_IDS)[ProfileIdName];
