import { describe, expect, it } from 'vitest';

import { requiredMicConstraints } from '../src/index.js';

describe('requiredMicConstraints', () => {
  it('requests deterministic mono/raw mic settings', () => {
    expect(requiredMicConstraints()).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
  });
});
