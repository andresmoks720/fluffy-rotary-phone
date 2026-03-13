class RxStreamProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      this.port.postMessage({ peak: 0, rms: 0, samples: new Float32Array(0) });
      return true;
    }

    const firstChannel = input[0];
    const secondChannel = input[1] ?? firstChannel;
    const sampleCount = firstChannel.length;
    const mono = new Float32Array(sampleCount);
    let sumSquares = 0;
    let peak = 0;

    for (let i = 0; i < sampleCount; i += 1) {
      const left = firstChannel[i] ?? 0;
      const right = secondChannel[i] ?? left;
      const mixed = input.length > 1 ? (left + right) * 0.5 : left;
      mono[i] = mixed;
      const abs = Math.abs(mixed);
      if (abs > peak) peak = abs;
      sumSquares += mixed * mixed;
    }

    const rms = sampleCount === 0 ? 0 : Math.sqrt(sumSquares / sampleCount);
    this.port.postMessage({ peak, rms, samples: mono });
    return true;
  }
}

registerProcessor('rx-stream-processor', RxStreamProcessor);
