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
import { FRAME_TYPES, PROFILE_IDS, TIMEOUTS_MS } from '../../../packages/contract/src/index.js';
import { crc32c } from '../../../packages/crc/src/index.js';
import { decodeFrame } from '../../../packages/protocol/src/index.js';
import { modulateSafeBpsk } from '../../../packages/phy-safe/src/index.js';
import {
  createInitialLiveDiagnostics,
  decodeLiveFrameHex,
  LiveSenderHandshake,
  LiveSenderTransfer,
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

interface DecodedRxFrameEventDetail {
  readonly frameHex: string;
  readonly frameType?: string;
  readonly classification?: 'ok' | 'decode_error' | 'header_crc_failure' | 'payload_crc_failure' | 'timeout' | 'retry';
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
  transferBytesConfirmed: number;
  invalidTurnEvents: number;
  runtimeStartup: {
    attempts: number;
    stage: 'idle' | 'request_mic' | 'init_audio_context' | 'register_worklet' | 'create_audio_graph' | 'ready' | 'failed';
    lastAttemptAtMs: number | null;
    lastSuccessAtMs: number | null;
    workletModuleCandidates: readonly string[];
    workletModuleSelected: string | null;
    workletModuleErrors: readonly string[];
    lastError: string | null;
  };
}

const SHOW_DEBUG_CONTROLS = new URLSearchParams(window.location.search).get('debug') === '1';
const LIVE_HELLO_ACK_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-hello-ack-hex';
const SENDER_DECODED_RX_EVENT = 'fluffy-rotary-phone:sender-decoded-rx-frame';
const SENDER_WORKLET_MODULE_CANDIDATES = [
  '/meter_processor.js',
  new URL('meter_processor.js', window.location.href).toString()
] as const;

let senderRuntime: SenderRuntime | null = null;
let senderStartInFlight: Promise<void> | null = null;
let decodedRxEventListener: ((event: Event) => void) | null = null;
const senderHandshake = new LiveSenderHandshake();
let senderTransfer: LiveSenderTransfer | null = null;
let lastSeenAckHex: string | null = null;
let helloAckDeadlineMs: number | null = null;
let burstAckDeadlineMs: number | null = null;
let finalDeadlineMs: number | null = null;
const senderHarnessDiagnostics: SenderHarnessDiagnostics = {
  transfer: createInitialLiveDiagnostics({ state: 'IDLE', currentTurnOwner: 'sender' }),
  frameTransmitAttempts: 0,
  lastFailureReason: null,
  lastTransmittedFrameHex: null,
  handshakeSessionId: null,
  currentTurnOwner: 'sender',
  handshakeResult: 'pending',
  handshakeReason: null,
  transferBytesConfirmed: 0,
  invalidTurnEvents: 0,
  runtimeStartup: {
    attempts: 0,
    stage: 'idle',
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    workletModuleCandidates: SENDER_WORKLET_MODULE_CANDIDATES,
    workletModuleSelected: null,
    workletModuleErrors: [],
    lastError: null
  }
};

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
  return Number.isFinite(selected) ? selected : PROFILE_IDS.SAFE;
}

function stopSenderRuntime(): void {
  if (!senderRuntime) return;
  window.clearInterval(senderRuntime.intervalId);
  senderRuntime.graph.dispose();
  senderRuntime.stream.getTracks().forEach((track) => track.stop());
  void senderRuntime.ctx.close();
  senderRuntime = null;
}

function resetSenderSessionState(): void {
  senderHandshake.reset();
  lastSeenAckHex = null;
  helloAckDeadlineMs = null;
  burstAckDeadlineMs = null;
  finalDeadlineMs = null;
  senderTransfer = null;
  senderHarnessDiagnostics.transfer = createInitialLiveDiagnostics({ state: 'IDLE', currentTurnOwner: 'sender' });
  senderHarnessDiagnostics.frameTransmitAttempts = 0;
  senderHarnessDiagnostics.lastFailureReason = null;
  senderHarnessDiagnostics.lastTransmittedFrameHex = null;
  senderHarnessDiagnostics.handshakeSessionId = null;
  senderHarnessDiagnostics.currentTurnOwner = 'sender';
  senderHarnessDiagnostics.handshakeResult = 'pending';
  senderHarnessDiagnostics.handshakeReason = null;
  senderHarnessDiagnostics.transferBytesConfirmed = 0;
  senderHarnessDiagnostics.invalidTurnEvents = 0;
}

function setDiagnosticsFailure(category: LiveDiagnosticsModel['failure']['category'], reason: string): void {
  senderHarnessDiagnostics.lastFailureReason = reason;
  senderHarnessDiagnostics.transfer.failure.category = category;
  senderHarnessDiagnostics.transfer.failure.reason = reason;
}

async function registerSenderWorklet(ctx: AudioContext): Promise<void> {
  const errors: string[] = [];
  for (const moduleUrl of SENDER_WORKLET_MODULE_CANDIDATES) {
    try {
      await registerWorklet(ctx, moduleUrl);
      senderHarnessDiagnostics.runtimeStartup.workletModuleSelected = moduleUrl;
      senderHarnessDiagnostics.runtimeStartup.workletModuleErrors = errors;
      return;
    } catch (error) {
      errors.push(`${moduleUrl}: ${String(error)}`);
    }
  }

  senderHarnessDiagnostics.runtimeStartup.workletModuleErrors = errors;
  throw new Error(`Unable to register sender worklet. Attempted modules: ${errors.join(' | ')}`);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function applyDecodeClassification(classification: DecodedRxFrameEventDetail['classification']): void {
  switch (classification) {
    case 'decode_error':
      senderHarnessDiagnostics.transfer.counters.decodeFailures += 1;
      senderHarnessDiagnostics.transfer.failure.category = 'decode_error';
      senderHarnessDiagnostics.transfer.failure.reason = 'decoded RX frame classified as decode_error';
      break;
    case 'header_crc_failure':
      senderHarnessDiagnostics.transfer.counters.crcFailuresHeader += 1;
      senderHarnessDiagnostics.transfer.failure.category = 'crc_failure';
      senderHarnessDiagnostics.transfer.failure.reason = 'header CRC failure in decoded RX frame';
      break;
    case 'payload_crc_failure':
      senderHarnessDiagnostics.transfer.counters.crcFailuresPayload += 1;
      senderHarnessDiagnostics.transfer.failure.category = 'crc_failure';
      senderHarnessDiagnostics.transfer.failure.reason = 'payload CRC failure in decoded RX frame';
      break;
    case 'timeout':
      senderHarnessDiagnostics.transfer.counters.timeoutsHelloAck += 1;
      senderHarnessDiagnostics.transfer.failure.category = 'timeout';
      senderHarnessDiagnostics.transfer.failure.reason = 'decoded RX timeout classification';
      break;
    case 'retry':
      senderHarnessDiagnostics.transfer.counters.retransmissions += 1;
      break;
    default:
      break;
  }
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

function transmitFrames(frames: readonly Uint8Array[]): void {
  if (!senderRuntime || frames.length === 0) return;
  for (const frame of frames) {
    playFrameOverTxPath(senderRuntime, frame);
  }
  senderHarnessDiagnostics.transfer.counters.framesTx += frames.length;
}

async function transmitHelloOverTxPath(root: HTMLElement, diagEl: HTMLElement): Promise<void> {
  if (!senderRuntime) {
    setDiagnosticsFailure('input_validation', 'Start sender runtime before transmitting HELLO.');
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }

  const fileInput = root.querySelector<HTMLInputElement>('#sender-file');
  const file = fileInput?.files?.[0];
  if (!file) {
    setDiagnosticsFailure('input_validation', 'Select a file before sending HELLO.');
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }
  if (file.size === 0) {
    setDiagnosticsFailure('input_validation', 'Zero-byte files are not supported by the MVP handshake. Select a non-empty file.');
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }
  senderHarnessDiagnostics.frameTransmitAttempts += 1;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const profileId = readSelectedProfileId(document.body);
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
    senderHarnessDiagnostics.lastFailureReason = null;
    senderHarnessDiagnostics.transfer.failure.category = 'none';
    senderHarnessDiagnostics.transfer.failure.reason = null;
    senderHarnessDiagnostics.lastTransmittedFrameHex = toHex(helloBytes);
    helloAckDeadlineMs = Date.now() + TIMEOUTS_MS.HELLO_ACK;
    burstAckDeadlineMs = null;
    finalDeadlineMs = null;
    senderTransfer = null;
    lastSeenAckHex = null;

    updateHandshakeDiagnostics();
    renderDiagnostics(diagEl, {
      harness: senderHarnessDiagnostics,
      message: `HELLO transmitted over live TX path; waiting for decoder event ${SENDER_DECODED_RX_EVENT}.`
    });
  } catch (error) {
    setDiagnosticsFailure('unknown', String(error));
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
  }
}

function processHelloAckHex(diagEl: HTMLElement, helloAckHex: string, classification: DecodedRxFrameEventDetail['classification'] = 'ok'): void {
  applyDecodeClassification(classification);
  if (classification !== 'ok') {
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics, message: 'Decoded RX frame classification handled.' });
    return;
  }

  if (helloAckHex === lastSeenAckHex) {
    return;
  }

  try {
    senderHandshake.acceptHelloAck(decodeLiveFrameHex(helloAckHex));
    helloAckDeadlineMs = null;
    senderHarnessDiagnostics.transfer.counters.framesRx += 1;
    lastSeenAckHex = helloAckHex;
    updateHandshakeDiagnostics();
    if (senderHarnessDiagnostics.handshakeResult === 'accepted' && senderHarnessDiagnostics.handshakeSessionId !== null) {
      const fileInput = document.querySelector<HTMLInputElement>('#sender-file');
      const file = fileInput?.files?.[0];
      if (file) {
        void file.arrayBuffer().then((buffer) => {
          senderTransfer = new LiveSenderTransfer({
            sessionId: senderHarnessDiagnostics.handshakeSessionId ?? 0,
            profileId: readSelectedProfileId(document.body),
            fileBytes: new Uint8Array(buffer)
          });
          const step = senderTransfer.initialBurstFrames();
          senderHarnessDiagnostics.transfer.state = 'SEND_BURST';
          senderHarnessDiagnostics.transfer.counters.burstsTx += 1;
          transmitFrames(step.txFrames);
          burstAckDeadlineMs = Date.now() + TIMEOUTS_MS.BURST_ACK;
        });
      }
    }
    renderDiagnostics(diagEl, {
      harness: senderHarnessDiagnostics,
      message: senderHarnessDiagnostics.handshakeResult === 'accepted'
        ? 'Received HELLO_ACK accept from decoded RX event; sender can proceed to DATA turn.'
        : `Received HELLO_ACK reject from decoded RX event: ${senderHarnessDiagnostics.handshakeReason ?? 'unknown reason'}`
    });
  } catch (error) {
    senderHarnessDiagnostics.lastFailureReason = String(error);
    senderHarnessDiagnostics.transfer.failure.category = 'decode_error';
    senderHarnessDiagnostics.transfer.failure.reason = senderHarnessDiagnostics.lastFailureReason;
    senderHarnessDiagnostics.transfer.counters.decodeFailures += 1;
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
  }
}

function processSenderTransferFrame(diagEl: HTMLElement, detail: DecodedRxFrameEventDetail): void {
  if (!senderTransfer) return;
  if (detail.frameType !== 'BURST_ACK' && detail.frameType !== 'FINAL_OK' && detail.frameType !== 'FINAL_BAD') {
    senderHarnessDiagnostics.invalidTurnEvents += 1;
    senderHarnessDiagnostics.transfer.failure.category = 'protocol_error';
    senderHarnessDiagnostics.transfer.failure.reason = `unexpected sender transfer frame type: ${detail.frameType ?? 'unknown'}`;
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }

  const frameBytes = decodeLiveFrameHex(detail.frameHex);
  senderHarnessDiagnostics.transfer.counters.framesRx += 1;
  if (detail.frameType === 'BURST_ACK') {
    burstAckDeadlineMs = null;
    const result = senderTransfer.onBurstAck(frameBytes);
    transmitFrames(result.txFrames);
    if (result.txFrames.length > 0 && !result.failed) {
      const firstTx = decodeFrame(result.txFrames[0] ?? new Uint8Array(), { expectedSessionId: senderHarnessDiagnostics.handshakeSessionId ?? undefined });
      if (firstTx.frameType === FRAME_TYPES.END) {
        finalDeadlineMs = Date.now() + TIMEOUTS_MS.FINAL_RESULT;
        senderHarnessDiagnostics.transfer.state = 'WAIT_FINAL';
      } else {
        senderHarnessDiagnostics.transfer.counters.retransmissions += 1;
        senderHarnessDiagnostics.transfer.counters.burstsTx += 1;
        burstAckDeadlineMs = Date.now() + TIMEOUTS_MS.BURST_ACK;
        senderHarnessDiagnostics.transfer.state = 'WAIT_BURST_ACK';
      }
    }
    return;
  }

  finalDeadlineMs = null;
  const finalResult = senderTransfer.onFinal(frameBytes);
  if (finalResult.done) {
    senderHarnessDiagnostics.transfer.state = 'SUCCEEDED';
    senderHarnessDiagnostics.currentTurnOwner = 'sender';
    senderHarnessDiagnostics.transferBytesConfirmed = (document.querySelector<HTMLInputElement>('#sender-file')?.files?.[0]?.size ?? 0);
    senderHarnessDiagnostics.transfer.effectiveGoodputBps = senderHarnessDiagnostics.transfer.elapsedMs > 0
      ? Math.floor((senderHarnessDiagnostics.transferBytesConfirmed * 8 * 1000) / senderHarnessDiagnostics.transfer.elapsedMs)
      : 0;
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics, message: 'Sender transfer completed with FINAL_OK.' });
    return;
  }

  senderHarnessDiagnostics.transfer.state = 'FAILED';
  senderHarnessDiagnostics.transfer.failure.category = 'protocol_error';
  senderHarnessDiagnostics.transfer.failure.reason = 'Sender transfer failed with FINAL_BAD or invalid final frame.';
  renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
}

function maybeConsumeDebugHelloAck(diagEl: HTMLElement): void {
  const helloAckHex = window.localStorage.getItem(LIVE_HELLO_ACK_STORAGE_KEY);
  if (!helloAckHex) return;
  processHelloAckHex(diagEl, helloAckHex, 'ok');
}

function handleDecodedRxEvent(diagEl: HTMLElement, detail: DecodedRxFrameEventDetail): void {
  if (detail.frameType === 'HELLO_ACK') {
    processHelloAckHex(diagEl, detail.frameHex, detail.classification ?? 'ok');
    return;
  }
  if (detail.frameType === 'BURST_ACK' || detail.frameType === 'FINAL_OK' || detail.frameType === 'FINAL_BAD') {
    processSenderTransferFrame(diagEl, detail);
    return;
  }
  if (detail.frameType) {
    senderHarnessDiagnostics.transfer.counters.decodeFailures += 1;
    senderHarnessDiagnostics.invalidTurnEvents += 1;
    senderHarnessDiagnostics.transfer.failure.category = 'decode_error';
    senderHarnessDiagnostics.transfer.failure.reason = `unexpected decoded frame type for sender shell: ${detail.frameType}`;
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
    return;
  }
  processHelloAckHex(diagEl, detail.frameHex, detail.classification ?? 'ok');
}

async function startSender(root: HTMLElement, stateEl: HTMLElement, diagEl: HTMLElement): Promise<void> {
  if (senderStartInFlight) {
    await senderStartInFlight;
    return;
  }

  const startPromise = (async () => {
    stopSenderRuntime();
    resetSenderSessionState();
    stateEl.textContent = 'starting';
    senderHarnessDiagnostics.runtimeStartup.attempts += 1;
    senderHarnessDiagnostics.runtimeStartup.stage = 'request_mic';
    senderHarnessDiagnostics.runtimeStartup.lastAttemptAtMs = Date.now();
    senderHarnessDiagnostics.runtimeStartup.lastError = null;
    senderHarnessDiagnostics.runtimeStartup.workletModuleSelected = null;
    senderHarnessDiagnostics.runtimeStartup.workletModuleErrors = [];

    try {
      const stream = await requestMicStream(window.navigator);
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No audio track available');

      senderHarnessDiagnostics.runtimeStartup.stage = 'init_audio_context';
      const ctx = new AudioContext();
      senderHarnessDiagnostics.runtimeStartup.stage = 'register_worklet';
      await registerSenderWorklet(ctx);

      senderHarnessDiagnostics.runtimeStartup.stage = 'create_audio_graph';
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
      if (helloAckDeadlineMs !== null && Date.now() >= helloAckDeadlineMs && senderHarnessDiagnostics.handshakeResult === 'pending') {
        senderHarnessDiagnostics.transfer.counters.timeoutsHelloAck += 1;
        senderHarnessDiagnostics.transfer.counters.retransmissions += 1;
        senderHarnessDiagnostics.transfer.failure.category = 'timeout';
        senderHarnessDiagnostics.transfer.failure.reason = 'HELLO_ACK timeout in live sender shell';
        helloAckDeadlineMs = Date.now() + TIMEOUTS_MS.HELLO_ACK;
      }
      if (burstAckDeadlineMs !== null && Date.now() >= burstAckDeadlineMs && senderTransfer) {
        senderHarnessDiagnostics.transfer.counters.timeoutsBurstAck += 1;
        senderHarnessDiagnostics.transfer.failure.category = 'timeout';
        senderHarnessDiagnostics.transfer.failure.reason = 'BURST_ACK timeout in live sender shell';
        const retry = senderTransfer.onBurstAckTimeout();
        if (retry.txFrames.length > 0) {
          senderHarnessDiagnostics.transfer.counters.retransmissions += retry.txFrames.length;
          senderHarnessDiagnostics.transfer.counters.burstsTx += 1;
        }
        transmitFrames(retry.txFrames);
        burstAckDeadlineMs = retry.failed ? null : Date.now() + TIMEOUTS_MS.BURST_ACK;
        if (retry.failed) {
          senderHarnessDiagnostics.transfer.state = 'FAILED';
        }
      }
      if (finalDeadlineMs !== null && Date.now() >= finalDeadlineMs && senderTransfer) {
        senderHarnessDiagnostics.transfer.counters.timeoutsFinal += 1;
        const retry = senderTransfer.onFinalTimeout();
        transmitFrames(retry.txFrames);
        finalDeadlineMs = Date.now() + TIMEOUTS_MS.FINAL_RESULT;
      }
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
        decodedRxEvent: SENDER_DECODED_RX_EVENT,
        harness: senderHarnessDiagnostics,
        message: 'Audio runtime initialized; awaiting decoded RX events.'
      });
      if (SHOW_DEBUG_CONTROLS && root.querySelector<HTMLInputElement>('#sender-debug-storage')?.checked === true) {
        maybeConsumeDebugHelloAck(diagEl);
      }
      }, 200);

      senderRuntime = { stream, ctx, graph, intervalId, timing, lastRecordedToneStartMs: null, startedAtMs: Date.now() };
      senderHarnessDiagnostics.runtimeStartup.stage = 'ready';
      senderHarnessDiagnostics.runtimeStartup.lastSuccessAtMs = Date.now();
      stateEl.textContent = 'ready';
    } catch (error) {
      resetSenderSessionState();
      stateEl.textContent = 'failed';
      senderHarnessDiagnostics.runtimeStartup.stage = 'failed';
      senderHarnessDiagnostics.runtimeStartup.lastError = String(error);
      setDiagnosticsFailure('unknown', `Sender runtime startup failed: ${String(error)}`);
      renderDiagnostics(diagEl, {
        harness: senderHarnessDiagnostics,
        error: senderHarnessDiagnostics.lastFailureReason,
        message: 'Sender runtime startup failed during auto-start or explicit start request.'
      });
    }
  })();

  senderStartInFlight = startPromise;
  try {
    await startPromise;
  } finally {
    if (senderStartInFlight === startPromise) {
      senderStartInFlight = null;
    }
  }
}

export function mountSenderShell(root: HTMLElement): void {
  const debugControls = SHOW_DEBUG_CONTROLS
    ? `
      <section>
        <details>
          <summary>Developer debug controls (manual bridge; not default flow)</summary>
          <label>
            <input id="sender-debug-storage" type="checkbox" />
            Enable debug HELLO_ACK ingest from localStorage
          </label>
          <label for="sender-debug-ack-hex">Manual decoded HELLO_ACK hex (debug only)</label>
          <input id="sender-debug-ack-hex" type="text" autocomplete="off" spellcheck="false" />
          <button id="sender-debug-ack-process" type="button">Process manual debug HELLO_ACK</button>
        </details>
      </section>
    `
    : '';

  root.innerHTML = `
    <main>
      <h1>Audio Modem Sender</h1>
      <p>State: <strong id="sender-state">idle</strong></p>
      <p>Decoded RX source: custom event <code>${SENDER_DECODED_RX_EVENT}</code></p>
      <p>Transfer RX frames accepted after handshake: <code>BURST_ACK</code>, <code>FINAL_OK</code>, <code>FINAL_BAD</code></p>

      <section>
        <label for="sender-file">Select file</label>
        <input id="sender-file" type="file" />
      </section>

      <section>
        <label for="sender-profile">Profile</label>
        <select id="sender-profile">
          <option value="${PROFILE_IDS.SAFE}">safe (MVP default)</option>
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

      ${debugControls}

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
  const debugStorageInput = root.querySelector<HTMLInputElement>('#sender-debug-storage');
  const debugAckInput = root.querySelector<HTMLInputElement>('#sender-debug-ack-hex');
  const debugAckProcessBtn = root.querySelector<HTMLButtonElement>('#sender-debug-ack-process');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !toneBtn || !sendHelloBtn) {
    throw new Error('Missing sender shell elements');
  }

  if (decodedRxEventListener) {
    window.removeEventListener(SENDER_DECODED_RX_EVENT, decodedRxEventListener);
  }
  decodedRxEventListener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    handleDecodedRxEvent(diagEl, event.detail as DecodedRxFrameEventDetail);
  };
  window.addEventListener(SENDER_DECODED_RX_EVENT, decodedRxEventListener);

  startBtn.addEventListener('click', () => {
    void startSender(root, stateEl, diagEl);
  });

  cancelBtn.addEventListener('click', () => {
    stopSenderRuntime();
    resetSenderSessionState();
    stateEl.textContent = 'cancelled';
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics, message: 'Sender cancelled by user.' });
  });

  toneBtn.addEventListener('click', () => {
    void (async () => {
      try {
        if (!senderRuntime) {
          await startSender(root, stateEl, diagEl);
        }
        if (!senderRuntime) {
          return;
        }

        if (senderRuntime.graph.testToneFrequencyHz !== null) {
          senderRuntime.graph.stopTestTone();
          return;
        }

        senderRuntime.graph.startTestTone(readTestToneFrequency(root));
      } catch (error) {
        senderHarnessDiagnostics.lastFailureReason = `Tone toggle failed: ${String(error)}`;
        senderHarnessDiagnostics.transfer.failure.category = 'unknown';
        senderHarnessDiagnostics.transfer.failure.reason = senderHarnessDiagnostics.lastFailureReason;
        renderDiagnostics(diagEl, {
          harness: senderHarnessDiagnostics,
          error: senderHarnessDiagnostics.lastFailureReason,
          message: 'Unexpected tone toggle failure.'
        });
      }
    })();
  });

  sendHelloBtn.addEventListener('click', () => {
    void transmitHelloOverTxPath(root, diagEl);
  });

  if (SHOW_DEBUG_CONTROLS && debugStorageInput) {
    debugStorageInput.addEventListener('change', () => {
      if (!debugStorageInput.checked) return;
      maybeConsumeDebugHelloAck(diagEl);
    });
  }

  if (SHOW_DEBUG_CONTROLS && debugAckInput && debugAckProcessBtn) {
    debugAckProcessBtn.addEventListener('click', () => {
      const ackHex = debugAckInput.value.trim();
      if (!ackHex) {
        renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics, message: 'Enter HELLO_ACK hex for debug processing.' });
        return;
      }
      processHelloAckHex(diagEl, ackHex);
    });
  }
}

const root = document.querySelector<HTMLElement>('#app');
if (root) {
  mountSenderShell(root);
}
