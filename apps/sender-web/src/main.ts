import {
  collectAudioRuntimeInfo,
  createAudioGraphRuntime,
  readInputTrackDiagnostics,
  registerWorklet,
  requestMicStream,
  sampleAnalyserLevels,
  type AudioLevelSummary,
  type AudioGraphRuntime
} from '../../../packages/audio-browser/src/index.js';
import { FLAGS_MVP_DEFAULT, FRAME_TYPES, PROFILE_IDS, PROTOCOL_VERSION } from '../../../packages/contract/src/index.js';
import { encodeFrame, type DataFrame } from '../../../packages/protocol/src/index.js';

interface SenderRuntime {
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly graph: AudioGraphRuntime;
  readonly intervalId: number;
}

interface SenderDevDiagnostics {
  readonly frameAttempts: number;
  readonly lastFailureReason: string | null;
  readonly lastTransmittedFrameHex: string | null;
}

declare global {
  interface Window {
    __AUDIO_MODEM_DEV_LIVE_FRAME__?: Uint8Array;
  }
}

let senderRuntime: SenderRuntime | null = null;
let senderDevDiagnostics: SenderDevDiagnostics = {
  frameAttempts: 0,
  lastFailureReason: null,
  lastTransmittedFrameHex: null
};

function renderDiagnostics(el: HTMLElement, data: unknown): void {
  el.textContent = JSON.stringify(data, null, 2);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
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

function transmitSingleDevFrame(diagEl: HTMLElement): void {
  senderDevDiagnostics = {
    ...senderDevDiagnostics,
    frameAttempts: senderDevDiagnostics.frameAttempts + 1
  };

  if (!senderRuntime) {
    senderDevDiagnostics = {
      ...senderDevDiagnostics,
      lastFailureReason: 'Start sender runtime before transmitting a developer frame.'
    };
    renderDiagnostics(diagEl, {
      devHarness: senderDevDiagnostics,
      message: 'Developer single-frame transmit attempted.'
    });
    return;
  }

  try {
    const frame: DataFrame = {
      version: PROTOCOL_VERSION,
      frameType: FRAME_TYPES.DATA,
      flags: FLAGS_MVP_DEFAULT,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x53454e44,
      burstId: 1,
      slotIndex: 0,
      payloadFileOffset: 0,
      payload: new Uint8Array([0x54, 0x33, 0x2d, 0x4c, 0x49, 0x56, 0x45])
    };

    const encoded = encodeFrame(frame);
    window.__AUDIO_MODEM_DEV_LIVE_FRAME__ = encoded;

    senderDevDiagnostics = {
      ...senderDevDiagnostics,
      lastFailureReason: null,
      lastTransmittedFrameHex: toHex(encoded)
    };

    // Route as deterministic TX path marker until PHY modulation is wired.
    senderRuntime.graph.startTestTone(1200);
  } catch (error) {
    senderDevDiagnostics = {
      ...senderDevDiagnostics,
      lastFailureReason: `Developer frame transmit failed: ${String(error)}`
    };
  }

  renderDiagnostics(diagEl, {
    devHarness: senderDevDiagnostics,
    message: 'Developer single-frame transmit attempted.'
  });
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

    let levels: AudioLevelSummary = { rms: 0, peakAbs: 0, clipping: false };
    const intervalId = window.setInterval(() => {
      levels = sampleAnalyserLevels(graph.rxAnalyser);
      const toneFrequencyHz = graph.testToneFrequencyHz;
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
        devHarness: senderDevDiagnostics,
        message: 'Audio runtime initialized; meter active.'
      });
    }, 200);

    senderRuntime = { stream, ctx, graph, intervalId };
    stateEl.textContent = 'ready';
  } catch (error) {
    stateEl.textContent = 'failed';
    renderDiagnostics(diagEl, { error: String(error) });
  }
}

function mountSenderShell(root: HTMLElement): void {
  const showDevControls = import.meta.env.DEV;
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
      </section>

      ${showDevControls ? '<section><h2>Developer controls</h2><button id="sender-send-dev-frame" type="button">Transmit one protocol frame (dev)</button></section>' : ''}

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
  const sendDevFrameBtn = root.querySelector<HTMLButtonElement>('#sender-send-dev-frame');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !toneBtn) {
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

  sendDevFrameBtn?.addEventListener('click', () => {
    transmitSingleDevFrame(diagEl);
  });
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');

mountSenderShell(root);
