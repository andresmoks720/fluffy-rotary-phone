import { describe, expect, it, vi } from 'vitest';

import { createAudioGraphRuntime } from '../src/index.js';

function makeFakeNode() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn()
  };
}

describe('createAudioGraphRuntime', () => {
  it('builds rx and tx/playback paths', () => {
    const source = makeFakeNode();
    const analyser = { ...makeFakeNode(), fftSize: 0 };
    const txGain = { ...makeFakeNode(), gain: { value: 0 } };
    const outputGain = { ...makeFakeNode(), gain: { value: 0 } };
    const oscillator = { ...makeFakeNode(), start: vi.fn(), stop: vi.fn(), frequency: { value: 0 }, type: 'triangle' };
    const destination = {};

    const ctx = {
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      createGain: vi.fn()
        .mockReturnValueOnce(txGain)
        .mockReturnValueOnce(outputGain),
      createOscillator: vi.fn(() => oscillator),
      destination
    } as unknown as AudioContext;

    const runtime = createAudioGraphRuntime(ctx, {} as MediaStream);

    expect(ctx.createMediaStreamSource).toHaveBeenCalled();
    expect(analyser.fftSize).toBe(2048);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(txGain.connect).toHaveBeenCalledWith(outputGain);
    expect(outputGain.connect).toHaveBeenCalledWith(destination);

    runtime.startTestTone(1800);
    expect(ctx.createOscillator).toHaveBeenCalled();
    expect(oscillator.type).toBe('sine');
    expect(oscillator.frequency.value).toBe(1800);
    expect(oscillator.connect).toHaveBeenCalledWith(txGain);
    expect(oscillator.start).toHaveBeenCalled();
    expect(runtime.testToneFrequencyHz).toBe(1800);

    runtime.stopTestTone();
    expect(oscillator.stop).toHaveBeenCalled();
    expect(oscillator.disconnect).toHaveBeenCalled();
    expect(runtime.testToneFrequencyHz).toBeNull();

    runtime.dispose();
    expect(source.disconnect).toHaveBeenCalled();
    expect(analyser.disconnect).toHaveBeenCalled();
    expect(txGain.disconnect).toHaveBeenCalled();
    expect(outputGain.disconnect).toHaveBeenCalled();
  });
});
