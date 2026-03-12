# Audio Modem MVP Roadmap

## Goal

Build a **Chrome-only, browser-based, half-duplex, direct-plug audio modem MVP** that can transfer a file of up to **10 MiB** reliably, even if the transfer is slow.

The roadmap focuses on proving:

- stable browser audio processing,
- deterministic framing,
- reliable burst ACK / retransmission behavior,
- long-session transfer stability,
- measurable profile-based speed testing.

---

## Progress Snapshot

- [x] Reorder roadmap to enforce **safe-first** implementation sequence.
- [x] Add explicit checkbox tracking for completion.
- [x] Freeze and keep `mvp.md` as the protocol/wire contract source of truth.

---

## Operating rules

- [x] Build exactly one reliable path first: `safe` (gate retained; `normal`/`fast-test` remain blocked pending repeated live safe runs).
- [ ] Do not implement `normal` or `fast-test` until `safe` completes repeated 10 MiB transfers.
- [ ] Do not optimize speed before protocol correctness, retransmission, and cleanup are proven.
- [ ] If measurements contradict provisional PHY constants, update both code and `mvp.md` in the same change.
- [ ] Treat `mvp.md` as the wire-contract source of truth.

---

## T0 — Freeze the contract

### Protocol contract
- [x] Freeze protocol version and frame type codes.
- [x] Freeze `safe` profile ID.
- [x] Freeze cancel/failure reason codes.
- [x] Create shared constants module.

### CRC and wire format
- [x] Implement CRC32C exactly as specified.
- [x] Add CRC32C golden vectors.
- [x] Freeze binary layout for all frame types.
- [x] Add encode/decode tests for all frame types.

### ACK and state rules
- [x] Implement ACK bitmap semantics exactly as specified.
- [x] Add ACK bitmap worked-example tests.
- [x] Implement sender state machine.
- [x] Implement receiver state machine.
- [x] Add state transition tests for valid, invalid, timeout, retry-exhausted, and cancel cases.

### Done when
- [x] No protocol ambiguity remains in code/tests.
- [x] Golden vectors pass.
- [x] State transition tests pass.

---

## T1 — Deterministic core without live audio

### Frame codec
- [x] Implement pure frame encoder.
- [x] Implement pure frame decoder.
- [x] Reject malformed headers and malformed payloads.
- [x] Reject invalid version, session ID, profile, and turn ownership.
- [x] Handle duplicate frames deterministically.

### Session controller
- [x] Implement sender controller.
- [x] Implement receiver controller.
- [x] Enforce turn ownership.
- [x] Enforce session ID lock.
- [x] Enforce timeout handling.
- [x] Enforce retry-budget handling.
- [x] Enforce cancel/failure transitions.

### Simulated transfer flow
- [x] Simulate `HELLO` / `HELLO_ACK`.
- [x] Simulate one data burst.
- [x] Simulate selective retransmission.
- [x] Simulate `END` / `FINAL_OK`.
- [x] Simulate `FINAL_BAD`.
- [x] Simulate cancel from either side.

### Done when
- [x] Complete transfer flow works without browser audio.
- [x] Controllers cannot enter illegal states.
- [x] Parser behavior is deterministic.

---

## T2 — Browser shell and audio foundation

### App shell
- [x] Create minimal sender screen.
- [x] Create minimal receiver screen.
- [x] Add file picker.
- [x] Add start / cancel buttons.
- [x] Add diagnostics panel shell.

### Audio runtime
- [x] Request mic with required constraints.
- [x] Create playback path.
- [x] Create `AudioContext`.
- [x] Register `AudioWorklet`.
- [x] Establish TX sample path.
- [x] Establish RX sample path.

### Audio diagnostics
- [x] Show actual `getSettings()` values.
- [x] Show actual sample rate.
- [x] Show channel count.
- [x] Show applied audio-processing flags.
- [x] Add amplitude meter.
- [x] Add clipping detector.

### Stability
- [ ] Verify idle runtime stability for 10+ minutes.
- [ ] Verify no unexpected worklet crashes.

### Done when
- [ ] App runs locally.
- [ ] Audio input/output both work.
- [ ] Applied settings are visible.
- [ ] Idle runtime is stable.

---

## T3 — Live PHY bring-up for `safe`

### Raw waveform tools
- [x] Implement TX test tone generator.
- [x] Implement RX raw sample capture.
- [x] Add waveform debug buffer.
- [x] Add basic latency estimate.
- [x] Add drift trend measurement.

### Acquisition and modulation
- [ ] Implement `safe` profile constants.
- [ ] Implement preamble generation.
- [ ] Implement training block generation.
- [ ] Implement preamble detection.
- [ ] Implement training/acquisition path.
- [ ] Implement `safe` modulation.
- [ ] Implement `safe` demodulation.

### Live proof points
- [ ] Send one valid frame over direct plug.
- [ ] Decode one valid frame over direct plug.
- [ ] Record frame success rate.
- [ ] Record header CRC failure rate.
- [ ] Record payload CRC failure rate.

### Done when
- [ ] `safe` profile can send and decode real frames over cable.
- [ ] Acquisition is stable enough for live protocol work.

---

## T4 — Live handshake

### Negotiation
- [x] Sender builds `HELLO`.
- [x] Receiver validates file size, profile support, and memory feasibility.
- [x] Receiver sends `HELLO_ACK`.
- [x] Sender handles accept vs reject cleanly.
- [x] Receiver locks accepted session ID.

### UI integration
- [ ] Show session ID.
- [ ] Show current turn owner.
- [ ] Show negotiation success/failure.

### Done when
- [ ] Live `HELLO` / `HELLO_ACK` works over `safe`.
- [ ] Invalid proposals fail cleanly.

---

## T5 — Live burst transport

### Burst logic
- [x] Implement `DATA` burst builder.
- [ ] Implement burst ID sequencing.
- [ ] Implement slot index sequencing.
- [x] Implement receiver burst tracking.
- [x] Build `BURST_ACK`.
- [x] Retransmit only missing/corrupt slots.
- [x] Ignore duplicates correctly.
- [x] Handle final short burst correctly.
- [ ] Enforce timeout rules.
- [x] Enforce retry-budget rules.

### Metrics
- [ ] Record burst RTT.
- [ ] Record retransmit ratio.
- [ ] Record timeout count.
- [ ] Record invalid-turn count.

### Done when
- [ ] Missing frames are selectively retransmitted.
- [ ] Duplicate frames do not corrupt state.
- [ ] Retry exhaustion produces explicit failure.

---

## T6 — End-to-end small file transfer

### Transfer path
- [ ] Read sender file into transfer pipeline.
- [ ] Split file into `DATA` frames.
- [ ] Reconstruct receiver buffer by absolute offset.
- [ ] Track missing ranges / missing slots.
- [x] Send `END` with final metadata and file CRC32C.
- [x] Receiver recomputes file CRC32C.
- [x] Receiver sends `FINAL_OK` or `FINAL_BAD`.
- [x] Save file only after verified success.
- [x] Discard buffer on failure or cancel.

### Done when
- [ ] Small files transfer successfully over `safe`.
- [ ] Corrupted transfers are rejected.
- [ ] No invalid file is saved.

---

## T7 — Failure handling and diagnostics

### Diagnostics
- [ ] Show current sender/receiver state.
- [ ] Show selected profile.
- [ ] Show session ID.
- [ ] Show bursts sent.
- [ ] Show frames received.
- [ ] Show retransmissions.
- [ ] Show header CRC failures.
- [ ] Show payload CRC failures.
- [ ] Show elapsed time.
- [ ] Show effective goodput.
- [ ] Show last failure/cancel reason.

### Cleanup
- [ ] Sender cancel path.
- [ ] Receiver cancel path.
- [ ] Timeout failure path.
- [ ] Retry-budget exhaustion path.
- [ ] Final CRC mismatch path.
- [ ] Ensure both sides return to clean idle state.
- [ ] Ensure repeated runs do not require page reload.

### Done when
- [ ] Failed runs are diagnosable from UI.
- [ ] Cancel/failure do not leave stale state behind.

---

## T8 — 10 MiB reliability validation

### Repeated runs on `safe`
- [ ] Run repeated tiny-file transfers.
- [ ] Run repeated 1 MiB transfers.
- [ ] Run repeated 10 MiB transfers.

### Record for each run
- [ ] total transfer time.
- [ ] effective goodput.
- [ ] retransmit ratio.
- [ ] timeout count.
- [ ] sync-loss count.
- [ ] final CRC result.
- [ ] final success/failure state.

### Done when
- [ ] 10 MiB transfer succeeds repeatedly on `safe`.
- [ ] Long sessions do not drift into silent corruption.

---

## T9 — MVP closeout

- [ ] Freeze `safe` profile defaults.
- [ ] Freeze config and constants for MVP tag.
- [ ] Verify whole-file CRC32C matches on successful runs.
- [ ] Verify receiver never saves invalid output.
- [ ] Verify diagnostics are sufficient to investigate failures.
- [ ] Tag MVP release candidate.

---

## Backlog — only after MVP works

### Additional profiles
- [ ] Implement `normal`.
- [ ] Validate `normal`.
- [ ] Implement `fast-test`.
- [ ] Validate `fast-test`.

### Comparative testing
- [ ] Compare `safe` vs `normal`.
- [ ] Compare `normal` vs `fast-test`.
- [ ] Decide post-MVP recommended default profile.

### Extra tooling
- [ ] Add richer waveform debug views.
- [ ] Add exportable run logs.
- [ ] Add scripted soak-test harness.
- [x] Add deterministic acceptance evidence template (`docs/acceptance_evidence_template.md`, provisional).


## Safe-first gate evidence

- [x] Browser/event-driven `safe` transfer state transitions covered in automated tests before enabling higher profiles.
- [ ] Repeated live cable `safe` runs (including 10 MiB) recorded in `docs/run_log.md` before any `normal` live claims.
