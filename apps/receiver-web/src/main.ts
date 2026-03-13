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
  LiveRxPipeline,
  type DecodedRxFrameEventDetail,
  type LiveRxPipelineDiagnostics
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
  receiverRuntimeAttached: boolean;
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
  rxPipeline: LiveRxPipelineDiagnostics & {
    channelPolicy: 'downmix_to_mono';
    warning: string | null;
    detectorStageTruth:
      | 'no_signal'
      | 'signal_but_no_detector_input'
      | 'detector_input_present_but_windows_not_evaluated'
      | 'detector_input_present_but_low_correlation'
      | 'preamble_candidate_found'
      | 'demod_reached'
      | 'parser_reached'
      | 'parser_failed_or_crc_failed';
  };
}

const SHOW_DEBUG_CONTROLS = new URLSearchParams(window.location.search).get('debug') === '1';
const LIVE_HELLO_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-hello-hex';
const LIVE_HELLO_ACK_STORAGE_KEY = 'fluffy-rotary-phone.live-harness.last-hello-ack-hex';
const RECEIVER_DECODED_RX_EVENT = 'fluffy-rotary-phone:receiver-decoded-rx-frame';
const RECEIVER_INJECT_SAMPLES_EVENT = 'fluffy-rotary-phone:receiver-inject-rx-samples';
const RX_ACTIVITY_WARNING_AFTER_MS = 3000;
const RX_ACTIVITY_WARNING_RMS_THRESHOLD = 0.01;
const PREAMBLE_DETECTION_THRESHOLD = 0.92;
const RX_PIPELINE = new LiveRxPipeline({
  maxBufferSamples: 262144,
  detectorScanMaxSamples: 65536,
  preambleThreshold: 0.92
});
const RECEIVER_WORKLET_MODULE_CANDIDATES = [
  new URL('rx_stream_processor.js', window.location.href).toString()
] as const;

let receiverRuntime: ReceiverRuntime | null = null;
let receiverStartInFlight: Promise<void> | null = null;
let decodedRxEventListener: ((event: Event) => void) | null = null;
let injectedSamplesEventListener: ((event: Event) => void) | null = null;
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
  readonly source: 'rx_analyser_time_domain_snapshot';
} | null = null;
let waveformDebugBuffer: readonly WaveformDebugEntry[] = [];
let lastPipelineFrameHex: string | null = null;
let rxWorkletLastRms = 0;
let rxWorkletLastPeak = 0;
const handshakeDiagnostics: ReceiverHandshakeDiagnostics = {
  transfer: createInitialLiveDiagnostics({ state: 'LISTEN', currentTurnOwner: 'sender' }),
  sessionId: null,
  currentTurnOwner: 'sender',
  handshakeResult: 'pending',
  handshakeReason: null,
  processedHelloCount: 0,
  lastFailureReason: null,
  receiverRuntimeAttached: false,
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
    ...RX_PIPELINE.createInitialDiagnostics(),
    preambleThreshold: PREAMBLE_DETECTION_THRESHOLD,
    channelPolicy: 'downmix_to_mono',
    warning: null,
    detectorStageTruth: 'no_signal'
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
    receiverRuntimeAttached: handshakeDiagnostics.receiverRuntimeAttached,
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

function handleContinuousRxSamples(
  diagEl: HTMLElement,
  sampleBuffer: Float32Array,
  sampleRateHz: number,
  source: 'rx_worklet_stream' | 'rx_injected_samples'
): void {
  if (sampleBuffer.length === 0) {
    return;
  }

  const pipelineEvent = RX_PIPELINE.pushPcm(sampleBuffer, sampleRateHz, handshakeDiagnostics.rxPipeline, { source });
  if (pipelineEvent) {
    if (pipelineEvent.frameHex.length > 0) {
      lastPipelineFrameHex = pipelineEvent.frameHex;
      handleDecodedRxEvent(diagEl, pipelineEvent);
    }
    return;
  }

  renderDiagnostics(diagEl, {
    handshake: handshakeDiagnostics,
    message: source === 'rx_injected_samples'
      ? 'Injected RX samples processed via continuous RX pipeline without decoded frame.'
      : 'Continuous RX stream chunk processed without decoded frame.'
  });
}

interface InjectRxSamplesEventDetail {
  readonly samples: Float32Array | readonly number[];
  readonly sampleRateHz?: number;
}

function handleInjectedRxSamplesEvent(diagEl: HTMLElement, detail: InjectRxSamplesEventDetail): void {
  const sourceSamples = detail.samples;
  const sampleBuffer = sourceSamples instanceof Float32Array
    ? sourceSamples
    : Float32Array.from(sourceSamples);

  const sampleRateHz = Number.isFinite(detail.sampleRateHz)
    ? (detail.sampleRateHz as number)
    : receiverRuntime?.ctx.sampleRate ?? 48000;

  handleContinuousRxSamples(diagEl, sampleBuffer, sampleRateHz, 'rx_injected_samples');
}


function updateRxPipelineWarning(levels: AudioLevelSummary): void {
  const elapsed = handshakeDiagnostics.transfer.elapsedMs;
  const hasSignal = levels.rms >= RX_ACTIVITY_WARNING_RMS_THRESHOLD;
  const detectorHasInput = handshakeDiagnostics.rxPipeline.detectorBufferFillSamples > 0;
  const correlationBelowThreshold =
    handshakeDiagnostics.rxPipeline.bestPreambleCorrelationScore < handshakeDiagnostics.rxPipeline.preambleThreshold;

  if (!hasSignal) {
    handshakeDiagnostics.rxPipeline.detectorStageTruth = 'no_signal';
    handshakeDiagnostics.rxPipeline.warning = null;
    return;
  }

  if (!detectorHasInput) {
    handshakeDiagnostics.rxPipeline.detectorStageTruth = 'signal_but_no_detector_input';
    handshakeDiagnostics.rxPipeline.warning = elapsed >= RX_ACTIVITY_WARNING_AFTER_MS
      ? 'audio present but no detector input reached the RX buffer'
      : null;
    return;
  }

  if (handshakeDiagnostics.rxPipeline.detectorWindowsEvaluated === 0) {
    handshakeDiagnostics.rxPipeline.detectorStageTruth = 'detector_input_present_but_windows_not_evaluated';
    handshakeDiagnostics.rxPipeline.warning = elapsed >= RX_ACTIVITY_WARNING_AFTER_MS
      ? 'detector input present but no detector windows were evaluated'
      : null;
    return;
  }

  if (handshakeDiagnostics.rxPipeline.parserInvocations > 0) {
    handshakeDiagnostics.rxPipeline.detectorStageTruth = 'parser_reached';
    handshakeDiagnostics.rxPipeline.warning = null;
    return;
  }

  if (handshakeDiagnostics.transfer.failure.category === 'decode_error' || handshakeDiagnostics.transfer.failure.category === 'crc_failure') {
    handshakeDiagnostics.rxPipeline.detectorStageTruth = 'parser_failed_or_crc_failed';
    handshakeDiagnostics.rxPipeline.warning = elapsed >= RX_ACTIVITY_WARNING_AFTER_MS
      ? 'parser reached but frame decode/CRC failed'
      : null;
    return;
  }

  if (handshakeDiagnostics.rxPipeline.demodAttempts > 0) {
    handshakeDiagnostics.rxPipeline.detectorStageTruth = 'demod_reached';
    handshakeDiagnostics.rxPipeline.warning = handshakeDiagnostics.rxPipeline.frameTruncationDetected
      ? 'detector locked but buffered samples insufficient for frame decode'
      : null;
    return;
  }

  if (handshakeDiagnostics.rxPipeline.candidateFrameCount > 0 || handshakeDiagnostics.rxPipeline.preambleDetectorHits > 0) {
    handshakeDiagnostics.rxPipeline.detectorStageTruth = 'preamble_candidate_found';
    handshakeDiagnostics.rxPipeline.warning = handshakeDiagnostics.rxPipeline.frameTruncationDetected
      ? 'detector locked but buffered samples insufficient for frame decode'
      : null;
    return;
  }

  if (correlationBelowThreshold) {
    handshakeDiagnostics.rxPipeline.detectorStageTruth = 'detector_input_present_but_low_correlation';
    handshakeDiagnostics.rxPipeline.warning = elapsed >= RX_ACTIVITY_WARNING_AFTER_MS
      ? 'detector input present but preamble correlation remains below threshold'
      : null;
    return;
  }

  handshakeDiagnostics.rxPipeline.detectorStageTruth = 'detector_input_present_but_windows_not_evaluated';
  handshakeDiagnostics.rxPipeline.warning = elapsed >= RX_ACTIVITY_WARNING_AFTER_MS
    ? 'audio present but detector candidates did not reach decode pipeline'
    : null;
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

function renderReceiverLiveStats(root: ParentNode, levels: AudioLevelSummary | null): void {
  const statsEl = root.querySelector<HTMLElement>('#receiver-live-stats');
  if (!statsEl) return;

  const counters = handshakeDiagnostics.transfer.counters;
  const elapsedSec = handshakeDiagnostics.transfer.elapsedMs / 1000;
  const savedBytes = handshakeDiagnostics.transferBytesSaved;
  const goodputBps = elapsedSec > 0 ? Math.round((savedBytes * 8) / elapsedSec) : 0;
  const levelRms = levels?.rms ?? 0;
  const levelPeak = levels?.peakAbs ?? 0;

  statsEl.textContent = [
    `RX volume RMS: ${levelRms.toFixed(4)} | Peak: ${levelPeak.toFixed(4)}`,
    `Elapsed: ${elapsedSec.toFixed(2)} s | Goodput: ${goodputBps} bps | Bytes saved: ${savedBytes}`,
    `Frames TX/RX: ${counters.framesTx}/${counters.framesRx} | Bursts TX/RX: ${counters.burstsTx}/${counters.burstsRx}`,
    `Retransmissions: ${counters.retransmissions} | Timeouts (HELLO/BURST/FINAL): ${counters.timeoutsHelloAck}/${counters.timeoutsBurstAck}/${counters.timeoutsFinal}`,
    `Detector windows: ${handshakeDiagnostics.rxPipeline.detectorWindowsEvaluated} | Offsets: ${handshakeDiagnostics.rxPipeline.detectorOffsetsEvaluated} | Phase bins: ${handshakeDiagnostics.rxPipeline.detectorPhaseBinsEvaluated}`,
    `Last corr: ${handshakeDiagnostics.rxPipeline.lastPreambleCorrelationScore.toFixed(4)} | Best corr: ${handshakeDiagnostics.rxPipeline.bestPreambleCorrelationScore.toFixed(4)} | Threshold: ${handshakeDiagnostics.rxPipeline.preambleThreshold.toFixed(2)} | Best phase(rad): ${handshakeDiagnostics.rxPipeline.bestCarrierPhaseOffsetRad.toFixed(2)}`,
    `Detector hits/candidates: ${handshakeDiagnostics.rxPipeline.preambleDetectorHits}/${handshakeDiagnostics.rxPipeline.candidateFrameCount} | Demod/parser: ${handshakeDiagnostics.rxPipeline.demodAttempts}/${handshakeDiagnostics.rxPipeline.parserInvocations} | Stage: ${handshakeDiagnostics.rxPipeline.detectorStageTruth}`,
    `Buffer samples fill/rx: ${handshakeDiagnostics.rxPipeline.detectorBufferFillSamples}/${handshakeDiagnostics.rxPipeline.rxBufferedSamples} | Dropped: ${handshakeDiagnostics.rxPipeline.detectorBufferDroppedSamples} | Continuity: ${handshakeDiagnostics.rxPipeline.detectorInputContinuity}`,
    `Min preamble/HELLO/DATA: ${handshakeDiagnostics.rxPipeline.minSamplesRequiredPreamble}/${handshakeDiagnostics.rxPipeline.minSamplesRequiredHello}/${handshakeDiagnostics.rxPipeline.minSamplesRequiredData} | Truncation: ${handshakeDiagnostics.rxPipeline.frameTruncationDetected ? 'yes' : 'no'} | Warning: ${handshakeDiagnostics.rxPipeline.warning ?? 'none'}`,
    `State: ${handshakeDiagnostics.transfer.state} | Session: ${handshakeDiagnostics.sessionId ?? 'none'} | Handshake: ${handshakeDiagnostics.handshakeResult} | Runtime attached: ${handshakeDiagnostics.receiverRuntimeAttached ? 'yes' : 'no'}` ,
    `Safe PHY: carrier=${DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz}Hz samplesPerChip=${DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip} amp=${DEFAULT_SAFE_CARRIER_MODULATION.amplitude.toFixed(2)} (tx/rx locked)`
  ].join('\n');
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
  const levels = typeof data === 'object' && data !== null && 'levels' in data
    ? ((data as { levels?: AudioLevelSummary | null }).levels ?? null)
    : null;
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
  renderReceiverLiveStats(document, levels);
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
  const waveform = modulateSafeFrameWithPreambleToWaveform(frameBytes, runtime.ctx.sampleRate, {
    carrierFrequencyHz: DEFAULT_SAFE_CARRIER_MODULATION.carrierFrequencyHz,
    samplesPerChip: DEFAULT_SAFE_CARRIER_MODULATION.samplesPerChip,
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
  handshakeDiagnostics.receiverRuntimeAttached = false;
  lastCapture = null;
  waveformDebugBuffer = [];
  RX_PIPELINE.reset();
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
  handshakeDiagnostics.receiverRuntimeAttached = false;
  handshakeDiagnostics.transferBytesSaved = 0;
  handshakeDiagnostics.invalidTurnEvents = 0;
  receiverLastLoggedTransferState = null;
  receiverLastLoggedHandshakeResult = null;
  receiverLastLoggedStatusMessage = null;
  receiverTransfer = null;
  lastFinalResponseHex = null;
  RX_PIPELINE.reset();
  handshakeDiagnostics.rxPipeline = {
    ...RX_PIPELINE.createInitialDiagnostics(),
    preambleThreshold: PREAMBLE_DETECTION_THRESHOLD,
    channelPolicy: handshakeDiagnostics.rxPipeline.channelPolicy,
    warning: null,
    detectorStageTruth: 'no_signal'
  };
  rxWorkletLastRms = 0;
  rxWorkletLastPeak = 0;
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
    levels: summarizeAudioLevels(samples),
    source: 'rx_analyser_time_domain_snapshot'
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
      playFrameOverTxPath(receiverRuntime, ack);
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
      playFrameOverTxPath(receiverRuntime, final);
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
    const graph = createAudioGraphRuntime(ctx, stream, { rxWorkletProcessorName: 'rx-stream-processor' });
    const runtimeInfo = collectAudioRuntimeInfo(ctx);
    const inputInfo = readInputTrackDiagnostics(track);
    handshakeDiagnostics.transfer.audio.actualSampleRateHz = runtimeInfo.sampleRate;
    handshakeDiagnostics.transfer.audio.inputChannelCount = inputInfo.channelCount ?? null;
    handshakeDiagnostics.rxPipeline.channelPolicy = graph.rxChannelPolicy;
    const timing = new LinkTimingEstimator();
    lastCapture = null;
    waveformDebugBuffer = [];

    let levels: AudioLevelSummary = { rms: 0, peakAbs: 0, clipping: false };
    graph.rxStreamTapNode?.port.addEventListener('message', (event) => {
      const detail = event.data as { samples?: Float32Array; rms?: number; peak?: number };
      if (typeof detail.rms === 'number') {
        rxWorkletLastRms = detail.rms;
      }
      if (typeof detail.peak === 'number') {
        rxWorkletLastPeak = detail.peak;
      }
      const samples = detail.samples instanceof Float32Array ? detail.samples : null;
      if (samples) {
        handleContinuousRxSamples(diagEl, samples, runtimeInfo.sampleRate, 'rx_worklet_stream');
      }
    });
    graph.rxStreamTapNode?.port.start();

    const intervalId = window.setInterval(() => {
      const analyserLevels = sampleAnalyserLevels(graph.rxAnalyser);
      levels = {
        rms: rxWorkletLastRms || analyserLevels.rms,
        peakAbs: rxWorkletLastPeak || analyserLevels.peakAbs,
        clipping: analyserLevels.clipping
      };
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
          rxPath: 'mic -> channel_splitter -> mono_downmix -> worklet_stream_ring -> detector -> demod -> decoder -> session_bridge (analyser is diagnostics only)',
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
        message: 'Receiver listening runtime initialized with continuous worklet PCM RX pipeline; manual event/localStorage bridges are debug-only.'
      });
      if (SHOW_DEBUG_CONTROLS && isDebugStorageEnabled()) {
        maybeProcessDebugHello(diagEl);
      }
    }, 200);

    receiverRuntime = { stream, ctx, graph, intervalId, timing, lastRecordedToneStartMs: null, startedAtMs: Date.now(), startupSource };
    handshakeDiagnostics.receiverRuntimeAttached = true;
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
        <label for="receiver-carrier-frequency">TX carrier Hz (safe locked)</label>
        <input id="receiver-carrier-frequency" type="number" min="200" max="8000" step="50" value="1500" disabled />
        <label for="receiver-bandwidth">TX bandwidth Hz (safe locked)</label>
        <input id="receiver-bandwidth" type="number" min="200" max="6000" step="50" value="2000" disabled />
        <button id="receiver-capture" type="button">Capture RX snapshot</button>
      </section>

      ${debugControls}

      <section>
        <h2>Live modem stats</h2>
        <pre id="receiver-live-stats">Waiting for receiver runtime.</pre>
      </section>

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
    decodedRxEventListener = null;
  }
  if (injectedSamplesEventListener) {
    window.removeEventListener(RECEIVER_INJECT_SAMPLES_EVENT, injectedSamplesEventListener);
    injectedSamplesEventListener = null;
  }

  if (SHOW_DEBUG_CONTROLS) {
    decodedRxEventListener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      handleDecodedRxEvent(diagEl, event.detail as DecodedRxFrameEventDetail);
    };
    window.addEventListener(RECEIVER_DECODED_RX_EVENT, decodedRxEventListener);

    injectedSamplesEventListener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      handleInjectedRxSamplesEvent(diagEl, event.detail as InjectRxSamplesEventDetail);
    };
    window.addEventListener(RECEIVER_INJECT_SAMPLES_EVENT, injectedSamplesEventListener);
  }

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
