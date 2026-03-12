import {
  collectAudioRuntimeInfo,
  createAudioGraphRuntime,
  readInputTrackDiagnostics,
  LinkTimingEstimator,
  registerWorklet,
  requestMicStream,
  sampleAnalyserLevels,
  type AudioLevelSummary,
  type AudioGraphRuntime
} from '../../../packages/audio-browser/src/index.js';
import { PROFILE_IDS } from '../../../packages/contract/src/index.js';
import { crc32c } from '../../../packages/crc/src/index.js';
import { modulateSafeBpsk } from '../../../packages/phy-safe/src/index.js';
import {
  createInitialLiveDiagnostics,
  decodeLiveFrameHex,
  LiveSenderHandshake,
  type LiveDiagnosticsModel
} from '../../../packages/session/src/index.js';

interface SenderRuntime {
  readonly timing: LinkTimingEstimator;
  lastRecordedToneStartMs: number | null;
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly graph: AudioGraphRuntime;
  readonly intervalId: number;
  readonly startedAtMs: number;
}

interface SenderHarnessDiagnostics {
  transfer: LiveDiagnosticsModel;
  frameTransmitAttempts: number;
  lastFailureReason: string | null;
  lastTransmittedFrameHex: string | null;
  handshakeSessionId: number | null;
  currentTurnOwner: 'sender' | 'receiver';
  handshakeResult: 'pending' | 'accepted' | 'rejected';
  handshakeReason: string | null;
}

let senderRuntime: SenderRuntime | null = null;
const senderHandshake = new LiveSenderHandshake();
let lastSeenAckHex: string | null = null;
const senderHarnessDiagnostics: SenderHarnessDiagnostics = {
  transfer: createInitialLiveDiagnostics({ state: 'IDLE', currentTurnOwner: 'sender' }),
  frameTransmitAttempts: 0,
  lastFailureReason: null,
  lastTransmittedFrameHex: null,
  handshakeSessionId: null,
  currentTurnOwner: 'sender',
  handshakeResult: 'pending',
  handshakeReason: null
};

const LIVE_HELLO_ACK_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-hello-ack-hex';

function renderDiagnostics(el: HTMLElement, data: unknown): void {
  el.textContent = JSON.stringify(data, null, 2);
}

function readTestToneFrequency(root: HTMLElement): number {
  const input = root.querySelector<HTMLInputElement>('#sender-tone-frequency');
  if (!input) return 1000;

  const parsed = Number(input.value);
  if (!Number.isFinite(parsed)) return 1000;
  return Math.min(4000, Math.max(200, parsed));
}

function readSelectedProfileId(root: HTMLElement): number {
  const select = root.querySelector<HTMLSelectElement>('#sender-profile');
  if (!select) return PROFILE_IDS.SAFE;
  const selected = Number(select.value);
  if (!Number.isFinite(selected)) {
    return PROFILE_IDS.SAFE;
  }
  return selected;
}

function stopSenderRuntime(): void {
  if (!senderRuntime) return;

  window.clearInterval(senderRuntime.intervalId);
  senderRuntime.graph.dispose();
  senderRuntime.stream.getTracks().forEach((track) => track.stop());
  void senderRuntime.ctx.close();
  senderRuntime = null;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function updateHandshakeDiagnostics(): void {
  const handshake = senderHandshake.diagnostics();
  senderHarnessDiagnostics.handshakeSessionId = handshake.sessionId;
  senderHarnessDiagnostics.currentTurnOwner = handshake.currentTurnOwner;
  senderHarnessDiagnostics.handshakeResult = handshake.result;
  senderHarnessDiagnostics.handshakeReason = handshake.reason;
  senderHarnessDiagnostics.transfer.sessionId = handshake.sessionId;
  senderHarnessDiagnostics.transfer.currentTurnOwner = handshake.currentTurnOwner;
  senderHarnessDiagnostics.transfer.state = handshake.result === 'pending'
    ? 'WAIT_HELLO_ACK'
    : handshake.result === 'accepted'
      ? 'SEND_BURST'
      : 'FAILED';
  senderHarnessDiagnostics.transfer.failure.category = handshake.result === 'rejected' ? 'remote_reject' : 'none';
  senderHarnessDiagnostics.transfer.failure.reason = handshake.reason;
}

function playFrameOverTxPath(runtime: SenderRuntime, frameBytes: Uint8Array): void {
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

async function transmitHelloOverTxPath(root: HTMLElement, diagEl: HTMLElement): Promise<void> {
  senderHarnessDiagnostics.frameTransmitAttempts += 1;
  if (!senderRuntime) {
    senderHarnessDiagnostics.lastFailureReason = 'Start sender runtime before transmitting HELLO.';
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }

  const fileInput = root.querySelector<HTMLInputElement>('#sender-file');
  const file = fileInput?.files?.[0];
  if (!file) {
    senderHarnessDiagnostics.lastFailureReason = 'Select a file before sending HELLO.';
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }
  if (file.size === 0) {
    senderHarnessDiagnostics.lastFailureReason = 'Zero-byte files are not supported by the MVP handshake. Select a non-empty file.';
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const profileId = readSelectedProfileId(root);
    const sessionId = window.crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
    const helloBytes = senderHandshake.emitHello({
      sessionId,
      fileNameUtf8: new TextEncoder().encode(file.name),
      fileSizeBytes: BigInt(file.size),
      fileCrc32c: crc32c(bytes),
      profileId
    });

    playFrameOverTxPath(senderRuntime, helloBytes);
    senderHarnessDiagnostics.transfer.counters.framesTx += 1;
    const helloHex = toHex(helloBytes);
    lastSeenAckHex = null;

    senderHarnessDiagnostics.lastFailureReason = null;
    senderHarnessDiagnostics.lastTransmittedFrameHex = helloHex;
    updateHandshakeDiagnostics();

    renderDiagnostics(diagEl, {
      harness: senderHarnessDiagnostics,
      message: 'HELLO transmitted over live TX path; waiting for HELLO_ACK.'
    });
  } catch (error) {
    senderHarnessDiagnostics.lastFailureReason = String(error);
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
  }
}

function processHelloAckHex(diagEl: HTMLElement, helloAckHex: string): void {
  if (helloAckHex === lastSeenAckHex) {
    return;
  }

  try {
    senderHandshake.acceptHelloAck(decodeLiveFrameHex(helloAckHex));
    senderHarnessDiagnostics.transfer.counters.framesRx += 1;
    lastSeenAckHex = helloAckHex;
    updateHandshakeDiagnostics();
    renderDiagnostics(diagEl, {
      harness: senderHarnessDiagnostics,
      message: senderHarnessDiagnostics.handshakeResult === 'accepted'
        ? 'Received HELLO_ACK accept; sender can proceed to DATA turn.'
        : `Received HELLO_ACK reject: ${senderHarnessDiagnostics.handshakeReason ?? 'unknown reason'}`
    });
  } catch (error) {
    senderHarnessDiagnostics.lastFailureReason = String(error);
    senderHarnessDiagnostics.transfer.failure.category = 'decode_error';
    senderHarnessDiagnostics.transfer.failure.reason = senderHarnessDiagnostics.lastFailureReason;
    senderHarnessDiagnostics.transfer.counters.decodeFailures += 1;
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
  }
}

function maybeConsumeDebugHelloAck(diagEl: HTMLElement): void {
  const helloAckHex = window.localStorage.getItem(LIVE_HELLO_ACK_STORAGE_KEY);
  if (!helloAckHex) {
    return;
  }
  processHelloAckHex(diagEl, helloAckHex);
}

async function startSender(root: HTMLElement, stateEl: HTMLElement, diagEl: HTMLElement): Promise<void> {
  stopSenderRuntime();
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
    senderHarnessDiagnostics.transfer.audio.actualSampleRateHz = runtimeInfo.sampleRate;
    senderHarnessDiagnostics.transfer.audio.inputChannelCount = inputInfo.channelCount ?? null;
    const timing = new LinkTimingEstimator();

    let levels: AudioLevelSummary = { rms: 0, peakAbs: 0, clipping: false };
    const intervalId = window.setInterval(() => {
      levels = sampleAnalyserLevels(graph.rxAnalyser);
      const toneFrequencyHz = graph.testToneFrequencyHz;
      const sampleTimestampMs = Date.now();
      if (graph.testToneStartedAtMs !== null && graph.testToneStartedAtMs !== senderRuntime?.lastRecordedToneStartMs) {
        timing.recordTxToneStart(graph.testToneStartedAtMs);
        if (senderRuntime) {
          senderRuntime.lastRecordedToneStartMs = graph.testToneStartedAtMs;
        }
      }
      timing.recordRxSample(sampleTimestampMs, levels.rms, toneFrequencyHz !== null);
      const linkTiming = timing.snapshot();
      senderHarnessDiagnostics.transfer.elapsedMs = senderRuntime === null ? 0 : Date.now() - senderRuntime.startedAtMs;
      updateHandshakeDiagnostics();
      renderDiagnostics(diagEl, {
        runtime: runtimeInfo,
        input: inputInfo,
        levels,
        graph: {
          rxPath: 'mic -> analyser',
          txPath: 'txGain -> outputGain -> destination'
        },
        testTone: {
          active: toneFrequencyHz !== null,
          frequencyHz: toneFrequencyHz
        },
        linkTiming,
        harness: senderHarnessDiagnostics,
        message: 'Audio runtime initialized; meter active.'
      });
      if (root.querySelector<HTMLInputElement>('#sender-debug-storage')?.checked === true) {
        maybeConsumeDebugHelloAck(diagEl);
      }
    }, 200);

    senderRuntime = { stream, ctx, graph, intervalId, timing, lastRecordedToneStartMs: null, startedAtMs: Date.now() };
    stateEl.textContent = 'ready';
  } catch (error) {
    stateEl.textContent = 'failed';
    renderDiagnostics(diagEl, { error: String(error) });
  }
}

function mountSenderShell(root: HTMLElement): void {
  root.innerHTML = `
    <main>
      <h1>Audio Modem Sender</h1>
      <p>State: <strong id="sender-state">idle</strong></p>

      <section>
        <label for="sender-file">Select file</label>
        <input id="sender-file" type="file" />
      </section>

      <section>
        <label for="sender-profile">Profile</label>
        <select id="sender-profile">
          <option value="${PROFILE_IDS.SAFE}">safe</option>
          <option value="${PROFILE_IDS.NORMAL}">normal</option>
          <option value="${PROFILE_IDS.FAST_TEST}">fast_test</option>
        </select>
      </section>

      <section>
        <button id="sender-start" type="button">Start</button>
        <button id="sender-cancel" type="button">Cancel</button>
        <label for="sender-tone-frequency">Tone Hz</label>
        <input id="sender-tone-frequency" type="number" min="200" max="4000" step="50" value="1000" />
        <button id="sender-tone-toggle" type="button">Toggle test tone</button>
        <button id="sender-send-hello" type="button">Send HELLO</button>
      </section>

      <section>
        <label>
          <input id="sender-debug-storage" type="checkbox" />
          Enable debug HELLO_ACK ingest from localStorage
        </label>
      </section>

      <section>
        <label for="sender-decoded-ack-hex">Decoded RX HELLO_ACK hex</label>
        <input id="sender-decoded-ack-hex" type="text" autocomplete="off" spellcheck="false" />
        <button id="sender-process-ack" type="button">Process decoded HELLO_ACK</button>
      </section>

      <section>
        <h2>Diagnostics</h2>
        <pre id="sender-diag">Diagnostics pending runtime initialization.</pre>
      </section>
    </main>
  `;

  const stateEl = root.querySelector<HTMLElement>('#sender-state');
  const diagEl = root.querySelector<HTMLElement>('#sender-diag');
  const startBtn = root.querySelector<HTMLButtonElement>('#sender-start');
  const cancelBtn = root.querySelector<HTMLButtonElement>('#sender-cancel');
  const toneBtn = root.querySelector<HTMLButtonElement>('#sender-tone-toggle');
  const sendHelloBtn = root.querySelector<HTMLButtonElement>('#sender-send-hello');
  const processAckBtn = root.querySelector<HTMLButtonElement>('#sender-process-ack');
  const decodedAckInput = root.querySelector<HTMLInputElement>('#sender-decoded-ack-hex');
  const debugStorageInput = root.querySelector<HTMLInputElement>('#sender-debug-storage');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !toneBtn || !sendHelloBtn || !processAckBtn || !decodedAckInput || !debugStorageInput) {
    throw new Error('Missing sender shell elements');
  }

  startBtn.addEventListener('click', () => {
    void startSender(root, stateEl, diagEl);
  });

  cancelBtn.addEventListener('click', () => {
    stopSenderRuntime();
    stateEl.textContent = 'cancelled';
    renderDiagnostics(diagEl, { message: 'Sender cancelled by user.' });
  });

  toneBtn.addEventListener('click', () => {
    if (!senderRuntime) {
      renderDiagnostics(diagEl, { error: 'Start sender runtime before toggling tone.' });
      return;
    }

    if (senderRuntime.graph.testToneFrequencyHz !== null) {
      senderRuntime.graph.stopTestTone();
      return;
    }

    senderRuntime.graph.startTestTone(readTestToneFrequency(root));
  });

  sendHelloBtn.addEventListener('click', () => {
    void transmitHelloOverTxPath(root, diagEl);
  });

  processAckBtn.addEventListener('click', () => {
    const helloAckHex = decodedAckInput.value.trim();
    if (!helloAckHex) {
      senderHarnessDiagnostics.lastFailureReason = 'Enter a decoded HELLO_ACK hex frame before processing.';
      renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
      return;
    }
    processHelloAckHex(diagEl, helloAckHex);
  });

  debugStorageInput.addEventListener('change', () => {
    if (!debugStorageInput.checked) {
      return;
    }
    maybeConsumeDebugHelloAck(diagEl);
  });
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');

mountSenderShell(root);
