class MeterProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      let peak = 0;
      for (let i = 0; i < channel.length; i += 1) {
        const abs = Math.abs(channel[i]);
        if (abs > peak) peak = abs;
      }
      this.port.postMessage({ peak });
    }
    return true;
  }
}

registerProcessor('meter-processor', MeterProcessor);
