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
import { FLAGS_MVP_DEFAULT, FRAME_TYPES, PROTOCOL_VERSION, PROFILE_IDS } from '../../../packages/contract/src/index.js';
import { modulateSafeBpsk } from '../../../packages/phy-safe/src/index.js';
import { encodeFrame } from '../../../packages/protocol/src/index.js';

interface SenderRuntime {
  readonly timing: LinkTimingEstimator;
  lastRecordedToneStartMs: number | null;
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly graph: AudioGraphRuntime;
  readonly intervalId: number;
}

interface SenderHarnessDiagnostics {
  frameTransmitAttempts: number;
  lastFailureReason: string | null;
  lastTransmittedFrameHex: string | null;
}

let senderRuntime: SenderRuntime | null = null;
const senderHarnessDiagnostics: SenderHarnessDiagnostics = {
  frameTransmitAttempts: 0,
  lastFailureReason: null,
  lastTransmittedFrameHex: null
};

const LIVE_HARNESS_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-frame-hex';

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

function transmitSingleHarnessFrame(diagEl: HTMLElement): void {
  senderHarnessDiagnostics.frameTransmitAttempts += 1;
  if (!senderRuntime) {
    senderHarnessDiagnostics.lastFailureReason = 'Start sender runtime before transmitting a harness frame.';
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }

  try {
    const encodedFrame = encodeFrame({
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.DATA,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 1,
      burstId: 1,
      slotIndex: 0,
      payloadFileOffset: 0,
      payload: new Uint8Array([0x54, 0x33, 0x2d, 0x68, 0x61, 0x72, 0x6e, 0x65, 0x73, 0x73])
    });

    playFrameOverTxPath(senderRuntime, encodedFrame);
    const frameHex = toHex(encodedFrame);
    senderHarnessDiagnostics.lastFailureReason = null;
    senderHarnessDiagnostics.lastTransmittedFrameHex = frameHex;
    window.localStorage.setItem(LIVE_HARNESS_STORAGE_KEY, frameHex);
    renderDiagnostics(diagEl, {
      harness: senderHarnessDiagnostics,
      message: 'Harness DATA frame transmitted over TX path and recorded for receiver decode.'
    });
  } catch (error) {
    senderHarnessDiagnostics.lastFailureReason = String(error);
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
  }
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
    }, 200);

    senderRuntime = { stream, ctx, graph, intervalId, timing, lastRecordedToneStartMs: null };
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
        <button id="sender-start" type="button">Start</button>
        <button id="sender-cancel" type="button">Cancel</button>
        <label for="sender-tone-frequency">Tone Hz</label>
        <input id="sender-tone-frequency" type="number" min="200" max="4000" step="50" value="1000" />
        <button id="sender-tone-toggle" type="button">Toggle test tone</button>
        <button id="sender-harness-frame" type="button">[dev] Send one harness frame</button>
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
  const harnessFrameBtn = root.querySelector<HTMLButtonElement>('#sender-harness-frame');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !toneBtn || !harnessFrameBtn) {
    throw new Error('Missing sender shell elements');
  }

  harnessFrameBtn.hidden = !window.location.hostname.includes('localhost') && window.location.hostname !== '127.0.0.1';

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

  harnessFrameBtn.addEventListener('click', () => {
    transmitSingleHarnessFrame(diagEl);
  });
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');

mountSenderShell(root);
