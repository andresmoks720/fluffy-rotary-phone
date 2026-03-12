import {
  appendWaveformDebugEntry,
  captureAnalyserTimeDomain,
  collectAudioRuntimeInfo,
  createAudioGraphRuntime,
  readInputTrackDiagnostics,
  registerWorklet,
  requestMicStream,
  sampleAnalyserLevels,
  summarizeAudioLevels,
  type AudioLevelSummary,
  type AudioGraphRuntime,
  type WaveformDebugEntry
} from '../../../packages/audio-browser/src/index.js';
import {
  INITIAL_LIVE_PATH_FRAME_METRICS,
  classifyDecodeFailure,
  decodeFrame,
  isValidFrameType,
  recordFrameDecodeAttempt,
  type LivePathFrameMetrics
} from '../../../packages/protocol/src/index.js';

interface ReceiverRuntime {
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly graph: AudioGraphRuntime;
  readonly intervalId: number;
}

declare global {
  interface Window {
    __AUDIO_MODEM_DEV_LIVE_FRAME__?: Uint8Array;
  }
}

let receiverRuntime: ReceiverRuntime | null = null;
let lastCapture: {
  readonly samples: readonly number[];
  readonly levels: AudioLevelSummary;
} | null = null;
let waveformDebugBuffer: readonly WaveformDebugEntry[] = [];
let frameMetrics: LivePathFrameMetrics = INITIAL_LIVE_PATH_FRAME_METRICS;

function renderDiagnostics(el: HTMLElement, data: unknown): void {
  el.textContent = JSON.stringify(data, null, 2);
}

function stopReceiverRuntime(): void {
  if (!receiverRuntime) return;

  window.clearInterval(receiverRuntime.intervalId);
  receiverRuntime.graph.dispose();
  receiverRuntime.stream.getTracks().forEach((track) => track.stop());
  void receiverRuntime.ctx.close();
  receiverRuntime = null;
  lastCapture = null;
  waveformDebugBuffer = [];
}

function captureRxSnapshot(diagEl: HTMLElement): void {
  if (!receiverRuntime) {
    renderDiagnostics(diagEl, { error: 'Start receiver runtime before capturing RX samples.' });
    return;
  }

  const samples = captureAnalyserTimeDomain(receiverRuntime.graph.rxAnalyser, 32);
  lastCapture = {
    samples: Array.from(samples),
    levels: summarizeAudioLevels(samples)
  };
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.replace(/\s+/g, '').toLowerCase();
  if (normalized.length === 0) {
    throw new Error('No frame bytes available for decode.');
  }
  if (normalized.length % 2 !== 0) {
    throw new Error('Hex payload length must be even.');
  }

  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    const value = Number.parseInt(normalized.slice(i, i + 2), 16);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid hex byte at offset ${i}.`);
    }
    out[i / 2] = value;
  }
  return out;
}

function decodeSingleDevFrame(root: HTMLElement, diagEl: HTMLElement): void {
  const hexInput = root.querySelector<HTMLInputElement>('#receiver-dev-frame-hex');

  try {
    const encoded = window.__AUDIO_MODEM_DEV_LIVE_FRAME__ ?? hexToBytes(hexInput?.value ?? '');
    const frameType = encoded[1];
    if (frameType === undefined || !isValidFrameType(frameType)) {
      const failure = 'Invalid frame type in received bytes.';
      frameMetrics = recordFrameDecodeAttempt(frameMetrics, {
        ok: false,
        reason: 'invalid_frame_type',
        details: failure
      });
      renderDiagnostics(diagEl, { frameMetrics, lastFailureReason: failure });
      return;
    }

    const decoded = decodeFrame(encoded);
    frameMetrics = recordFrameDecodeAttempt(frameMetrics, { ok: true });
    renderDiagnostics(diagEl, {
      frameMetrics,
      decodedFrame: decoded,
      message: 'Developer frame decode success.'
    });
  } catch (error) {
    const reason = classifyDecodeFailure(error);
    const details = `Frame decode failed: ${String(error)}`;
    frameMetrics = recordFrameDecodeAttempt(frameMetrics, {
      ok: false,
      reason,
      details
    });
    renderDiagnostics(diagEl, {
      frameMetrics,
      lastFailureReason: details
    });
  }
}

async function startReceiver(stateEl: HTMLElement, diagEl: HTMLElement): Promise<void> {
  stopReceiverRuntime();
  stateEl.textContent = 'starting';

  try {
    const stream = await requestMicStream(window.navigator);
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('No audio track available');

    const ctx = new AudioContext();
    await registerWorklet(ctx, '/meter_processor.js');

    const graph = createAudioGraphRuntime(ctx, stream);
    const runtimeInfo = collectAudioRuntimeInfo(ctx);
    const inputInfo = readInputTrackDiagnostics(track);
    lastCapture = null;
    waveformDebugBuffer = [];

    let levels: AudioLevelSummary = { rms: 0, peakAbs: 0, clipping: false };
    const intervalId = window.setInterval(() => {
      levels = sampleAnalyserLevels(graph.rxAnalyser);
      waveformDebugBuffer = appendWaveformDebugEntry(
        waveformDebugBuffer,
        { timestampMs: Date.now(), levels },
        16
      );

      renderDiagnostics(diagEl, {
        runtime: runtimeInfo,
        input: inputInfo,
        levels,
        graph: {
          rxPath: 'mic -> analyser',
          txPath: 'txGain -> outputGain -> destination'
        },
        rxCapture: lastCapture,
        waveformDebug: {
          entryCount: waveformDebugBuffer.length,
          recent: waveformDebugBuffer
        },
        frameMetrics,
        message: 'Receiver listening shell initialized; meter active.'
      });
    }, 200);

    receiverRuntime = { stream, ctx, graph, intervalId };
    stateEl.textContent = 'listen';
  } catch (error) {
    stateEl.textContent = 'failed';
    renderDiagnostics(diagEl, { error: String(error) });
  }
}

function mountReceiverShell(root: HTMLElement): void {
  const showDevControls = import.meta.env.DEV;
  root.innerHTML = `
    <main>
      <h1>Audio Modem Receiver</h1>
      <p>State: <strong id="receiver-state">idle</strong></p>

      <section>
        <button id="receiver-start" type="button">Start</button>
        <button id="receiver-cancel" type="button">Cancel</button>
        <button id="receiver-capture" type="button">Capture RX snapshot</button>
      </section>

      ${showDevControls ? '<section><h2>Developer controls</h2><label for="receiver-dev-frame-hex">Frame hex</label><input id="receiver-dev-frame-hex" type="text" /><button id="receiver-decode-dev-frame" type="button">Decode one frame (dev)</button></section>' : ''}

      <section>
        <h2>Diagnostics</h2>
        <pre id="receiver-diag">Diagnostics pending runtime initialization.</pre>
      </section>
    </main>
  `;

  const stateEl = root.querySelector<HTMLElement>('#receiver-state');
  const diagEl = root.querySelector<HTMLElement>('#receiver-diag');
  const startBtn = root.querySelector<HTMLButtonElement>('#receiver-start');
  const cancelBtn = root.querySelector<HTMLButtonElement>('#receiver-cancel');
  const captureBtn = root.querySelector<HTMLButtonElement>('#receiver-capture');
  const decodeDevFrameBtn = root.querySelector<HTMLButtonElement>('#receiver-decode-dev-frame');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !captureBtn) {
    throw new Error('Missing receiver shell elements');
  }

  startBtn.addEventListener('click', () => {
    void startReceiver(stateEl, diagEl);
  });

  cancelBtn.addEventListener('click', () => {
    stopReceiverRuntime();
    stateEl.textContent = 'cancelled';
    renderDiagnostics(diagEl, { message: 'Receiver cancelled by user.' });
  });

  captureBtn.addEventListener('click', () => {
    captureRxSnapshot(diagEl);
  });

  decodeDevFrameBtn?.addEventListener('click', () => {
    decodeSingleDevFrame(root, diagEl);
  });
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');

mountReceiverShell(root);
