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
import { modulateSafeBpsk } from '../../../packages/phy-safe/src/index.js';
import {
  createInitialLiveDiagnostics,
  decodeLiveFrameHex,
  LiveReceiverHandshake,
  type LiveDiagnosticsModel
} from '../../../packages/session/src/index.js';

interface ReceiverRuntime {
  readonly timing: LinkTimingEstimator;
  lastRecordedToneStartMs: number | null;
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly graph: AudioGraphRuntime;
  readonly intervalId: number;
  readonly startedAtMs: number;
}

interface DecodedRxFrameEventDetail {
  readonly frameHex: string;
  readonly frameType?: string;
  readonly classification?: 'ok' | 'decode_error' | 'header_crc_failure' | 'payload_crc_failure' | 'timeout' | 'retry';
}

interface ReceiverHandshakeDiagnostics {
  transfer: LiveDiagnosticsModel;
  sessionId: number | null;
  currentTurnOwner: 'sender' | 'receiver';
  handshakeResult: 'pending' | 'accepted' | 'rejected';
  handshakeReason: string | null;
  processedHelloCount: number;
  lastFailureReason: string | null;
}

const SHOW_DEBUG_CONTROLS = new URLSearchParams(window.location.search).get('debug') === '1';
const LIVE_HELLO_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-hello-hex';
const LIVE_HELLO_ACK_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-hello-ack-hex';
const RECEIVER_DECODED_RX_EVENT = 'fluffy-rotary-phone:receiver-decoded-rx-frame';

let receiverRuntime: ReceiverRuntime | null = null;
const receiverHandshake = new LiveReceiverHandshake();
let lastSeenHelloHex: string | null = null;
let lastCapture: {
  readonly samples: readonly number[];
  readonly levels: AudioLevelSummary;
} | null = null;
let waveformDebugBuffer: readonly WaveformDebugEntry[] = [];
const handshakeDiagnostics: ReceiverHandshakeDiagnostics = {
  transfer: createInitialLiveDiagnostics({ state: 'LISTEN', currentTurnOwner: 'sender' }),
  sessionId: null,
  currentTurnOwner: 'sender',
  handshakeResult: 'pending',
  handshakeReason: null,
  processedHelloCount: 0,
  lastFailureReason: null
};

function renderDiagnostics(el: HTMLElement, data: unknown): void {
  el.textContent = JSON.stringify(data, null, 2);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function updateHandshakeDiagnostics(): void {
  const snapshot = receiverHandshake.diagnostics();
  handshakeDiagnostics.sessionId = snapshot.sessionId;
  handshakeDiagnostics.currentTurnOwner = snapshot.currentTurnOwner;
  handshakeDiagnostics.handshakeResult = snapshot.result;
  handshakeDiagnostics.handshakeReason = snapshot.reason;
  handshakeDiagnostics.transfer.sessionId = snapshot.sessionId;
  handshakeDiagnostics.transfer.currentTurnOwner = snapshot.currentTurnOwner;
  handshakeDiagnostics.transfer.state = snapshot.result === 'pending'
    ? 'LISTEN'
    : snapshot.result === 'accepted'
      ? 'WAIT_DATA'
      : 'FAILED';
  handshakeDiagnostics.transfer.failure.category = snapshot.result === 'rejected' ? 'remote_reject' : 'none';
  handshakeDiagnostics.transfer.failure.reason = snapshot.reason;
}

function applyDecodeClassification(classification: DecodedRxFrameEventDetail['classification']): void {
  switch (classification) {
    case 'decode_error':
      handshakeDiagnostics.transfer.counters.decodeFailures += 1;
      handshakeDiagnostics.transfer.failure.category = 'decode_error';
      handshakeDiagnostics.transfer.failure.reason = 'decoded RX frame classified as decode_error';
      break;
    case 'header_crc_failure':
      handshakeDiagnostics.transfer.counters.crcFailuresHeader += 1;
      handshakeDiagnostics.transfer.failure.category = 'crc_failure';
      handshakeDiagnostics.transfer.failure.reason = 'header CRC failure in decoded RX frame';
      break;
    case 'payload_crc_failure':
      handshakeDiagnostics.transfer.counters.crcFailuresPayload += 1;
      handshakeDiagnostics.transfer.failure.category = 'crc_failure';
      handshakeDiagnostics.transfer.failure.reason = 'payload CRC failure in decoded RX frame';
      break;
    case 'timeout':
      handshakeDiagnostics.transfer.counters.timeoutsBurstAck += 1;
      handshakeDiagnostics.transfer.failure.category = 'timeout';
      handshakeDiagnostics.transfer.failure.reason = 'decoded RX timeout classification';
      break;
    case 'retry':
      handshakeDiagnostics.transfer.counters.retransmissions += 1;
      break;
    default:
      break;
  }
}

function playFrameOverTxPath(runtime: ReceiverRuntime, frameBytes: Uint8Array): void {
  const chips = modulateSafeBpsk(frameBytes);
  const chipSamples = 24;
  const output = runtime.ctx.createBuffer(1, chips.length * chipSamples, runtime.ctx.sampleRate);
  const channel = output.getChannelData(0);

  for (let i = 0; i < chips.length; i += 1) {
    const chip = chips[i];
    if (chip === undefined) {
      throw new Error(`missing modulated chip at index ${i}`);
    }
    const sampleValue = chip * 0.1;
    const startIndex = i * chipSamples;
    for (let sampleIndex = 0; sampleIndex < chipSamples; sampleIndex += 1) {
      channel[startIndex + sampleIndex] = sampleValue;
    }
  }

  const source = runtime.ctx.createBufferSource();
  source.buffer = output;
  source.connect(runtime.graph.txGain);
  source.start();
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

function resetReceiverSessionState(): void {
  receiverHandshake.reset();
  lastSeenHelloHex = null;
  handshakeDiagnostics.transfer = createInitialLiveDiagnostics({ state: 'LISTEN', currentTurnOwner: 'sender' });
  handshakeDiagnostics.sessionId = null;
  handshakeDiagnostics.currentTurnOwner = 'sender';
  handshakeDiagnostics.handshakeResult = 'pending';
  handshakeDiagnostics.handshakeReason = null;
  handshakeDiagnostics.processedHelloCount = 0;
  handshakeDiagnostics.lastFailureReason = null;
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

function processHelloHex(diagEl: HTMLElement, helloHex: string, writeDebugAckToStorage: boolean, classification: DecodedRxFrameEventDetail['classification'] = 'ok'): void {
  applyDecodeClassification(classification);
  if (classification !== 'ok') {
    renderDiagnostics(diagEl, { handshake: handshakeDiagnostics, message: 'Decoded RX frame classification handled.' });
    return;
  }

  if (helloHex === lastSeenHelloHex || !receiverRuntime) {
    return;
  }

  try {
    const { helloAckBytes } = receiverHandshake.handleHello(decodeLiveFrameHex(helloHex));
    handshakeDiagnostics.transfer.counters.framesRx += 1;
    handshakeDiagnostics.processedHelloCount += 1;
    updateHandshakeDiagnostics();
    const ackHex = toHex(helloAckBytes);
    if (writeDebugAckToStorage) {
      window.localStorage.setItem(LIVE_HELLO_ACK_STORAGE_KEY, ackHex);
    }
    playFrameOverTxPath(receiverRuntime, helloAckBytes);
    handshakeDiagnostics.transfer.counters.framesTx += 1;
    lastSeenHelloHex = helloHex;
    handshakeDiagnostics.lastFailureReason = null;
    renderDiagnostics(diagEl, {
      handshake: handshakeDiagnostics,
      transmittedHelloAckHex: ackHex,
      message: handshakeDiagnostics.handshakeResult === 'accepted'
        ? 'HELLO accepted from decoded RX event and HELLO_ACK transmitted over receiver TX path.'
        : `HELLO rejected from decoded RX event and HELLO_ACK transmitted: ${handshakeDiagnostics.handshakeReason ?? 'unknown reason'}`
    });
  } catch (error) {
    handshakeDiagnostics.lastFailureReason = String(error);
    handshakeDiagnostics.transfer.failure.category = 'decode_error';
    handshakeDiagnostics.transfer.failure.reason = handshakeDiagnostics.lastFailureReason;
    handshakeDiagnostics.transfer.counters.decodeFailures += 1;
    renderDiagnostics(diagEl, {
      handshake: handshakeDiagnostics,
      message: 'Failed to process HELLO frame.'
    });
  }
}

function handleDecodedRxEvent(diagEl: HTMLElement, detail: DecodedRxFrameEventDetail): void {
  if (detail.frameType && detail.frameType !== 'HELLO') {
    handshakeDiagnostics.transfer.counters.decodeFailures += 1;
    handshakeDiagnostics.transfer.failure.category = 'decode_error';
    handshakeDiagnostics.transfer.failure.reason = `unexpected decoded frame type for receiver handshake: ${detail.frameType}`;
    renderDiagnostics(diagEl, { handshake: handshakeDiagnostics });
    return;
  }
  processHelloHex(diagEl, detail.frameHex, false, detail.classification ?? 'ok');
}

function maybeProcessDebugHello(diagEl: HTMLElement): void {
  const helloHex = window.localStorage.getItem(LIVE_HELLO_STORAGE_KEY);
  if (!helloHex) return;
  processHelloHex(diagEl, helloHex, true, 'ok');
}

async function startReceiver(stateEl: HTMLElement, diagEl: HTMLElement, isDebugStorageEnabled: () => boolean): Promise<void> {
  stopReceiverRuntime();
  resetReceiverSessionState();
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
    handshakeDiagnostics.transfer.audio.actualSampleRateHz = runtimeInfo.sampleRate;
    handshakeDiagnostics.transfer.audio.inputChannelCount = inputInfo.channelCount ?? null;
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
      handshakeDiagnostics.transfer.elapsedMs = receiverRuntime === null ? 0 : Date.now() - receiverRuntime.startedAtMs;
      waveformDebugBuffer = appendWaveformDebugEntry(waveformDebugBuffer, { timestampMs: Date.now(), levels }, 16);

      updateHandshakeDiagnostics();
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
        decodedRxEvent: RECEIVER_DECODED_RX_EVENT,
        waveformDebug: {
          entryCount: waveformDebugBuffer.length,
          recent: waveformDebugBuffer
        },
        handshake: handshakeDiagnostics,
        message: 'Receiver listening shell initialized; awaiting decoded RX events.'
      });
      if (SHOW_DEBUG_CONTROLS && isDebugStorageEnabled()) {
        maybeProcessDebugHello(diagEl);
      }
    }, 200);

    receiverRuntime = { stream, ctx, graph, intervalId, timing, lastRecordedToneStartMs: null, startedAtMs: Date.now() };
    stateEl.textContent = 'listen';
  } catch (error) {
    resetReceiverSessionState();
    stateEl.textContent = 'failed';
    renderDiagnostics(diagEl, { error: String(error) });
  }
}

export function mountReceiverShell(root: HTMLElement): void {
  const debugControls = SHOW_DEBUG_CONTROLS
    ? `
      <section>
        <details>
          <summary>Developer debug controls (manual bridge; not default flow)</summary>
          <label>
            <input id="receiver-debug-storage" type="checkbox" />
            Enable debug HELLO ingest from localStorage
          </label>
          <label for="receiver-debug-hello-hex">Manual decoded HELLO hex (debug only)</label>
          <input id="receiver-debug-hello-hex" type="text" autocomplete="off" spellcheck="false" />
          <button id="receiver-debug-hello-process" type="button">Process manual debug HELLO</button>
        </details>
      </section>
    `
    : '';

  root.innerHTML = `
    <main>
      <h1>Audio Modem Receiver</h1>
      <p>State: <strong id="receiver-state">idle</strong></p>
      <p>Decoded RX source: custom event <code>${RECEIVER_DECODED_RX_EVENT}</code></p>

      <section>
        <button id="receiver-start" type="button">Start</button>
        <button id="receiver-cancel" type="button">Cancel</button>
        <button id="receiver-capture" type="button">Capture RX snapshot</button>
      </section>

      ${debugControls}

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
  const debugStorageInput = root.querySelector<HTMLInputElement>('#receiver-debug-storage');
  const debugHelloInput = root.querySelector<HTMLInputElement>('#receiver-debug-hello-hex');
  const debugHelloProcessBtn = root.querySelector<HTMLButtonElement>('#receiver-debug-hello-process');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !captureBtn) {
    throw new Error('Missing receiver shell elements');
  }

  window.addEventListener(RECEIVER_DECODED_RX_EVENT, (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    handleDecodedRxEvent(diagEl, event.detail as DecodedRxFrameEventDetail);
  });

  startBtn.addEventListener('click', () => {
    void startReceiver(stateEl, diagEl, () => debugStorageInput?.checked === true);
  });

  cancelBtn.addEventListener('click', () => {
    stopReceiverRuntime();
    resetReceiverSessionState();
    stateEl.textContent = 'cancelled';
    renderDiagnostics(diagEl, { handshake: handshakeDiagnostics, message: 'Receiver cancelled by user.' });
  });

  captureBtn.addEventListener('click', () => {
    captureRxSnapshot(diagEl);
  });

  if (SHOW_DEBUG_CONTROLS && debugStorageInput) {
    debugStorageInput.addEventListener('change', () => {
      if (!debugStorageInput.checked) return;
      maybeProcessDebugHello(diagEl);
    });
  }

  if (SHOW_DEBUG_CONTROLS && debugHelloInput && debugHelloProcessBtn) {
    debugHelloProcessBtn.addEventListener('click', () => {
      const helloHex = debugHelloInput.value.trim();
      if (!helloHex) {
        renderDiagnostics(diagEl, { handshake: handshakeDiagnostics, message: 'Enter HELLO hex for debug processing.' });
        return;
      }
      processHelloHex(diagEl, helloHex, true);
    });
  }
}

const root = document.querySelector<HTMLElement>('#app');
if (root) {
  mountReceiverShell(root);
}
