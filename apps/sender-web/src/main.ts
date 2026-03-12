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
import { PROFILE_IDS, type ProfileIdCode } from '../../../packages/contract/src/index.js';
import {
  LIVE_HANDSHAKE_DEFAULT_PROFILES,
  ReceiverLiveHandshake,
  SenderLiveHandshake,
  type HandshakeDiagnostics,
  type LivePhyTransport
} from '../../../packages/session/src/index.js';

interface SenderRuntime {
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly graph: AudioGraphRuntime;
  readonly intervalId: number;
  readonly handshake: HandshakeDiagnostics;
}

let senderRuntime: SenderRuntime | null = null;
let handshakeDiagnostics: HandshakeDiagnostics = {
  sessionId: null,
  turnOwner: 'sender',
  handshake: { status: 'idle' }
};

function renderDiagnostics(el: HTMLElement, data: unknown): void {
  el.textContent = JSON.stringify(data, null, 2);
}

function readProfileId(root: HTMLElement): ProfileIdCode {
  const select = root.querySelector<HTMLSelectElement>('#sender-profile');
  if (!select) return PROFILE_IDS.SAFE;
  const parsed = Number(select.value);
  if (parsed === PROFILE_IDS.NORMAL) return PROFILE_IDS.NORMAL;
  if (parsed === PROFILE_IDS.FAST_TEST) return PROFILE_IDS.FAST_TEST;
  return PROFILE_IDS.SAFE;
}

function readSelectedFile(root: HTMLElement): File | null {
  const fileInput = root.querySelector<HTMLInputElement>('#sender-file');
  return fileInput?.files?.[0] ?? null;
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

function runLocalHandshake(file: File, profileId: ProfileIdCode): HandshakeDiagnostics {
  let senderHandler: ((frameBytes: Uint8Array) => void) | null = null;
  let receiverHandler: ((frameBytes: Uint8Array) => void) | null = null;

  const senderEndpoint: LivePhyTransport = {
    send: (frameBytes) => {
      if (!receiverHandler) throw new Error('receiver handler missing');
      receiverHandler(frameBytes);
    }
  };

  const receiverEndpoint: LivePhyTransport = {
    send: (frameBytes) => {
      if (!senderHandler) throw new Error('sender handler missing');
      senderHandler(frameBytes);
    }
  };

  const sender = new SenderLiveHandshake(senderEndpoint);
  const receiver = new ReceiverLiveHandshake({
    transport: receiverEndpoint,
    supportedProfiles: LIVE_HANDSHAKE_DEFAULT_PROFILES,
    canAllocate: (fileSizeBytes) => fileSizeBytes <= 10n * 1024n * 1024n
  });

  senderHandler = (frameBytes) => {
    sender.onFrame(frameBytes);
  };
  receiverHandler = (frameBytes) => {
    receiver.onFrame(frameBytes);
  };

  handshakeDiagnostics = sender.start({
    fileName: file.name,
    fileSizeBytes: file.size,
    profileId
  });

  return handshakeDiagnostics;
}

async function startSender(root: HTMLElement, stateEl: HTMLElement, diagEl: HTMLElement): Promise<void> {
  stopSenderRuntime();
  stateEl.textContent = 'starting';

  try {
    const file = readSelectedFile(root);
    if (!file) throw new Error('Select a file before starting sender handshake.');

    const profileId = readProfileId(root);
    handshakeDiagnostics = runLocalHandshake(file, profileId);

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
        session: handshakeDiagnostics,
        testTone: {
          active: toneFrequencyHz !== null,
          frequencyHz: toneFrequencyHz
        },
        message: 'Audio runtime initialized; handshake wired through live frame TX shell.'
      });
    }, 200);

    senderRuntime = { stream, ctx, graph, intervalId, handshake: handshakeDiagnostics };
    stateEl.textContent = handshakeDiagnostics.handshake.status === 'accepted' ? 'ready' : 'handshake-rejected';
  } catch (error) {
    stateEl.textContent = 'failed';
    renderDiagnostics(diagEl, { error: String(error), session: handshakeDiagnostics });
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
        <label for="sender-profile">Profile</label>
        <select id="sender-profile">
          <option value="${PROFILE_IDS.SAFE}">safe</option>
          <option value="${PROFILE_IDS.NORMAL}">normal</option>
          <option value="${PROFILE_IDS.FAST_TEST}">fast-test</option>
        </select>
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
    renderDiagnostics(diagEl, { message: 'Sender cancelled by user.', session: handshakeDiagnostics });
  });

  toneBtn.addEventListener('click', () => {
    if (!senderRuntime) {
      renderDiagnostics(diagEl, { error: 'Start sender runtime before toggling tone.', session: handshakeDiagnostics });
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
