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
    const splitter = makeFakeNode();
    const monoLeft = { ...makeFakeNode(), gain: { value: 0 } };
    const monoRight = { ...makeFakeNode(), gain: { value: 0 } };
    const monoBus = { ...makeFakeNode(), gain: { value: 0 } };
    const analyser = { ...makeFakeNode(), fftSize: 0 };
    const rxSilentSink = { ...makeFakeNode(), gain: { value: 1 } };
    const txGain = { ...makeFakeNode(), gain: { value: 0 } };
    const outputGain = { ...makeFakeNode(), gain: { value: 0 } };
    const oscillator = { ...makeFakeNode(), start: vi.fn(), stop: vi.fn(), frequency: { value: 0 }, type: 'triangle' };
    const destination = {};

    const ctx = {
      createMediaStreamSource: vi.fn(() => source),
      createChannelSplitter: vi.fn(() => splitter),
      createAnalyser: vi.fn(() => analyser),
      createGain: vi.fn()
        .mockReturnValueOnce(monoLeft)
        .mockReturnValueOnce(monoRight)
        .mockReturnValueOnce(monoBus)
        .mockReturnValueOnce(rxSilentSink)
        .mockReturnValueOnce(txGain)
        .mockReturnValueOnce(outputGain),
      createOscillator: vi.fn(() => oscillator),
      destination
    } as unknown as AudioContext;

    const runtime = createAudioGraphRuntime(ctx, {} as MediaStream);

    expect(ctx.createMediaStreamSource).toHaveBeenCalled();
    expect(analyser.fftSize).toBe(32768);
    expect(source.connect).toHaveBeenCalledWith(splitter);
    expect(splitter.connect).toHaveBeenCalledWith(monoLeft, 0);
    expect(splitter.connect).toHaveBeenCalledWith(monoRight, 1);
    expect(monoLeft.connect).toHaveBeenCalledWith(monoBus);
    expect(monoRight.connect).toHaveBeenCalledWith(monoBus);
    expect(monoBus.connect).toHaveBeenCalledWith(analyser);
    expect(monoBus.connect).toHaveBeenCalledWith(rxSilentSink);
    expect(rxSilentSink.connect).toHaveBeenCalledWith(destination);
    expect(runtime.rxChannelPolicy).toBe('downmix_to_mono');
    expect(monoLeft.gain.value).toBe(0.5);
    expect(monoRight.gain.value).toBe(0.5);
    expect(rxSilentSink.gain.value).toBe(0);
    expect(txGain.gain.value).toBe(1);
    expect(outputGain.gain.value).toBe(1);
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
    expect(splitter.disconnect).toHaveBeenCalled();
    expect(monoLeft.disconnect).toHaveBeenCalled();
    expect(monoRight.disconnect).toHaveBeenCalled();
    expect(monoBus.disconnect).toHaveBeenCalled();
    expect(rxSilentSink.disconnect).toHaveBeenCalled();
    expect(analyser.disconnect).toHaveBeenCalled();
    expect(txGain.disconnect).toHaveBeenCalled();
    expect(outputGain.disconnect).toHaveBeenCalled();
  });
});


describe('audio graph lifecycle resilience', () => {
  it('supports repeated start/cancel cycles without leaked tone state', () => {
    const source = makeFakeNode();
    const splitter = makeFakeNode();
    const monoLeft = { ...makeFakeNode(), gain: { value: 0 } };
    const monoRight = { ...makeFakeNode(), gain: { value: 0 } };
    const monoBus = { ...makeFakeNode(), gain: { value: 0 } };
    const analyser = { ...makeFakeNode(), fftSize: 0 };
    const rxSilentSink = { ...makeFakeNode(), gain: { value: 1 } };
    const txGain = { ...makeFakeNode(), gain: { value: 0 } };
    const outputGain = { ...makeFakeNode(), gain: { value: 0 } };

    const makeOsc = () => ({ ...makeFakeNode(), start: vi.fn(), stop: vi.fn(), frequency: { value: 0 }, type: 'sine' });
    const oscillators: ReturnType<typeof makeOsc>[] = [];

    const ctx = {
      createMediaStreamSource: vi.fn(() => source),
      createChannelSplitter: vi.fn(() => splitter),
      createAnalyser: vi.fn(() => analyser),
      createGain: vi.fn()
        .mockReturnValueOnce(monoLeft)
        .mockReturnValueOnce(monoRight)
        .mockReturnValueOnce(monoBus)
        .mockReturnValueOnce(rxSilentSink)
        .mockReturnValueOnce(txGain)
        .mockReturnValueOnce(outputGain),
      createOscillator: vi.fn(() => {
        const o = makeOsc();
        oscillators.push(o);
        return o;
      }),
      destination: {}
    } as unknown as AudioContext;

    const runtime = createAudioGraphRuntime(ctx, {} as MediaStream);
    for (let i = 0; i < 5; i += 1) {
      runtime.startTestTone(1000 + i);
      runtime.stopTestTone();
      expect(runtime.testToneFrequencyHz).toBeNull();
      expect(runtime.testToneStartedAtMs).toBeNull();
    }

    runtime.dispose();
    expect(oscillators.length).toBe(5);
    for (const osc of oscillators) {
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    }
  });
});
