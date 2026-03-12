export interface AudioGraphRuntime {
  readonly source: MediaStreamAudioSourceNode;
  readonly rxAnalyser: AnalyserNode;
  readonly txGain: GainNode;
  readonly outputGain: GainNode;
  readonly testToneFrequencyHz: number | null;
  startTestTone(frequencyHz?: number): void;
  stopTestTone(): void;
  dispose(): void;
}

export function createAudioGraphRuntime(ctx: AudioContext, stream: MediaStream): AudioGraphRuntime {
  const source = ctx.createMediaStreamSource(stream);
  const rxAnalyser = ctx.createAnalyser();
  rxAnalyser.fftSize = 2048;

  const txGain = ctx.createGain();
  txGain.gain.value = 0;

  const outputGain = ctx.createGain();
  outputGain.gain.value = 1;

  // RX sample path: microphone -> analyser.
  source.connect(rxAnalyser);

  // TX/playback path skeleton: txGain -> outputGain -> destination.
  txGain.connect(outputGain);
  outputGain.connect(ctx.destination);

  let testTone: OscillatorNode | null = null;
  let testToneFrequencyHz: number | null = null;

  function stopTestTone(): void {
    if (!testTone) {
      return;
    }

    testTone.stop();
    testTone.disconnect();
    testTone = null;
    testToneFrequencyHz = null;
  }

  function startTestTone(frequencyHz = 1000): void {
    stopTestTone();

    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequencyHz;
    oscillator.connect(txGain);
    oscillator.start();

    testTone = oscillator;
    testToneFrequencyHz = frequencyHz;
  }

  return {
    source,
    rxAnalyser,
    txGain,
    outputGain,
    get testToneFrequencyHz() {
      return testToneFrequencyHz;
    },
    startTestTone,
    stopTestTone,
    dispose() {
      stopTestTone();
      source.disconnect();
      rxAnalyser.disconnect();
      txGain.disconnect();
      outputGain.disconnect();
    }
  };
}
