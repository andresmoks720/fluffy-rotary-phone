export interface AudioGraphRuntime {
  readonly source: MediaStreamAudioSourceNode;
  readonly rxChannelPolicy: 'downmix_to_mono';
  readonly rxAnalyser: AnalyserNode;
  readonly rxDownmixSplitter: ChannelSplitterNode;
  readonly rxDownmixLeftGain: GainNode;
  readonly rxDownmixRightGain: GainNode;
  readonly rxDownmixMonoBus: GainNode;
  readonly rxStreamTapNode: AudioWorkletNode | null;
  readonly txGain: GainNode;
  readonly outputGain: GainNode;
  readonly testToneFrequencyHz: number | null;
  readonly testToneStartedAtMs: number | null;
  startTestTone(frequencyHz?: number): void;
  stopTestTone(): void;
  dispose(): void;
}

export interface AudioGraphRuntimeOptions {
  readonly rxWorkletProcessorName?: string;
}

export function createAudioGraphRuntime(
  ctx: AudioContext,
  stream: MediaStream,
  options: AudioGraphRuntimeOptions = {}
): AudioGraphRuntime {
  const source = ctx.createMediaStreamSource(stream);
  const rxDownmixSplitter = ctx.createChannelSplitter(2);
  const rxDownmixLeftGain = ctx.createGain();
  const rxDownmixRightGain = ctx.createGain();
  const rxDownmixMonoBus = ctx.createGain();
  const rxAnalyser = ctx.createAnalyser();
  rxAnalyser.fftSize = 32768;

  rxDownmixLeftGain.gain.value = 0.5;
  rxDownmixRightGain.gain.value = 0.5;
  rxDownmixMonoBus.gain.value = 1;

  const txGain = ctx.createGain();
  txGain.gain.value = 1;

  const outputGain = ctx.createGain();
  outputGain.gain.value = 1;

  source.connect(rxDownmixSplitter);
  rxDownmixSplitter.connect(rxDownmixLeftGain, 0);
  rxDownmixSplitter.connect(rxDownmixRightGain, 1);
  rxDownmixLeftGain.connect(rxDownmixMonoBus);
  rxDownmixRightGain.connect(rxDownmixMonoBus);
  rxDownmixMonoBus.connect(rxAnalyser);

  let rxStreamTapNode: AudioWorkletNode | null = null;
  if (options.rxWorkletProcessorName && typeof AudioWorkletNode !== 'undefined') {
    rxStreamTapNode = new AudioWorkletNode(ctx, options.rxWorkletProcessorName, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    });
    rxDownmixMonoBus.connect(rxStreamTapNode);
  }

  txGain.connect(outputGain);
  outputGain.connect(ctx.destination);

  let testTone: OscillatorNode | null = null;
  let testToneFrequencyHz: number | null = null;
  let testToneStartedAtMs: number | null = null;

  function stopTestTone(): void {
    if (!testTone) return;
    testTone.stop();
    testTone.disconnect();
    testTone = null;
    testToneFrequencyHz = null;
    testToneStartedAtMs = null;
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
    testToneStartedAtMs = Date.now();
  }

  return {
    source,
    rxChannelPolicy: 'downmix_to_mono',
    rxAnalyser,
    rxDownmixSplitter,
    rxDownmixLeftGain,
    rxDownmixRightGain,
    rxDownmixMonoBus,
    rxStreamTapNode,
    txGain,
    outputGain,
    get testToneFrequencyHz() {
      return testToneFrequencyHz;
    },
    get testToneStartedAtMs() {
      return testToneStartedAtMs;
    },
    startTestTone,
    stopTestTone,
    dispose() {
      stopTestTone();
      source.disconnect();
      rxDownmixSplitter.disconnect();
      rxDownmixLeftGain.disconnect();
      rxDownmixRightGain.disconnect();
      rxDownmixMonoBus.disconnect();
      rxAnalyser.disconnect();
      rxStreamTapNode?.disconnect();
      txGain.disconnect();
      outputGain.disconnect();
    }
  };
}
