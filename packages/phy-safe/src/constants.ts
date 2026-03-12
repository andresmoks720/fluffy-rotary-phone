export const SAFE_PHY_CONSTANTS = {
  profileId: 'safe',
  modulation: 'BPSK',
  carrierCount: 16,
  carrierSpacingHz: 125,
  symbolRateHz: 250,
  preambleDurationMs: 300,
  trainingDurationMs: 400,
  payloadBytesPerFrame: 512
} as const;

export const SAFE_PREAMBLE_SYMBOLS =
  (SAFE_PHY_CONSTANTS.preambleDurationMs * SAFE_PHY_CONSTANTS.symbolRateHz) / 1000;

export const SAFE_TRAINING_SYMBOLS =
  (SAFE_PHY_CONSTANTS.trainingDurationMs * SAFE_PHY_CONSTANTS.symbolRateHz) / 1000;
