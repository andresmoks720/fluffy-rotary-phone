# Run Log

Chronological implementation and validation notes.

## 2026-03-12

- Initialized workspace and created T0 baseline modules (`contract`, `crc`).
- Added deterministic CRC32C vectors and tests.

- Added protocol frame encode/decode package with strict CRC and field validation tests.
- Added ACK bitmap helpers with worked-example tests (`0x00B7`).

- Added explicit sender/receiver FSM modules with deterministic transition functions.
- Added transition tests covering valid flow, invalid transitions, timeout, retry exhaustion, and cancel behavior.

- Tightened protocol codec encode/decode malformed-input validation (range and reserved-field checks) with tests.
- Added sender/receiver session controllers enforcing turn ownership, session lock, and timeout/retry behavior.
- Added deterministic simulated transfer-flow tests for `FINAL_OK`, `FINAL_BAD`, and cancel paths.

- Expanded simulated transfer coverage for duplicate `END` replay, final-timeout retry path, and cancel from either side.
- Added sender controller retry-exhaustion tests for final confirmation timeouts.

- Added protocol decode turn-ownership expectation checks to reject frames arriving on the wrong half-duplex turn.

- Aligned FSM/controller duplicate-handling semantics with spec: duplicate `FINAL_OK` ignored in sender success, duplicate `CANCEL` ignored in receiver success and sender failed states.

- Reconciled `docs/mvp_roadmap.md` checkboxes with implemented T0/T1 status to reduce roadmap/code drift.
- Moved `docs/todo.md` next-focus section to T2 app/audio shell tasks.

- Added minimal sender/receiver web app shells with file picker/control buttons and diagnostics panel placeholders.
- Added `@audio-modem/audio-browser` helpers for mic constraints, audio runtime diagnostics, and worklet registration skeleton with tests.

- Wired sender/receiver shell start/cancel actions to mic/context initialization and on-screen diagnostics output.
- Added audio level helper primitives (RMS/peak/clipping) and tests for deterministic meter/clipping foundations.

- Added audio graph runtime helper with explicit RX (`mic -> analyser`) and TX/playback (`txGain -> outputGain -> destination`) sample paths.
- Wired app shells to register an AudioWorklet module and report live analyser level metrics in diagnostics.

- Added TX test tone generator controls in sender shell, backed by audio graph oscillator wiring and disposal-safe lifecycle behavior.

- Added receiver RX raw sample capture control and diagnostics preview (sample window + level summary) for waveform bring-up checks.
- Added receiver waveform debug buffer diagnostics with capped history (recent meter entries) to support live PHY bring-up inspection.

- Added `packages/session/src/live_transfer.ts` for deterministic transport-loop primitives: sender DATA burst scheduling, ACK-driven selective retransmit, END retry policy, FINAL handling, and on-wire CANCEL on retry exhaustion.
- Added receiver-side transfer assembly with absolute payload offsets, duplicate-frame suppression, END metadata validation, whole-file CRC verification, and save-after-success-only gating (`savedFileBytes()`).
- Added `packages/session/tests/live_transfer_integration.test.ts` covering:
  - full DATA -> BURST_ACK -> END -> FINAL_OK flow,
  - repeated 10 MiB simulated transfers (3 runs),
  - final-timeout retry exhaustion emitting CANCEL.
- Installed missing workspace test dependency (`jsdom`) and re-ran full workspace tests.

## 2026-03-13

### Acceptance run (browser decoded-RX transfer integration; simulated frame feed)

- Milestone: T5/T6/T7 browser transfer wiring from decoded RX frames
- Date (UTC): 2026-03-13
- Operator: codex agent
- Sender commit: working tree (pre-commit)
- Receiver commit: working tree (pre-commit)
- Profile (`safe` for MVP): safe
- Runtime/browser: vitest + jsdom browser shell tests
- Link setup (cable/adapter): simulated decoded RX event feed

- Command: `pnpm --filter @audio-modem/sender-web test && pnpm --filter @audio-modem/receiver-web test`
- Check list:
  - [x] start succeeds
  - [x] handshake succeeds from decoded RX flow
  - [x] transfer completion result explicit (`FINAL_OK`/`FINAL_BAD`)
  - [x] cancel/failure returns both sides to clean idle

- Observed metrics:
  - Transfer size bytes: sender test fixture 4 bytes / receiver fixture 1024-byte metadata case
  - Elapsed ms: test-scale (< 1s per case)
  - Effective goodput bps: modeled diagnostics field populated on sender success path
  - Frames TX / RX: asserted through diagnostics transitions and event sequence
  - Retransmissions: diagnostics counters present and mutable in transfer flow
  - Timeout counts (`HELLO_ACK`, `BURST_ACK`, `FINAL`): diagnostics counters present and mutable
  - Header CRC failures: diagnostics counter exposed
  - Payload CRC failures: diagnostics counter exposed
  - Last failure/cancel reason: diagnostics field exposed and updated on failures

- Result:
  - Pass/Fail: PASS (integration test scope)
  - Notes: This run validates browser shell transfer state transitions from decoded RX frames, not physical cable transport.

### Direct-cable acceptance matrix (`safe`) — pending live hardware execution

Environment note: direct cable/browser runtime proof requires local Chrome + physical audio loopback/cable devices. This CI/container can update procedures and acceptance fields but cannot synthesize trustworthy live-cable evidence.

#### Tiny-file repeats (target: >=5)

| Run ID | Date (UTC) | Size bytes | Final state | CRC result | Elapsed ms | Goodput bps | Retransmit ratio | Timeouts (H/B/F) | Sync-loss count | Notes |
|---|---|---:|---|---|---:|---:|---:|---|---:|---|
| tiny-1 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| tiny-2 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| tiny-3 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| tiny-4 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| tiny-5 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |

#### 1 MiB repeats (target: >=3)

| Run ID | Date (UTC) | Size bytes | Final state | CRC result | Elapsed ms | Goodput bps | Retransmit ratio | Timeouts (H/B/F) | Sync-loss count | Notes |
|---|---|---:|---|---|---:|---:|---:|---|---:|---|
| 1mib-1 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| 1mib-2 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| 1mib-3 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |

#### 10 MiB repeats (target: >=3)

| Run ID | Date (UTC) | Size bytes | Final state | CRC result | Elapsed ms | Goodput bps | Retransmit ratio | Timeouts (H/B/F) | Sync-loss count | Notes |
|---|---|---:|---|---|---:|---:|---:|---|---:|---|
| 10mib-1 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| 10mib-2 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| 10mib-3 | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |

### Idle soak evidence log (T2 stability) — pending live hardware execution

| Soak run ID | Date (UTC) | Duration min | Worklet crashes observed | Unexpected state transitions | Timeout deltas during idle | Pass/Fail | Notes |
|---|---|---:|---:|---:|---|---|---|
| soak-1 | pending | pending | pending | pending | pending | pending | pending |

### Acceptance run (direct-cable evidence placeholder)

- Milestone: T3/T8 direct-cable live acceptance
- Date (UTC): 2026-03-13
- Operator: pending
- Sender commit: pending
- Receiver commit: pending
- Profile (`safe` for MVP): safe
- Runtime/browser: Chrome (pending)
- Link setup (cable/adapter): direct plug (pending)

- Command: pending cable execution
- Check list:
  - [ ] start succeeds
  - [ ] handshake succeeds from decoded RX flow
  - [ ] transfer completion result explicit (`FINAL_OK`/`FINAL_BAD`)
  - [ ] cancel/failure returns both sides to clean idle

- Observed metrics:
  - Transfer size bytes: pending (must include repeated 10 MiB)
  - Elapsed ms: pending
  - Effective goodput bps: pending
  - Frames TX / RX: pending
  - Retransmissions: pending
  - Timeout counts (`HELLO_ACK`, `BURST_ACK`, `FINAL`): pending
  - Header CRC failures: pending
  - Payload CRC failures: pending
  - Last failure/cancel reason: pending

- Result:
  - Pass/Fail: PENDING
  - Notes: Blocked on physical cable run execution outside this CI/container environment.
