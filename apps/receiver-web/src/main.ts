import {
  appendWaveformDebugEntry,
  captureAnalyserTimeDomain,
  collectAudioRuntimeInfo,
  createAudioGraphRuntime,
  readInputTrackDiagnostics,
  LinkTimingEstimator,
  registerWorklet,
  requestMicStream,
  sampleAnalyserLevels,
  summarizeAudioLevels,
  type AudioLevelSummary,
  type AudioGraphRuntime,
  type WaveformDebugEntry
} from '../../../packages/audio-browser/src/index.js';
import { PROFILE_IDS, PROTOCOL_VERSION } from '../../../packages/contract/src/index.js';
import {
  createLiveFrameDiagnosticsCounters,
  decodeSingleFrameForLiveHarness,
  readFrameDecodeSuccessRate,
  type LiveFrameDiagnosticsCounters
} from '../../../packages/protocol/src/index.js';

interface ReceiverRuntime {
  readonly timing: LinkTimingEstimator;
  lastRecordedToneStartMs: number | null;
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly graph: AudioGraphRuntime;
  readonly intervalId: number;
}

let receiverRuntime: ReceiverRuntime | null = null;
let lastCapture: {
  readonly samples: readonly number[];
  readonly levels: AudioLevelSummary;
} | null = null;
let waveformDebugBuffer: readonly WaveformDebugEntry[] = [];
const liveFrameDiagnostics: LiveFrameDiagnosticsCounters = createLiveFrameDiagnosticsCounters();
const LIVE_HARNESS_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-frame-hex';

function renderDiagnostics(el: HTMLElement, data: unknown): void {
  el.textContent = JSON.stringify(data, null, 2);
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('invalid frame hex length');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const value = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(value)) {
      throw new Error(`invalid frame hex byte at index ${i}`);
    }
    bytes[i] = value;
  }
  return bytes;
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

function decodeSingleHarnessFrame(diagEl: HTMLElement): void {
  const frameHex = window.localStorage.getItem(LIVE_HARNESS_STORAGE_KEY);
  if (!frameHex) {
    liveFrameDiagnostics.frameAttempts += 1;
    liveFrameDiagnostics.otherDecodeFailures += 1;
    liveFrameDiagnostics.lastFailureReason = 'No harness frame found in local storage. Send one from sender app first.';
    renderDiagnostics(diagEl, {
      liveFrame: {
        counters: liveFrameDiagnostics,
        decodeSuccessRate: readFrameDecodeSuccessRate(liveFrameDiagnostics)
      }
    });
    return;
  }

  try {
    const bytes = fromHex(frameHex);
    const result = decodeSingleFrameForLiveHarness(
      bytes,
      {
        expectedVersion: PROTOCOL_VERSION,
        expectedProfileId: PROFILE_IDS.SAFE
      },
      liveFrameDiagnostics
    );

    renderDiagnostics(diagEl, {
      liveFrame: {
        counters: liveFrameDiagnostics,
        decodeSuccessRate: readFrameDecodeSuccessRate(liveFrameDiagnostics),
        decodedFrame: result.frame,
        lastFailureReason: result.failureReason
      }
    });
  } catch (error) {
    liveFrameDiagnostics.frameAttempts += 1;
    liveFrameDiagnostics.otherDecodeFailures += 1;
    liveFrameDiagnostics.lastFailureReason = String(error);
    renderDiagnostics(diagEl, {
      liveFrame: {
        counters: liveFrameDiagnostics,
        decodeSuccessRate: readFrameDecodeSuccessRate(liveFrameDiagnostics)
      }
    });
  }
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
    const timing = new LinkTimingEstimator();
    lastCapture = null;
    waveformDebugBuffer = [];

    let levels: AudioLevelSummary = { rms: 0, peakAbs: 0, clipping: false };
    const intervalId = window.setInterval(() => {
      levels = sampleAnalyserLevels(graph.rxAnalyser);
      const toneFrequencyHz = graph.testToneFrequencyHz;
      const sampleTimestampMs = Date.now();
      if (graph.testToneStartedAtMs !== null && graph.testToneStartedAtMs !== receiverRuntime?.lastRecordedToneStartMs) {
        timing.recordTxToneStart(graph.testToneStartedAtMs);
        if (receiverRuntime) {
          receiverRuntime.lastRecordedToneStartMs = graph.testToneStartedAtMs;
        }
      }
      timing.recordRxSample(sampleTimestampMs, levels.rms, toneFrequencyHz !== null);
      const linkTiming = timing.snapshot();
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
        linkTiming,
        waveformDebug: {
          entryCount: waveformDebugBuffer.length,
          recent: waveformDebugBuffer
        },
        liveFrame: {
          counters: liveFrameDiagnostics,
          decodeSuccessRate: readFrameDecodeSuccessRate(liveFrameDiagnostics),
          lastFailureReason: liveFrameDiagnostics.lastFailureReason
        },
        message: 'Receiver listening shell initialized; meter active.'
      });
    }, 200);

    receiverRuntime = { stream, ctx, graph, intervalId, timing, lastRecordedToneStartMs: null };
    stateEl.textContent = 'listen';
  } catch (error) {
    stateEl.textContent = 'failed';
    renderDiagnostics(diagEl, { error: String(error) });
  }
}

function mountReceiverShell(root: HTMLElement): void {
  root.innerHTML = `
    <main>
      <h1>Audio Modem Receiver</h1>
      <p>State: <strong id="receiver-state">idle</strong></p>

      <section>
        <button id="receiver-start" type="button">Start</button>
        <button id="receiver-cancel" type="button">Cancel</button>
        <button id="receiver-capture" type="button">Capture RX snapshot</button>
        <button id="receiver-decode-frame" type="button">[dev] Decode one harness frame</button>
      </section>

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
  const decodeFrameBtn = root.querySelector<HTMLButtonElement>('#receiver-decode-frame');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !captureBtn || !decodeFrameBtn) {
    throw new Error('Missing receiver shell elements');
  }

  decodeFrameBtn.hidden = !window.location.hostname.includes('localhost') && window.location.hostname !== '127.0.0.1';

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

  decodeFrameBtn.addEventListener('click', () => {
    decodeSingleHarnessFrame(diagEl);
  });
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');

mountReceiverShell(root);
