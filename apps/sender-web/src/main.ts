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

interface SenderRuntime {
  readonly timing: LinkTimingEstimator;
  lastRecordedToneStartMs: number | null;
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly graph: AudioGraphRuntime;
  readonly intervalId: number;
}

let senderRuntime: SenderRuntime | null = null;

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
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');

mountSenderShell(root);
