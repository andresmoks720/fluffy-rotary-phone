# MVP Implementation Todo

This file tracks implementation order and status, derived from `docs/mvp_roadmap.md`.

## Current focus: T0 — Freeze the contract

- [x] Create initial monorepo scaffold (workspace, TypeScript baseline).
- [x] Create shared protocol constants module (`packages/contract`).
- [x] Freeze MVP frame type, profile ID, and reason code constants in code.
- [x] Add initial CRC32C package with golden vectors (`packages/crc`).
- [x] Add frame encode/decode module and tests for all frame layouts.
- [x] Implement ACK bitmap helpers and worked-example tests.
- [x] Implement sender and receiver finite-state machines.
- [x] Add state-transition tests (valid, invalid, timeout, retry-exhausted, cancel).

## Active focus: T3/T4 — Live PHY + handshake bring-up

### T3 deliverables in progress
- [x] Implement TX test tone generator.
- [x] Implement RX raw sample capture.
- [x] Add waveform debug buffer.
- [x] Add basic latency estimate.
- [x] Add drift trend measurement.
- [ ] Decode valid live `safe` frame from RX path (not harness storage).

### T4 deliverables in progress
- [x] Sender builds `HELLO` with receiver validation path.
- [x] Receiver sends `HELLO_ACK` and sender handles accept/reject.
- [x] Receiver locks accepted session ID.
- [x] Handshake acceptance from decoded RX frames in default flow.
- [x] Keep storage-coupled flow debug-only.

### Acceptance checks for current focus
- [ ] Live `safe` frame decode succeeds over direct cable in repeated runs.
- [ ] Live `HELLO`/`HELLO_ACK` proves decoded RX dependency end-to-end.
- [ ] Diagnostics show session/turn + timeout/retry/error counters during live tests.
- [x] Add deterministic acceptance evidence template (`docs/acceptance_evidence_template.md`).


## Active focus: T5/T6/T7 — live transport completion

### T5/T6 progress
- [x] Add deterministic sender DATA burst scheduler + selective retransmit logic in session package transport harness.
- [x] Add deterministic receiver BURST_ACK bitmap generation and duplicate DATA slot handling.
- [x] Add END/FINAL_OK/FINAL_BAD completion path with END retry + retry exhaustion cancellation.
- [x] Add receiver save-after-success-only file exposure semantics in transport harness (`savedFileBytes()`).
- [x] Wire browser shells to transport primitives from decoded RX frames (`LiveSenderTransfer`/`LiveReceiverTransfer`) for DATA/BURST_ACK/END/FINAL flow in browser integration tests.

### T7 progress
- [x] Add repeated 10 MiB simulated-transfer acceptance tests (3 runs) in automated suite.
- [ ] Capture repeated direct-cable browser acceptance evidence in `docs/run_log.md` (tiny + 1 MiB + 10 MiB matrix rows) after full cable setup runs.

## Notes

- Protocol source of truth remains `docs/mvp.md`.
- Do not change wire semantics without updating `docs/mvp.md` in the same patch.


### T2 stability procedure
- [x] Define scripted soak-run procedure (`docs/soak_test_procedure.md`) with explicit pass/fail thresholds and diagnostics sampling cadence.
- [ ] Execute 10+ minute idle soak and record evidence in `docs/run_log.md`.
- [x] Add direct-cable acceptance matrix + soak evidence tables to `docs/run_log.md` for deterministic run capture.
