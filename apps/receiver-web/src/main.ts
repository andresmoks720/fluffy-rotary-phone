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
import { FRAME_TYPES } from '../../../packages/contract/src/index.js';
import { decodeFrame } from '../../../packages/protocol/src/index.js';
import {
  DEFAULT_SAFE_CARRIER_MODULATION,
  demodulateSafeBpsk,
  detectSafePreamble,
  generateSafePreamble,
  modulateSafeBpskToWaveform
} from '../../../packages/phy-safe/src/index.js';
import {
  createInitialLiveDiagnostics,
  decodeLiveFrameHex,
  LiveReceiverHandshake,
  LiveReceiverTransfer,
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
  readonly startupSource: string;
}

interface DecodedRxFrameEventDetail {
  readonly frameHex: string;
  readonly frameType?: string;
  readonly classification?: 'ok' | 'decode_error' | 'header_crc_failure' | 'payload_crc_failure' | 'timeout' | 'retry';
}

function normalizeDecodedFrameType(frameType: string | undefined): string | undefined {
  if (frameType === 'HEADER') {
    return 'HELLO';
  }
  return frameType;
}

interface ReceiverHandshakeDiagnostics {
  transfer: LiveDiagnosticsModel;
  transferBytesSaved: number;
  invalidTurnEvents: number;
  sessionId: number | null;
  currentTurnOwner: 'sender' | 'receiver';
  handshakeResult: 'pending' | 'accepted' | 'rejected';
  handshakeReason: string | null;
  processedHelloCount: number;
  lastFailureReason: string | null;
  runtimeStartup: {
    attempts: number;
    stage: 'idle' | 'request_mic' | 'init_audio_context' | 'register_worklet' | 'create_audio_graph' | 'ready' | 'failed';
    lastAttemptAtMs: number | null;
    lastSuccessAtMs: number | null;
    workletModuleCandidates: readonly string[];
    workletModuleSelected: string | null;
    workletModuleErrors: readonly string[];
    lastError: string | null;
    lastTriggerSource: string | null;
  };
  rxPipeline: {
    rxPipelineStage: 'meter_only' | 'detector_attached' | 'demod_attached' | 'decoder_attached' | 'parser_bridge_attached';
    rxProcessorRole: 'meter' | 'rx_pipeline';
    preambleDetectorHits: number;
    candidateFrameCount: number;
    demodAttempts: number;
    parserInvocations: number;
    helloFramesSeen: number;
    channelPolicy: 'downmix_to_mono';
    warning: string | null;
  };
}

const SHOW_DEBUG_CONTROLS = new URLSearchParams(window.location.search).get('debug') === '1';
const LIVE_HELLO_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-hello-hex';
const LIVE_HELLO_ACK_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-hello-ack-hex';
const RECEIVER_DECODED_RX_EVENT = 'fluffy-rotary-phone:receiver-decoded-rx-frame';
const RX_ACTIVITY_WARNING_AFTER_MS = 3000;
const RX_ACTIVITY_WARNING_RMS_THRESHOLD = 0.01;
const RECEIVER_WORKLET_MODULE_CANDIDATES = [
  new URL('meter_processor.js', window.location.href).toString()
] as const;

let receiverRuntime: ReceiverRuntime | null = null;
let receiverStartInFlight: Promise<void> | null = null;
let decodedRxEventListener: ((event: Event) => void) | null = null;
let receiverDiagnosticsFrozen = false;
let receiverDiagnosticsPendingSnapshot: string | null = null;
let receiverDiagnosticsPendingStatusSnapshot: string | null = null;
let receiverDiagnosticsActiveTab: 'status' | 'verbose' = 'status';
let receiverVerboseLogEntries: string[] = [];
let receiverLastLoggedTransferState: string | null = null;
let receiverLastLoggedHandshakeResult: string | null = null;
let receiverLastLoggedStatusMessage: string | null = null;
const receiverHandshake = new LiveReceiverHandshake();
let receiverTransfer: LiveReceiverTransfer | null = null;
let lastFinalResponseHex: string | null = null;
let lastSeenHelloHex: string | null = null;
let lastCapture: {
  readonly samples: readonly number[];
  readonly levels: AudioLevelSummary;
} | null = null;
let waveformDebugBuffer: readonly WaveformDebugEntry[] = [];
let lastPipelineFrameHex: string | null = null;
const handshakeDiagnostics: ReceiverHandshakeDiagnostics = {
  transfer: createInitialLiveDiagnostics({ state: 'LISTEN', currentTurnOwner: 'sender' }),
  sessionId: null,
  currentTurnOwner: 'sender',
  handshakeResult: 'pending',
  handshakeReason: null,
  processedHelloCount: 0,
  lastFailureReason: null,
  transferBytesSaved: 0,
  invalidTurnEvents: 0,
  runtimeStartup: {
    attempts: 0,
    stage: 'idle',
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    workletModuleCandidates: RECEIVER_WORKLET_MODULE_CANDIDATES,
    workletModuleSelected: null,
    workletModuleErrors: [],
    lastError: null,
    lastTriggerSource: null
  },
  rxPipeline: {
    rxPipelineStage: 'meter_only',
    rxProcessorRole: 'meter',
    preambleDetectorHits: 0,
    candidateFrameCount: 0,
    demodAttempts: 0,
    parserInvocations: 0,
    helloFramesSeen: 0,
    channelPolicy: 'downmix_to_mono',
    warning: null
  }
};

function appendReceiverVerboseLog(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const payload = data === undefined ? '' : `\n${JSON.stringify(data, null, 2)}`;
  receiverVerboseLogEntries.push(`[${timestamp}] ${message}${payload}`.trimEnd());
  if (receiverVerboseLogEntries.length > 80) {
    receiverVerboseLogEntries = receiverVerboseLogEntries.slice(receiverVerboseLogEntries.length - 80);
  }
}

function buildReceiverStatusSnapshot(data: unknown): Record<string, unknown> {
  const source = (typeof data === 'object' && data !== null) ? data as Record<string, unknown> : {};
  return {
    receiverState: handshakeDiagnostics.transfer.state,
    state: handshakeDiagnostics.transfer.state,
    handshakeResult: handshakeDiagnostics.handshakeResult,
    handshakeReason: handshakeDiagnostics.handshakeReason,
    sessionId: handshakeDiagnostics.sessionId,
    turnOwner: handshakeDiagnostics.currentTurnOwner,
    startupStage: handshakeDiagnostics.runtimeStartup.stage,
    runtimeStartup: handshakeDiagnostics.runtimeStartup,
    lastFailureReason: handshakeDiagnostics.lastFailureReason,
    failure: handshakeDiagnostics.transfer.failure,
    counters: handshakeDiagnostics.transfer.counters,
    timing: handshakeDiagnostics.transfer.timing,
    runtime: source.runtime ?? null,
    input: source.input ?? null,
    levels: source.levels ?? null,
    graph: source.graph ?? null,
    audioContextState: source.audioContextState ?? null,
    linkTiming: source.linkTiming ?? null,
    rxCapture: source.rxCapture ?? null,
    waveformDebug: source.waveformDebug ?? null,
    decodedRxEvent: source.decodedRxEvent ?? RECEIVER_DECODED_RX_EVENT,
    bytesSaved: handshakeDiagnostics.transferBytesSaved,
    invalidTurnEvents: handshakeDiagnostics.invalidTurnEvents,
    processedHelloCount: handshakeDiagnostics.processedHelloCount,
    rxPipeline: handshakeDiagnostics.rxPipeline,
    lastFinalResponseHex: source.lastFinalResponseHex ?? lastFinalResponseHex,
    clipboard: source.clipboard ?? null,
    note: source.message ?? null,
    error: source.error ?? null
  };
}

function detectExpectedFrameLength(bytes: Uint8Array): number | null {
  if (bytes.length < 2) return null;
  const frameType = bytes[1];
  if (frameType === undefined) return null;
  if (frameType === FRAME_TYPES.HELLO) {
    if (bytes.length < 34) return null;
    const fileNameLen = (bytes[28] ?? 0) * 256 + (bytes[29] ?? 0);
    return 30 + fileNameLen + 4;
  }
  if (frameType === FRAME_TYPES.DATA) {
    if (bytes.length < 24) return null;
    const payloadLen = (bytes[18] ?? 0) * 256 + (bytes[19] ?? 0);
    return 24 + payloadLen + 4;
  }
  if (frameType === FRAME_TYPES.END) {
    return 28;
  }
  return null;
}

function inferFrameTypeName(frameType: number): string {
  if (frameType === FRAME_TYPES.HELLO) return 'HELLO';
  if (frameType === FRAME_TYPES.DATA) return 'DATA';
  if (frameType === FRAME_TYPES.END) return 'END';
  return `UNKNOWN_${frameType}`;
}

function runReceiverDecodePipeline(samples: Float32Array, sampleRateHz: number): DecodedRxFrameEventDetail | null {
  const preamble = generateSafePreamble();
  const samplesPerChip = DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip;
  handshakeDiagnostics.rxPipeline.rxPipelineStage = 'detector_attached';
  handshakeDiagnostics.rxPipeline.rxProcessorRole = 'rx_pipeline';
  if (samples.length < samplesPerChip * (preamble.length + 8)) {
    return null;
  }

  const chipCount = Math.floor(samples.length / samplesPerChip);
  const chips = new Float32Array(chipCount);
  for (let chipIndex = 0; chipIndex < chipCount; chipIndex += 1) {
    let sum = 0;
    for (let sampleOffset = 0; sampleOffset < samplesPerChip; sampleOffset += 1) {
      const sampleIndex = chipIndex * samplesPerChip + sampleOffset;
      const sample = samples[sampleIndex] ?? 0;
      const phase = (2 * Math.PI * DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz * sampleIndex) / sampleRateHz;
      sum += sample * Math.sin(phase);
    }
    chips[chipIndex] = sum >= 0 ? 1 : -1;
  }

  const hit = detectSafePreamble(chips, 0.92);
  if (!hit) {
    return null;
  }

  handshakeDiagnostics.rxPipeline.preambleDetectorHits += 1;
  handshakeDiagnostics.rxPipeline.rxPipelineStage = 'demod_attached';
  const dataChips = chips.subarray(hit.index + preamble.length);
  const fullBytes = Math.floor(dataChips.length / 8);
  if (fullBytes < 20) {
    return null;
  }

  handshakeDiagnostics.rxPipeline.candidateFrameCount += 1;
  handshakeDiagnostics.rxPipeline.demodAttempts += 1;
  let rawBytes: Uint8Array;
  try {
    rawBytes = demodulateSafeBpsk(dataChips.subarray(0, fullBytes * 8));
  } catch {
    return { frameHex: '', classification: 'decode_error' };
  }

  handshakeDiagnostics.rxPipeline.rxPipelineStage = 'decoder_attached';
  const expectedLength = detectExpectedFrameLength(rawBytes);
  if (expectedLength === null || rawBytes.length < expectedLength) {
    return null;
  }

  const frameBytes = rawBytes.subarray(0, expectedLength);
  handshakeDiagnostics.rxPipeline.parserInvocations += 1;
  handshakeDiagnostics.rxPipeline.rxPipelineStage = 'parser_bridge_attached';
  try {
    const decoded = decodeFrame(frameBytes, { expectedTurnOwner: 'sender' });
    if (decoded.frameType === FRAME_TYPES.HELLO) {
      handshakeDiagnostics.rxPipeline.helloFramesSeen += 1;
    }
    return {
      frameHex: toHex(frameBytes),
      frameType: inferFrameTypeName(decoded.frameType),
      classification: 'ok'
    };
  } catch {
    return {
      frameHex: toHex(frameBytes),
      frameType: inferFrameTypeName(frameBytes[1] ?? 0),
      classification: 'decode_error'
    };
  }
}

function updateRxPipelineWarning(levels: AudioLevelSummary): void {
  const elapsed = handshakeDiagnostics.transfer.elapsedMs;
  const hasActivity = handshakeDiagnostics.rxPipeline.preambleDetectorHits > 0
    || handshakeDiagnostics.rxPipeline.candidateFrameCount > 0
    || handshakeDiagnostics.rxPipeline.demodAttempts > 0
    || handshakeDiagnostics.rxPipeline.parserInvocations > 0;
  if (elapsed >= RX_ACTIVITY_WARNING_AFTER_MS && levels.rms >= RX_ACTIVITY_WARNING_RMS_THRESHOLD && !hasActivity) {
    handshakeDiagnostics.rxPipeline.warning = 'audio present but no decode pipeline activity';
    return;
  }
  handshakeDiagnostics.rxPipeline.warning = null;
}

function buildReceiverVerboseSnapshot(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) {
    return data;
  }
  const source = data as Record<string, unknown>;
  const verboseSnapshot: Record<string, unknown> = {};
  if (typeof source.message === 'string') verboseSnapshot.message = source.message;
  if (typeof source.error === 'string') verboseSnapshot.error = source.error;
  if (source.runtime !== undefined) verboseSnapshot.runtime = source.runtime;
  if (source.input !== undefined) verboseSnapshot.input = source.input;
  if (source.levels !== undefined) verboseSnapshot.levels = source.levels;
  if (source.audioContextState !== undefined) verboseSnapshot.audioContextState = source.audioContextState;
  if (source.linkTiming !== undefined) verboseSnapshot.linkTiming = source.linkTiming;
  if (source.rxCapture !== undefined) verboseSnapshot.rxCapture = source.rxCapture;
  if (source.waveformDebug !== undefined) verboseSnapshot.waveformDebug = source.waveformDebug;
  if (source.decodedRxEvent !== undefined) verboseSnapshot.decodedRxEvent = source.decodedRxEvent;
  if (source.graph !== undefined) verboseSnapshot.graph = source.graph;
  if (source.clipboard !== undefined) verboseSnapshot.clipboard = source.clipboard;
  if (source.handshake !== undefined) verboseSnapshot.handshake = source.handshake;
  if (source.transfer !== undefined) verboseSnapshot.transfer = source.transfer;
  if (source.decodedFrame !== undefined) verboseSnapshot.decodedFrame = source.decodedFrame;
  if (source.transferFrame !== undefined) verboseSnapshot.transferFrame = source.transferFrame;
  return verboseSnapshot;
}

function setReceiverDiagnosticsTab(root: HTMLElement, tab: 'status' | 'verbose'): void {
  receiverDiagnosticsActiveTab = tab;
  const statusTabButton = root.querySelector<HTMLButtonElement>('#receiver-diag-tab-status');
  const verboseTabButton = root.querySelector<HTMLButtonElement>('#receiver-diag-tab-verbose');
  const statusPanel = root.querySelector<HTMLElement>('#receiver-diag-panel-status');
  const verbosePanel = root.querySelector<HTMLElement>('#receiver-diag-panel-verbose');
  if (statusTabButton) statusTabButton.disabled = tab === 'status';
  if (verboseTabButton) verboseTabButton.disabled = tab === 'verbose';
  if (statusPanel) statusPanel.hidden = tab !== 'status';
  if (verbosePanel) verbosePanel.hidden = tab !== 'verbose';
}

function setReceiverDiagnosticsFrozen(root: HTMLElement, frozen: boolean): void {
  receiverDiagnosticsFrozen = frozen;
  const freezeBtn = root.querySelector<HTMLButtonElement>('#receiver-diag-freeze-toggle');
  const statusEl = root.querySelector<HTMLElement>('#receiver-diag-freeze-status');
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

function renderDiagnostics(el: HTMLElement, data: unknown): void {
  const statusSnapshot = JSON.stringify(buildReceiverStatusSnapshot(data), null, 2);
  const verboseEl = document.querySelector<HTMLElement>('#receiver-diag-verbose');
  if (!verboseEl) {
    return;
  }

  const message = typeof data === 'object' && data !== null && 'message' in data ? (data as { message?: unknown }).message : null;
  const error = typeof data === 'object' && data !== null && 'error' in data ? (data as { error?: unknown }).error : null;
  const transferState = handshakeDiagnostics.transfer.state;
  const handshakeResult = handshakeDiagnostics.handshakeResult;
  if (transferState !== receiverLastLoggedTransferState) {
    appendReceiverVerboseLog(`Transfer state changed: ${receiverLastLoggedTransferState ?? 'unset'} -> ${transferState}`);
    receiverLastLoggedTransferState = transferState;
  }
  if (handshakeResult !== receiverLastLoggedHandshakeResult) {
    appendReceiverVerboseLog(`Handshake result changed: ${receiverLastLoggedHandshakeResult ?? 'unset'} -> ${handshakeResult}`);
    receiverLastLoggedHandshakeResult = handshakeResult;
  }
  const verboseEventData = buildReceiverVerboseSnapshot(data);
  if (typeof message === 'string' && message.length > 0 && message !== receiverLastLoggedStatusMessage) {
    appendReceiverVerboseLog(`Status: ${message}`, verboseEventData);
    receiverLastLoggedStatusMessage = message;
  }
  if (typeof error === 'string' && error.length > 0) {
    appendReceiverVerboseLog(`Error: ${error}`, verboseEventData);
  }

  if (receiverDiagnosticsFrozen) {
    receiverDiagnosticsPendingStatusSnapshot = statusSnapshot;
    receiverDiagnosticsPendingSnapshot = receiverVerboseLogEntries.join('\n\n');
    return;
  }
  el.textContent = statusSnapshot;
  verboseEl.textContent = receiverVerboseLogEntries.join('\n\n');
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


function readTxCarrierFrequency(root: HTMLElement): number {
  const input = root.querySelector<HTMLInputElement>('#receiver-carrier-frequency');
  const fallback = DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz;
  if (!input) return fallback;
  const parsed = Number(input.value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(8000, Math.max(200, parsed));
}

function readTxBandwidth(root: HTMLElement): number {
  const input = root.querySelector<HTMLInputElement>('#receiver-bandwidth');
  if (!input) return 2000;
  const parsed = Number(input.value);
  if (!Number.isFinite(parsed)) return 2000;
  return Math.min(6000, Math.max(200, parsed));
}

function deriveSamplesPerChip(sampleRateHz: number, bandwidthHz: number): number {
  const raw = Math.round(sampleRateHz / bandwidthHz);
  return Math.min(256, Math.max(4, raw));
}

function playFrameOverTxPath(runtime: ReceiverRuntime, frameBytes: Uint8Array, root: HTMLElement): void {
  const carrierFrequencyHz = readTxCarrierFrequency(root);
  const bandwidthHz = readTxBandwidth(root);
  const chipSamples = deriveSamplesPerChip(runtime.ctx.sampleRate, bandwidthHz);
  const waveform = modulateSafeBpskToWaveform(frameBytes, runtime.ctx.sampleRate, {
    carrierFrequencyHz,
    samplesPerChip: chipSamples,
    amplitude: DEFAULT_SAFE_CARRIER_MODULATION.amplitude
  });
  const output = runtime.ctx.createBuffer(1, waveform.length, runtime.ctx.sampleRate);
  const channel = output.getChannelData(0);
  channel.set(waveform);

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

async function registerReceiverWorklet(ctx: AudioContext): Promise<void> {
  const errors: string[] = [];
  for (const moduleUrl of RECEIVER_WORKLET_MODULE_CANDIDATES) {
    try {
      await registerWorklet(ctx, moduleUrl);
      handshakeDiagnostics.runtimeStartup.workletModuleSelected = moduleUrl;
      handshakeDiagnostics.runtimeStartup.workletModuleErrors = errors;
      return;
    } catch (error) {
      errors.push(`${moduleUrl}: ${String(error)}`);
    }
  }

  handshakeDiagnostics.runtimeStartup.workletModuleErrors = errors;
  throw new Error(`Unable to register receiver worklet. Attempted modules: ${errors.join(' | ')}`);
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
  handshakeDiagnostics.transferBytesSaved = 0;
  handshakeDiagnostics.invalidTurnEvents = 0;
  receiverLastLoggedTransferState = null;
  receiverLastLoggedHandshakeResult = null;
  receiverLastLoggedStatusMessage = null;
  receiverTransfer = null;
  lastFinalResponseHex = null;
  handshakeDiagnostics.rxPipeline.rxPipelineStage = 'meter_only';
  handshakeDiagnostics.rxPipeline.rxProcessorRole = 'meter';
  handshakeDiagnostics.rxPipeline.preambleDetectorHits = 0;
  handshakeDiagnostics.rxPipeline.candidateFrameCount = 0;
  handshakeDiagnostics.rxPipeline.demodAttempts = 0;
  handshakeDiagnostics.rxPipeline.parserInvocations = 0;
  handshakeDiagnostics.rxPipeline.helloFramesSeen = 0;
  handshakeDiagnostics.rxPipeline.warning = null;
  lastPipelineFrameHex = null;
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
    const helloBytes = decodeLiveFrameHex(helloHex);
    const decodedHello = decodeFrame(helloBytes, { expectedTurnOwner: 'sender' });
    const { helloAckBytes } = receiverHandshake.handleHello(helloBytes);
    handshakeDiagnostics.transfer.counters.framesRx += 1;
    handshakeDiagnostics.processedHelloCount += 1;
    updateHandshakeDiagnostics();
    if (handshakeDiagnostics.handshakeResult === 'accepted' && decodedHello.frameType === FRAME_TYPES.HELLO) {
      receiverTransfer = new LiveReceiverTransfer({
        sessionId: decodedHello.sessionId,
        profileId: decodedHello.profileId,
        fileSizeBytes: Number(decodedHello.fileSizeBytes),
        fileCrc32c: decodedHello.fileCrc32c,
        totalDataFrames: decodedHello.totalDataFrames
      });
      handshakeDiagnostics.transfer.state = 'WAIT_DATA';
    }
    const ackHex = toHex(helloAckBytes);
    if (writeDebugAckToStorage) {
      window.localStorage.setItem(LIVE_HELLO_ACK_STORAGE_KEY, ackHex);
    }
    playFrameOverTxPath(receiverRuntime, helloAckBytes, document.body);
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


function processReceiverTransferFrame(diagEl: HTMLElement, detail: DecodedRxFrameEventDetail): void {
  if (!receiverTransfer || !receiverRuntime) return;
  if (detail.classification && detail.classification !== 'ok') {
    applyDecodeClassification(detail.classification);
    return;
  }

  try {
    const frameBytes = decodeLiveFrameHex(detail.frameHex);
    if (detail.frameType === 'DATA') {
      receiverTransfer.onData(frameBytes);
      handshakeDiagnostics.transfer.counters.framesRx += 1;
      handshakeDiagnostics.transfer.counters.burstsRx += 1;
      const ack = receiverTransfer.emitBurstAck();
      playFrameOverTxPath(receiverRuntime, ack, document.body);
      handshakeDiagnostics.transfer.counters.framesTx += 1;
      handshakeDiagnostics.transfer.state = 'WAIT_DATA';
      renderDiagnostics(diagEl, {
        handshake: handshakeDiagnostics,
        transferFrame: {
          frameType: detail.frameType,
          classification: detail.classification ?? 'ok'
        },
        message: 'Receiver processed DATA and transmitted BURST_ACK.'
      });
      return;
    }

    if (detail.frameType === 'END') {
      const final = receiverTransfer.onEnd(frameBytes);
      playFrameOverTxPath(receiverRuntime, final, document.body);
      handshakeDiagnostics.transfer.counters.framesRx += 1;
      handshakeDiagnostics.transfer.counters.framesTx += 1;
      lastFinalResponseHex = toHex(final);
      const saved = receiverTransfer.savedFileBytes();
      handshakeDiagnostics.transferBytesSaved = saved?.byteLength ?? 0;
      handshakeDiagnostics.transfer.state = saved ? 'SUCCEEDED' : 'FAILED';
      renderDiagnostics(diagEl, {
        handshake: handshakeDiagnostics,
        transferFrame: {
          frameType: detail.frameType,
          classification: detail.classification ?? 'ok'
        },
        lastFinalResponseHex,
        message: 'Receiver processed END and transmitted FINAL response.'
      });
      return;
    }

    handshakeDiagnostics.invalidTurnEvents += 1;
    handshakeDiagnostics.transfer.failure.category = 'protocol_error';
    handshakeDiagnostics.transfer.failure.reason = `unexpected receiver transfer frame type: ${detail.frameType ?? 'unknown'}`;
  } catch (error) {
    handshakeDiagnostics.transfer.failure.category = 'decode_error';
    handshakeDiagnostics.transfer.failure.reason = String(error);
    handshakeDiagnostics.transfer.counters.decodeFailures += 1;
  }

  renderDiagnostics(diagEl, { handshake: handshakeDiagnostics });
}

function handleDecodedRxEvent(diagEl: HTMLElement, detail: DecodedRxFrameEventDetail): void {
  renderDiagnostics(diagEl, {
    handshake: handshakeDiagnostics,
    decodedFrame: {
      frameType: detail.frameType ?? null,
      classification: detail.classification ?? 'ok',
      frameHexBytes: detail.frameHex.length / 2
    },
    message: 'Received decoded RX frame event.'
  });
  const normalizedFrameType = normalizeDecodedFrameType(detail.frameType);
  if (normalizedFrameType === 'HELLO') {
    processHelloHex(diagEl, detail.frameHex, false, detail.classification ?? 'ok');
    return;
  }
  if (normalizedFrameType === 'DATA' || normalizedFrameType === 'END') {
    processReceiverTransferFrame(diagEl, {
      ...detail,
      frameType: normalizedFrameType
    });
    return;
  }
  if (normalizedFrameType) {
    handshakeDiagnostics.transfer.counters.decodeFailures += 1;
    handshakeDiagnostics.invalidTurnEvents += 1;
    handshakeDiagnostics.transfer.failure.category = 'decode_error';
    handshakeDiagnostics.transfer.failure.reason = `unexpected decoded frame type for receiver shell: ${normalizedFrameType}`;
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
  if (receiverStartInFlight) {
    await receiverStartInFlight;
    return;
  }

  const startPromise = (async () => {
  const startupSource = 'start_button';
  stopReceiverRuntime();
  resetReceiverSessionState();
  stateEl.textContent = 'starting';

  try {
    handshakeDiagnostics.runtimeStartup.attempts += 1;
    handshakeDiagnostics.runtimeStartup.stage = 'request_mic';
    handshakeDiagnostics.runtimeStartup.lastAttemptAtMs = Date.now();
    handshakeDiagnostics.runtimeStartup.lastTriggerSource = startupSource;
    handshakeDiagnostics.runtimeStartup.lastError = null;
    handshakeDiagnostics.runtimeStartup.workletModuleSelected = null;
    handshakeDiagnostics.runtimeStartup.workletModuleErrors = [];
    const stream = await requestMicStream(window.navigator);
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('No audio track available');

    handshakeDiagnostics.runtimeStartup.stage = 'init_audio_context';
    const ctx = new AudioContext();
    handshakeDiagnostics.runtimeStartup.stage = 'register_worklet';
    await registerReceiverWorklet(ctx);

    handshakeDiagnostics.runtimeStartup.stage = 'create_audio_graph';
    const graph = createAudioGraphRuntime(ctx, stream);
    const runtimeInfo = collectAudioRuntimeInfo(ctx);
    const inputInfo = readInputTrackDiagnostics(track);
    handshakeDiagnostics.transfer.audio.actualSampleRateHz = runtimeInfo.sampleRate;
    handshakeDiagnostics.transfer.audio.inputChannelCount = inputInfo.channelCount ?? null;
    handshakeDiagnostics.rxPipeline.channelPolicy = graph.rxChannelPolicy;
    const timing = new LinkTimingEstimator();
    lastCapture = null;
    waveformDebugBuffer = [];

    let levels: AudioLevelSummary = { rms: 0, peakAbs: 0, clipping: false };
    const intervalId = window.setInterval(() => {
      levels = sampleAnalyserLevels(graph.rxAnalyser);
      const decodeSamples = captureAnalyserTimeDomain(graph.rxAnalyser, graph.rxAnalyser.fftSize);
      const pipelineEvent = runReceiverDecodePipeline(decodeSamples, runtimeInfo.sampleRate);
      if (pipelineEvent && pipelineEvent.frameHex.length > 0 && pipelineEvent.frameHex !== lastPipelineFrameHex) {
        lastPipelineFrameHex = pipelineEvent.frameHex;
        window.dispatchEvent(new CustomEvent(RECEIVER_DECODED_RX_EVENT, { detail: pipelineEvent }));
      }
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
      updateRxPipelineWarning(levels);
      waveformDebugBuffer = appendWaveformDebugEntry(waveformDebugBuffer, { timestampMs: Date.now(), levels }, 16);

      updateHandshakeDiagnostics();
      renderDiagnostics(diagEl, {
        runtime: runtimeInfo,
        input: inputInfo,
        levels,
        graph: {
          rxPath: 'mic -> channel_splitter -> mono_downmix -> analyser -> detector -> demod -> decoder -> session_bridge',
          txPath: 'txGain -> outputGain -> destination'
        },
        audioContextState: ctx.state,
        rxCapture: lastCapture,
        linkTiming,
        decodedRxEvent: RECEIVER_DECODED_RX_EVENT,
        waveformDebug: {
          entryCount: waveformDebugBuffer.length,
          recent: waveformDebugBuffer
        },
        handshake: handshakeDiagnostics,
        lastFinalResponseHex,
        message: 'Receiver listening runtime initialized with active RX decode pipeline.'
      });
      if (SHOW_DEBUG_CONTROLS && isDebugStorageEnabled()) {
        maybeProcessDebugHello(diagEl);
      }
    }, 200);

    receiverRuntime = { stream, ctx, graph, intervalId, timing, lastRecordedToneStartMs: null, startedAtMs: Date.now(), startupSource };
    handshakeDiagnostics.runtimeStartup.stage = 'ready';
    handshakeDiagnostics.runtimeStartup.lastSuccessAtMs = Date.now();
    stateEl.textContent = 'listen';
  } catch (error) {
    resetReceiverSessionState();
    stateEl.textContent = 'failed';
    handshakeDiagnostics.runtimeStartup.stage = 'failed';
    handshakeDiagnostics.runtimeStartup.lastError = String(error);
    handshakeDiagnostics.lastFailureReason = `Receiver runtime startup failed: ${String(error)}`;
    handshakeDiagnostics.transfer.failure.category = 'unknown';
    handshakeDiagnostics.transfer.failure.reason = handshakeDiagnostics.lastFailureReason;
    renderDiagnostics(diagEl, {
      handshake: handshakeDiagnostics,
      error: handshakeDiagnostics.lastFailureReason,
      message: 'Receiver runtime startup failed during start request.'
    });
  }
  })();

  receiverStartInFlight = startPromise;
  try {
    await startPromise;
  } finally {
    if (receiverStartInFlight === startPromise) {
      receiverStartInFlight = null;
    }
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
      <p>Transfer RX frames accepted after handshake: <code>DATA</code>, <code>END</code></p>

      <section>
        <button id="receiver-start" type="button">Start</button>
        <button id="receiver-cancel" type="button">Cancel</button>
        <label for="receiver-carrier-frequency">TX carrier Hz</label>
        <input id="receiver-carrier-frequency" type="number" min="200" max="8000" step="50" value="1500" />
        <label for="receiver-bandwidth">TX bandwidth Hz</label>
        <input id="receiver-bandwidth" type="number" min="200" max="6000" step="50" value="2000" />
        <button id="receiver-capture" type="button">Capture RX snapshot</button>
      </section>

      ${debugControls}

      <section>
        <h2>Diagnostics</h2>
        <p>Use status for stable state; use verbose log for full event history and troubleshooting.</p>
        <div>
          <button id="receiver-diag-tab-status" type="button">Status</button>
          <button id="receiver-diag-tab-verbose" type="button">Verbose log</button>
        </div>
        <p id="receiver-diag-freeze-status">Diagnostics live (auto-updating).</p>
        <button id="receiver-diag-freeze-toggle" type="button">Freeze diagnostics</button>
        <button id="receiver-diag-copy" type="button">Copy diagnostics</button>
        <button id="receiver-diag-copy-verbose" type="button">Copy verbose log</button>
        <section id="receiver-diag-panel-status">
          <h3>Status snapshot</h3>
          <pre id="receiver-diag">Diagnostics pending runtime initialization.</pre>
        </section>
        <section id="receiver-diag-panel-verbose" hidden>
          <h3>Verbose event log</h3>
          <pre id="receiver-diag-verbose">Verbose diagnostics pending runtime initialization.</pre>
        </section>
      </section>
    </main>
  `;

  const stateEl = root.querySelector<HTMLElement>('#receiver-state');
  const diagEl = root.querySelector<HTMLElement>('#receiver-diag');
  const startBtn = root.querySelector<HTMLButtonElement>('#receiver-start');
  const cancelBtn = root.querySelector<HTMLButtonElement>('#receiver-cancel');
  const captureBtn = root.querySelector<HTMLButtonElement>('#receiver-capture');
  const freezeDiagBtn = root.querySelector<HTMLButtonElement>('#receiver-diag-freeze-toggle');
  const copyDiagBtn = root.querySelector<HTMLButtonElement>('#receiver-diag-copy');
  const copyVerboseBtn = root.querySelector<HTMLButtonElement>('#receiver-diag-copy-verbose');
  const statusTabBtn = root.querySelector<HTMLButtonElement>('#receiver-diag-tab-status');
  const verboseTabBtn = root.querySelector<HTMLButtonElement>('#receiver-diag-tab-verbose');
  const verboseEl = root.querySelector<HTMLElement>('#receiver-diag-verbose');
  const debugStorageInput = root.querySelector<HTMLInputElement>('#receiver-debug-storage');
  const debugHelloInput = root.querySelector<HTMLInputElement>('#receiver-debug-hello-hex');
  const debugHelloProcessBtn = root.querySelector<HTMLButtonElement>('#receiver-debug-hello-process');

  if (!stateEl || !diagEl || !startBtn || !cancelBtn || !captureBtn || !freezeDiagBtn || !copyDiagBtn || !copyVerboseBtn || !verboseEl) {
    throw new Error('Missing receiver shell elements');
  }

  receiverVerboseLogEntries = [];
  receiverLastLoggedStatusMessage = null;
  appendReceiverVerboseLog('Receiver shell mounted. Diagnostics initialized.');
  verboseEl.textContent = receiverVerboseLogEntries.join('\n\n');
  setReceiverDiagnosticsTab(root, 'status');
  setReceiverDiagnosticsFrozen(root, false);
  renderDiagnostics(diagEl, { handshake: handshakeDiagnostics, message: 'Diagnostics initialized; waiting for receiver actions.' });

  statusTabBtn?.addEventListener('click', () => {
    setReceiverDiagnosticsTab(root, 'status');
  });
  verboseTabBtn?.addEventListener('click', () => {
    setReceiverDiagnosticsTab(root, 'verbose');
  });

  freezeDiagBtn.addEventListener('click', () => {
    const nextFrozen = !receiverDiagnosticsFrozen;
    setReceiverDiagnosticsFrozen(root, nextFrozen);
    if (!nextFrozen) {
      if (receiverDiagnosticsPendingStatusSnapshot !== null) {
        diagEl.textContent = receiverDiagnosticsPendingStatusSnapshot;
        receiverDiagnosticsPendingStatusSnapshot = null;
      }
      if (receiverDiagnosticsPendingSnapshot !== null) {
        verboseEl.textContent = receiverDiagnosticsPendingSnapshot;
        receiverDiagnosticsPendingSnapshot = null;
      }
    }
  });

  copyDiagBtn.addEventListener('click', () => {
    void (async () => {
      const snapshot = diagEl.textContent ?? '';
      try {
        await copyTextToClipboard(snapshot);
        renderDiagnostics(diagEl, {
          handshake: handshakeDiagnostics,
          clipboard: {
            copiedDiagnosticsChars: snapshot.length,
            copiedTarget: 'status'
          },
          message: 'Diagnostics copied to clipboard.'
        });
      } catch (error) {
        renderDiagnostics(diagEl, {
          handshake: handshakeDiagnostics,
          clipboard: {
            copiedDiagnosticsChars: 0,
            copiedTarget: 'status',
            error: String(error)
          },
          message: 'Failed to copy diagnostics to clipboard.'
        });
      }
    })();
  });

  copyVerboseBtn.addEventListener('click', () => {
    void (async () => {
      const verboseSnapshot = root.querySelector<HTMLElement>('#receiver-diag-verbose')?.textContent ?? '';
      try {
        await copyTextToClipboard(verboseSnapshot);
        renderDiagnostics(diagEl, {
          handshake: handshakeDiagnostics,
          clipboard: {
            copiedDiagnosticsChars: verboseSnapshot.length,
            copiedTarget: 'verbose'
          },
          message: 'Verbose diagnostics copied to clipboard.'
        });
      } catch (error) {
        renderDiagnostics(diagEl, {
          handshake: handshakeDiagnostics,
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
    window.removeEventListener(RECEIVER_DECODED_RX_EVENT, decodedRxEventListener);
  }
  decodedRxEventListener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    handleDecodedRxEvent(diagEl, event.detail as DecodedRxFrameEventDetail);
  };
  window.addEventListener(RECEIVER_DECODED_RX_EVENT, decodedRxEventListener);

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
