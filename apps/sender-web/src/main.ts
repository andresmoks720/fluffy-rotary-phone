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
import { FRAME_TYPES, PROFILE_IDS, RETRY_LIMITS, TIMEOUTS_MS } from '../../../packages/contract/src/index.js';
import { crc32c } from '../../../packages/crc/src/index.js';
import { decodeFrame } from '../../../packages/protocol/src/index.js';
import { DEFAULT_SAFE_CARRIER_MODULATION, modulateSafeFrameWithPreambleToWaveform } from '../../../packages/phy-safe/src/index.js';
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
  nextTxStartTimeSec: number;
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
  txModulation: {
    carrierFrequencyHz: number;
    bandwidthHz: number;
  };

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
  // Historical filename; processor now powers runtime RX telemetry integration.
  new URL('meter_processor.js', window.location.href).toString()
] as const;

let senderRuntime: SenderRuntime | null = null;
let senderStartInFlight: Promise<void> | null = null;
let helloTransmitInFlight: Promise<void> | null = null;
let decodedRxEventListener: ((event: Event) => void) | null = null;
let senderDiagnosticsFrozen = false;
let senderDiagnosticsPendingSnapshot: string | null = null;
let senderDiagnosticsPendingStatusSnapshot: string | null = null;
let senderDiagnosticsActiveTab: 'status' | 'verbose' = 'status';
let senderVerboseLogEntries: string[] = [];
let senderLastLoggedTransferState: string | null = null;
let senderLastLoggedHandshakeResult: string | null = null;
let senderLastLoggedStatusMessage: string | null = null;
const senderHandshake = new LiveSenderHandshake();
let senderTransfer: LiveSenderTransfer | null = null;
let lastSeenAckHex: string | null = null;
let helloAckDeadlineMs: number | null = null;
let burstAckDeadlineMs: number | null = null;
let finalDeadlineMs: number | null = null;
let pendingHelloBytes: Uint8Array | null = null;
const senderHarnessDiagnostics: SenderHarnessDiagnostics = {
  txModulation: {
    carrierFrequencyHz: DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz,
    bandwidthHz: 2000
  },
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

function appendSenderVerboseLog(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const payload = data === undefined ? '' : `\n${JSON.stringify(data, null, 2)}`;
  senderVerboseLogEntries.push(`[${timestamp}] ${message}${payload}`.trimEnd());
  if (senderVerboseLogEntries.length > 80) {
    senderVerboseLogEntries = senderVerboseLogEntries.slice(senderVerboseLogEntries.length - 80);
  }
}

function buildSenderStatusSnapshot(data: unknown): Record<string, unknown> {
  return {
    senderState: senderHarnessDiagnostics.transfer.state,
    state: senderHarnessDiagnostics.transfer.state,
    handshakeResult: senderHarnessDiagnostics.handshakeResult,
    handshakeReason: senderHarnessDiagnostics.handshakeReason,
    sessionId: senderHarnessDiagnostics.handshakeSessionId,
    turnOwner: senderHarnessDiagnostics.currentTurnOwner,
    startupStage: senderHarnessDiagnostics.runtimeStartup.stage,
    runtimeStartup: senderHarnessDiagnostics.runtimeStartup,
    lastFailureReason: senderHarnessDiagnostics.lastFailureReason,
    failure: senderHarnessDiagnostics.transfer.failure,
    counters: senderHarnessDiagnostics.transfer.counters,
    timing: senderHarnessDiagnostics.transfer.timing,
    bytesConfirmed: senderHarnessDiagnostics.transferBytesConfirmed,
    frameTransmitAttempts: senderHarnessDiagnostics.frameTransmitAttempts,
    invalidTurnEvents: senderHarnessDiagnostics.invalidTurnEvents,
    clipboard: typeof data === 'object' && data !== null && 'clipboard' in data
      ? (data as { clipboard?: unknown }).clipboard
      : null,
    note: typeof data === 'object' && data !== null && 'message' in data
      ? (data as { message?: unknown }).message
      : null,
    error: typeof data === 'object' && data !== null && 'error' in data
      ? (data as { error?: unknown }).error
      : null
  };
}

function buildSenderVerboseSnapshot(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) {
    return data;
  }

  const source = data as Record<string, unknown>;
  const verboseSnapshot: Record<string, unknown> = {};

  if (typeof source.message === 'string') verboseSnapshot.message = source.message;
  if (typeof source.error === 'string') verboseSnapshot.error = source.error;
  if (source.clipboard !== undefined) verboseSnapshot.clipboard = source.clipboard;
  if (source.audioContextState !== undefined) verboseSnapshot.audioContextState = source.audioContextState;
  if (source.linkTiming !== undefined) verboseSnapshot.linkTiming = source.linkTiming;
  if (source.testTone !== undefined) verboseSnapshot.testTone = source.testTone;
  if (source.runtime !== undefined) verboseSnapshot.runtime = source.runtime;
  if (source.input !== undefined) verboseSnapshot.input = source.input;
  if (source.decodedRxEvent !== undefined) verboseSnapshot.decodedRxEvent = source.decodedRxEvent;

  return verboseSnapshot;
}

function renderSenderLiveStats(root: ParentNode, levels: AudioLevelSummary | null): void {
  const statsEl = root.querySelector<HTMLElement>('#sender-live-stats');
  if (!statsEl) return;

  const counters = senderHarnessDiagnostics.transfer.counters;
  const elapsedSec = senderHarnessDiagnostics.transfer.elapsedMs / 1000;
  const goodputBps = elapsedSec > 0
    ? Math.round((senderHarnessDiagnostics.transferBytesConfirmed * 8) / elapsedSec)
    : 0;
  const levelRms = levels?.rms ?? 0;
  const levelPeak = levels?.peakAbs ?? 0;
  const acceptedSpeedBps = senderHarnessDiagnostics.handshakeResult === 'accepted'
    ? Math.round((senderHarnessDiagnostics.transferBytesConfirmed / Math.max(elapsedSec, 1e-6)))
    : 0;

  statsEl.textContent = [
    `RX volume RMS: ${levelRms.toFixed(4)} | Peak: ${levelPeak.toFixed(4)}`,
    `Elapsed: ${elapsedSec.toFixed(2)} s | Goodput: ${goodputBps} bps | Accepted speed: ${acceptedSpeedBps} B/s`,
    `Frames TX/RX: ${counters.framesTx}/${counters.framesRx} | Bursts TX/RX: ${counters.burstsTx}/${counters.burstsRx}`,
    `Retransmissions: ${counters.retransmissions} | Timeouts (HELLO/BURST/FINAL): ${counters.timeoutsHelloAck}/${counters.timeoutsBurstAck}/${counters.timeoutsFinal}`,
    `CRC failures (header/payload): ${counters.crcFailuresHeader}/${counters.crcFailuresPayload} | Decode failures: ${counters.decodeFailures}`,
    `State: ${senderHarnessDiagnostics.transfer.state} | Session: ${senderHarnessDiagnostics.handshakeSessionId ?? 'none'} | Handshake: ${senderHarnessDiagnostics.handshakeResult}`,
    `Safe PHY: carrier=${DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz}Hz samplesPerChip=${DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip} amp=${DEFAULT_SAFE_CARRIER_MODULATION.amplitude.toFixed(2)} (tx/rx locked)`
  ].join('\n');
}

function renderDiagnostics(el: HTMLElement, data: unknown): void {
  const statusSnapshot = JSON.stringify(buildSenderStatusSnapshot(data), null, 2);
  const levels = typeof data === 'object' && data !== null && 'levels' in data
    ? ((data as { levels?: AudioLevelSummary | null }).levels ?? null)
    : null;
  const verboseEl = document.querySelector<HTMLElement>('#sender-diag-verbose');
  if (!verboseEl) {
    return;
  }

  const message = typeof data === 'object' && data !== null && 'message' in data ? (data as { message?: unknown }).message : null;
  const error = typeof data === 'object' && data !== null && 'error' in data ? (data as { error?: unknown }).error : null;
  const transferState = senderHarnessDiagnostics.transfer.state;
  const handshakeResult = senderHarnessDiagnostics.handshakeResult;
  if (transferState !== senderLastLoggedTransferState) {
    appendSenderVerboseLog(`Transfer state changed: ${senderLastLoggedTransferState ?? 'unset'} -> ${transferState}`);
    senderLastLoggedTransferState = transferState;
  }
  if (handshakeResult !== senderLastLoggedHandshakeResult) {
    appendSenderVerboseLog(`Handshake result changed: ${senderLastLoggedHandshakeResult ?? 'unset'} -> ${handshakeResult}`);
    senderLastLoggedHandshakeResult = handshakeResult;
  }
  const verboseEventData = buildSenderVerboseSnapshot(data);
  if (typeof message === 'string' && message.length > 0 && message !== senderLastLoggedStatusMessage) {
    appendSenderVerboseLog(`Status: ${message}`, verboseEventData);
    senderLastLoggedStatusMessage = message;
  }
  if (typeof error === 'string' && error.length > 0) {
    appendSenderVerboseLog(`Error: ${error}`, verboseEventData);
  }

  if (senderDiagnosticsFrozen) {
    senderDiagnosticsPendingStatusSnapshot = statusSnapshot;
    senderDiagnosticsPendingSnapshot = senderVerboseLogEntries.join('\n\n');
    return;
  }
  el.textContent = statusSnapshot;
  verboseEl.textContent = senderVerboseLogEntries.join('\n\n');
  renderSenderLiveStats(document, levels);
}

async function ensureAudioContextRunning(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'running') {
    return;
  }
  await ctx.resume();
}

function setSenderDiagnosticsTab(root: HTMLElement, tab: 'status' | 'verbose'): void {
  senderDiagnosticsActiveTab = tab;
  const statusTabButton = root.querySelector<HTMLButtonElement>('#sender-diag-tab-status');
  const verboseTabButton = root.querySelector<HTMLButtonElement>('#sender-diag-tab-verbose');
  const statusPanel = root.querySelector<HTMLElement>('#sender-diag-panel-status');
  const verbosePanel = root.querySelector<HTMLElement>('#sender-diag-panel-verbose');
  if (statusTabButton) statusTabButton.disabled = tab === 'status';
  if (verboseTabButton) verboseTabButton.disabled = tab === 'verbose';
  if (statusPanel) statusPanel.hidden = tab !== 'status';
  if (verbosePanel) verbosePanel.hidden = tab !== 'verbose';
}

function setSenderDiagnosticsFrozen(root: HTMLElement, frozen: boolean): void {
  senderDiagnosticsFrozen = frozen;
  const freezeBtn = root.querySelector<HTMLButtonElement>('#sender-diag-freeze-toggle');
  const statusEl = root.querySelector<HTMLElement>('#sender-diag-freeze-status');
  if (freezeBtn) {
    freezeBtn.textContent = frozen ? 'Resume diagnostics' : 'Freeze diagnostics';
  }
  if (statusEl) {
    statusEl.textContent = frozen
      ? 'Diagnostics frozen (snapshot locked for copy).' : 'Diagnostics live (auto-updating).';
  }
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', 'true');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(fallback);
  if (!copied) {
    throw new Error('Clipboard API unavailable and copy command failed.');
  }
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
  pendingHelloBytes = null;
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
  senderLastLoggedTransferState = null;
  senderLastLoggedHandshakeResult = null;
}


function prepareForHelloAttempt(): void {
  senderHandshake.reset();
  senderTransfer = null;
  lastSeenAckHex = null;
  helloAckDeadlineMs = null;
  burstAckDeadlineMs = null;
  finalDeadlineMs = null;
  pendingHelloBytes = null;
  senderHarnessDiagnostics.transfer = createInitialLiveDiagnostics({ state: 'HELLO_TX', currentTurnOwner: 'sender' });
  senderHarnessDiagnostics.handshakeSessionId = null;
  senderHarnessDiagnostics.currentTurnOwner = 'sender';
  senderHarnessDiagnostics.handshakeResult = 'pending';
  senderHarnessDiagnostics.handshakeReason = null;
  senderHarnessDiagnostics.transferBytesConfirmed = 0;
  senderHarnessDiagnostics.lastFailureReason = null;
  senderHarnessDiagnostics.transfer.failure.category = 'none';
  senderHarnessDiagnostics.transfer.failure.reason = null;
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
  const transferState = senderHarnessDiagnostics.transfer.state;
  const stateIsHandshakeOwned = transferState === 'IDLE'
    || transferState === 'HELLO_TX'
    || transferState === 'WAIT_HELLO_ACK';
  if (stateIsHandshakeOwned) {
    senderHarnessDiagnostics.transfer.state = handshake.result === 'pending'
      ? 'WAIT_HELLO_ACK'
      : handshake.result === 'accepted'
        ? 'SEND_BURST'
        : 'FAILED';
  }
  if (handshake.result === 'rejected') {
    senderHarnessDiagnostics.transfer.failure.category = 'remote_reject';
    senderHarnessDiagnostics.transfer.failure.reason = handshake.reason;
  } else if (senderHarnessDiagnostics.transfer.failure.category === 'remote_reject') {
    senderHarnessDiagnostics.transfer.failure.category = 'none';
    senderHarnessDiagnostics.transfer.failure.reason = null;
  }
}

function playFrameOverTxPath(runtime: SenderRuntime, frameBytes: Uint8Array): void {
  if (runtime.ctx.state !== 'running') {
    void ensureAudioContextRunning(runtime.ctx);
  }
  const waveform = modulateSafeFrameWithPreambleToWaveform(frameBytes, runtime.ctx.sampleRate, {
    carrierFrequencyHz: DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz,
    samplesPerChip: DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip,
    amplitude: DEFAULT_SAFE_CARRIER_MODULATION.amplitude
  });
  senderHarnessDiagnostics.txModulation.carrierFrequencyHz = DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz;
  senderHarnessDiagnostics.txModulation.bandwidthHz = Math.round(runtime.ctx.sampleRate / DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip);
  const output = runtime.ctx.createBuffer(1, waveform.length, runtime.ctx.sampleRate);
  const channel = output.getChannelData(0);
  channel.set(waveform);

  const source = runtime.ctx.createBufferSource();
  source.buffer = output;
  source.connect(runtime.graph.txGain);
  const frameDurationSec = waveform.length / runtime.ctx.sampleRate;
  const scheduleFloorSec = runtime.ctx.currentTime + 0.005;
  const startTimeSec = Math.max(scheduleFloorSec, runtime.nextTxStartTimeSec);
  source.start(startTimeSec);
  runtime.nextTxStartTimeSec = startTimeSec + frameDurationSec;
  source.onended = () => {
    source.disconnect();
  };
}

function transmitFrames(frames: readonly Uint8Array[], root: HTMLElement): void {
  if (!senderRuntime || frames.length === 0) return;
  for (const frame of frames) {
    playFrameOverTxPath(senderRuntime, frame);
  }
  senderHarnessDiagnostics.transfer.counters.framesTx += frames.length;
}

async function transmitHelloOverTxPath(root: HTMLElement, diagEl: HTMLElement): Promise<void> {
  if (helloTransmitInFlight) {
    renderDiagnostics(diagEl, {
      harness: senderHarnessDiagnostics,
      message: 'HELLO transmit request ignored because a previous HELLO attempt is still preparing.'
    });
    return;
  }

  const transmitPromise = (async () => {
  if (!senderRuntime) {
    const stateEl = root.querySelector<HTMLElement>('#sender-state');
    if (!stateEl) {
      throw new Error('Missing sender state element');
    }
    await startSender(root, stateEl, diagEl);
  }

  if (!senderRuntime) {
    setDiagnosticsFailure('input_validation', 'Unable to start sender runtime before transmitting HELLO.');
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
    prepareForHelloAttempt();
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

    pendingHelloBytes = helloBytes;
    playFrameOverTxPath(senderRuntime, helloBytes);
    senderHarnessDiagnostics.transfer.counters.framesTx += 1;
    senderHarnessDiagnostics.lastFailureReason = null;
    senderHarnessDiagnostics.transfer.failure.category = 'none';
    senderHarnessDiagnostics.transfer.failure.reason = null;
    senderHarnessDiagnostics.lastTransmittedFrameHex = toHex(helloBytes);
    helloAckDeadlineMs = Date.now() + TIMEOUTS_MS.HELLO_ACK;

    updateHandshakeDiagnostics();
    renderDiagnostics(diagEl, {
      harness: senderHarnessDiagnostics,
      message: `HELLO transmitted over live TX path; waiting for decoder event ${SENDER_DECODED_RX_EVENT}.`
    });
  } catch (error) {
    setDiagnosticsFailure('unknown', String(error));
    renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics });
  }
  })();

  helloTransmitInFlight = transmitPromise;
  try {
    await transmitPromise;
  } finally {
    if (helloTransmitInFlight === transmitPromise) {
      helloTransmitInFlight = null;
    }
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
    pendingHelloBytes = null;
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
          transmitFrames(step.txFrames, document.body);
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
    transmitFrames(result.txFrames, document.body);
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
      await ensureAudioContextRunning(ctx);
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
        if (pendingHelloBytes !== null && senderHarnessDiagnostics.transfer.counters.timeoutsHelloAck <= RETRY_LIMITS.HELLO) {
          senderHarnessDiagnostics.transfer.counters.retransmissions += 1;
          playFrameOverTxPath(senderRuntime, pendingHelloBytes);
          senderHarnessDiagnostics.transfer.counters.framesTx += 1;
          senderHarnessDiagnostics.transfer.failure.category = 'timeout';
          senderHarnessDiagnostics.transfer.failure.reason = 'HELLO_ACK timeout in live sender shell; HELLO retransmitted.';
          helloAckDeadlineMs = Date.now() + TIMEOUTS_MS.HELLO_ACK;
        } else {
          senderHarnessDiagnostics.transfer.state = 'FAILED';
          senderHarnessDiagnostics.transfer.failure.category = 'timeout';
          senderHarnessDiagnostics.transfer.failure.reason = 'HELLO_ACK retry limit reached in live sender shell.';
          helloAckDeadlineMs = null;
          pendingHelloBytes = null;
        }
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
        transmitFrames(retry.txFrames, document.body);
        burstAckDeadlineMs = retry.failed ? null : Date.now() + TIMEOUTS_MS.BURST_ACK;
        if (retry.failed) {
          senderHarnessDiagnostics.transfer.state = 'FAILED';
        }
      }
      if (finalDeadlineMs !== null && Date.now() >= finalDeadlineMs && senderTransfer) {
        senderHarnessDiagnostics.transfer.counters.timeoutsFinal += 1;
        const retry = senderTransfer.onFinalTimeout();
        transmitFrames(retry.txFrames, document.body);
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
        audioContextState: ctx.state,
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

      senderRuntime = {
        stream,
        ctx,
        graph,
        intervalId,
        timing,
        lastRecordedToneStartMs: null,
        nextTxStartTimeSec: ctx.currentTime + 0.005,
        startedAtMs: Date.now()
      };
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
        <label for="sender-carrier-frequency">TX carrier Hz (safe locked)</label>
        <input id="sender-carrier-frequency" type="number" min="200" max="8000" step="50" value="1500" disabled />
        <label for="sender-bandwidth">TX bandwidth Hz (safe locked)</label>
        <input id="sender-bandwidth" type="number" min="200" max="6000" step="50" value="2000" disabled />
        <button id="sender-send-hello" type="button">Send HELLO</button>
      </section>

      ${debugControls}

      <section>
        <h2>Live modem stats</h2>
        <pre id="sender-live-stats">Waiting for sender runtime.</pre>
      </section>

      <section>
        <h2>Diagnostics</h2>
        <p>Use status for stable state; use verbose log for full event history and troubleshooting.</p>
        <div>
          <button id="sender-diag-tab-status" type="button">Status</button>
          <button id="sender-diag-tab-verbose" type="button">Verbose log</button>
        </div>
        <p id="sender-diag-freeze-status">Diagnostics live (auto-updating).</p>
        <button id="sender-diag-freeze-toggle" type="button">Freeze diagnostics</button>
        <button id="sender-diag-copy" type="button">Copy diagnostics</button>
        <button id="sender-diag-copy-verbose" type="button">Copy verbose log</button>
        <section id="sender-diag-panel-status">
          <h3>Status snapshot</h3>
          <pre id="sender-diag">Diagnostics pending runtime initialization.</pre>
        </section>
        <section id="sender-diag-panel-verbose" hidden>
          <h3>Verbose event log</h3>
          <pre id="sender-diag-verbose">Verbose diagnostics pending runtime initialization.</pre>
        </section>
      </section>
    </main>
  `;

  const stateEl = root.querySelector<HTMLElement>('#sender-state');
  const diagEl = root.querySelector<HTMLElement>('#sender-diag');
  const startBtn = root.querySelector<HTMLButtonElement>('#sender-start');
  const cancelBtn = root.querySelector<HTMLButtonElement>('#sender-cancel');
  const toneBtn = root.querySelector<HTMLButtonElement>('#sender-tone-toggle');
  const sendHelloBtn = root.querySelector<HTMLButtonElement>('#sender-send-hello');
  const freezeDiagBtn = root.querySelector<HTMLButtonElement>('#sender-diag-freeze-toggle');
  const copyDiagBtn = root.querySelector<HTMLButtonElement>('#sender-diag-copy');
  const copyVerboseBtn = root.querySelector<HTMLButtonElement>('#sender-diag-copy-verbose');
  const statusTabBtn = root.querySelector<HTMLButtonElement>('#sender-diag-tab-status');
  const verboseTabBtn = root.querySelector<HTMLButtonElement>('#sender-diag-tab-verbose');
  const debugStorageInput = root.querySelector<HTMLInputElement>('#sender-debug-storage');
  const debugAckInput = root.querySelector<HTMLInputElement>('#sender-debug-ack-hex');
  const debugAckProcessBtn = root.querySelector<HTMLButtonElement>('#sender-debug-ack-process');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !toneBtn || !sendHelloBtn || !freezeDiagBtn || !copyDiagBtn || !copyVerboseBtn) {
    throw new Error('Missing sender shell elements');
  }

  senderVerboseLogEntries = [];
  senderLastLoggedStatusMessage = null;
  appendSenderVerboseLog('Sender shell mounted. Diagnostics initialized.');
  const verboseEl = root.querySelector<HTMLElement>('#sender-diag-verbose');
  if (verboseEl) {
    verboseEl.textContent = senderVerboseLogEntries.join('\n\n');
  }
  setSenderDiagnosticsTab(root, 'status');
  setSenderDiagnosticsFrozen(root, false);
  renderDiagnostics(diagEl, { harness: senderHarnessDiagnostics, message: 'Diagnostics initialized; waiting for sender actions.' });

  statusTabBtn?.addEventListener('click', () => {
    setSenderDiagnosticsTab(root, 'status');
  });
  verboseTabBtn?.addEventListener('click', () => {
    setSenderDiagnosticsTab(root, 'verbose');
  });

  freezeDiagBtn.addEventListener('click', () => {
    const nextFrozen = !senderDiagnosticsFrozen;
    setSenderDiagnosticsFrozen(root, nextFrozen);
    if (!nextFrozen) {
      if (senderDiagnosticsPendingStatusSnapshot !== null) {
        diagEl.textContent = senderDiagnosticsPendingStatusSnapshot;
        senderDiagnosticsPendingStatusSnapshot = null;
      }
      if (senderDiagnosticsPendingSnapshot !== null) {
        const verboseEl = root.querySelector<HTMLElement>('#sender-diag-verbose');
        if (verboseEl) {
          verboseEl.textContent = senderDiagnosticsPendingSnapshot;
        }
        senderDiagnosticsPendingSnapshot = null;
      }
    }
  });

  copyDiagBtn.addEventListener('click', () => {
    void (async () => {
      const snapshot = diagEl.textContent ?? '';
      try {
        await copyTextToClipboard(snapshot);
        renderDiagnostics(diagEl, {
          harness: senderHarnessDiagnostics,
          clipboard: {
            copiedDiagnosticsChars: snapshot.length,
            copiedTarget: 'status'
          },
          message: 'Diagnostics copied to clipboard.'
        });
      } catch (error) {
        renderDiagnostics(diagEl, {
          harness: senderHarnessDiagnostics,
          clipboard: {
            copiedDiagnosticsChars: 0,
            error: String(error)
          },
          message: 'Failed to copy diagnostics to clipboard.'
        });
      }
    })();
  });

  copyVerboseBtn.addEventListener('click', () => {
    void (async () => {
      const verboseSnapshot = root.querySelector<HTMLElement>('#sender-diag-verbose')?.textContent ?? '';
      try {
        await copyTextToClipboard(verboseSnapshot);
        renderDiagnostics(diagEl, {
          harness: senderHarnessDiagnostics,
          clipboard: {
            copiedDiagnosticsChars: verboseSnapshot.length,
            copiedTarget: 'verbose'
          },
          message: 'Verbose diagnostics copied to clipboard.'
        });
      } catch (error) {
        renderDiagnostics(diagEl, {
          harness: senderHarnessDiagnostics,
          clipboard: {
            copiedDiagnosticsChars: 0,
            copiedTarget: 'verbose',
            error: String(error)
          },
          message: 'Failed to copy verbose diagnostics to clipboard.'
        });
      }
    })();
  });

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

        await ensureAudioContextRunning(senderRuntime.ctx);
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
