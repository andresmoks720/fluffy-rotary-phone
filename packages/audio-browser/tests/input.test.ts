import { describe, expect, it, vi } from 'vitest';

import { requestMicStream } from '../src/index.js';

describe('requestMicStream', () => {
  it('requests media with required constraints', async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi.fn(async () => stream);

    const result = await requestMicStream({ mediaDevices: { getUserMedia } });

    expect(result).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
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
