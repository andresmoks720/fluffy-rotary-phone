# Test Cases Backlog (Post T3/T4 Foundations)

This file turns the prior test-idea list into **concrete test cases** and fills notable coverage holes.

Assumed baseline already exists:
- latency + drift diagnostics,
- `safe` PHY primitives,
- single-frame live path,
- minimal live `HELLO` / `HELLO_ACK` wiring.

---

## 0) Coverage map and known holes to close

### Existing strong areas
- Frame codec and CRC foundations.
- FSM transition tests.
- Basic controller/simulation coverage.

### High-priority holes to close next
1. Explicit malformed corpus expansion (all frame types + all reserved fields).
2. Deterministic PHY false-positive/false-negative boundaries.
3. End-to-end simulated channel matrix (noise/jitter/drift/dropout) with pass/fail thresholds.
4. Diagnostics invariant checks (counter consistency, no NaN/Infinity, reason stability).
5. Browser lifecycle leak/cleanup checks across repeated start/cancel cycles.
6. Adversarial sequence tests (replay storms, timeout races, duplicate storms).

---

## 1) Protocol/frame unit test cases

> Format: **ID — Title**
> - Given
> - When
> - Then

### 1.1 Roundtrip and boundaries

**P-FR-001 — HELLO roundtrip min values**
- Given a valid HELLO with minimum legal values.
- When encode -> decode.
- Then decoded object equals input and CRC fields validate.

**P-FR-002 — HELLO roundtrip max values**
- Given a valid HELLO with maximum legal in-spec values.
- When encode -> decode.
- Then equality holds and no truncation/overflow occurs.

**P-FR-003 — DATA frame max payload**
- Given DATA frame payload at profile max.
- When encode -> decode.
- Then exact payload bytes are preserved.

**P-FR-004 — END frame boundary metadata**
- Given END frame with file-size/total-frame boundary values.
- When encode -> decode.
- Then metadata is exact and validates.

**P-FR-005 — Every byte truncation rejection**
- Given a valid encoded frame.
- When truncating at each byte index.
- Then decode rejects with deterministic malformed/truncated class.

### 1.2 Reserved/invalid fields

**P-FR-010 — Reserved bits non-zero rejected**
- Given valid frame bytes with reserved bits toggled non-zero.
- When decode.
- Then reject with explicit reserved-field error class.

**P-FR-011 — Unknown frame type rejected**
- Given bytes with unknown frame type code.
- When decode.
- Then reject deterministically as unknown-type.

**P-FR-012 — Out-of-range slot index rejected**
- Given DATA frame with slot index outside allowed range.
- When decode/validate.
- Then reject with range error class.

**P-FR-013 — Extra trailing bytes policy pinned**
- Given valid frame plus trailing garbage bytes.
- When decode.
- Then behavior matches documented policy (reject or ignore), pinned by test.

### 1.3 CRC classifications

**P-CRC-001 — Header 1-bit flip => header CRC failure**
- Given valid encoded frame.
- When flipping one header bit only.
- Then classified as header CRC failure.

**P-CRC-002 — Payload 1-bit flip => payload CRC failure**
- Given valid encoded frame.
- When flipping one payload bit only.
- Then classified as payload CRC failure.

**P-CRC-003 — Burst corruption still classified correctly**
- Given valid frame.
- When corrupting contiguous payload byte window.
- Then payload CRC fails, not misclassified as header.

**P-CRC-004 — Known vectors regression lock**
- Given known-good and known-bad vectors.
- When CRC computed/validated.
- Then expected values and classes match fixed snapshots.

---

## 2) PHY unit test cases (`safe`)

### 2.1 Constants/config guards

**PHY-CONF-001 — Constants match MVP contract**
- Given exported `safe` constants.
- When compared to spec constants.
- Then exact values match.

**PHY-CONF-002 — Zero/negative dimensions rejected**
- Given invalid config (0 carriers/symbols etc.).
- When attempting build.
- Then explicit config error is returned.

**PHY-CONF-003 — Out-of-range amplitude rejected**
- Given invalid amplitude envelope.
- When generator init.
- Then fail loudly with deterministic reason.

### 2.2 Preamble/training

**PHY-PRE-001 — Preamble deterministic vector**
- Given fixed config + seed.
- When generating preamble.
- Then byte/symbol output hash equals golden.

**PHY-PRE-002 — Training deterministic vector**
- Given fixed config + seed.
- When generating training block.
- Then output matches golden vector.

**PHY-PRE-003 — Length/amplitude bounds**
- Given generated preamble/training.
- When measuring sample count and amplitude.
- Then values remain within configured bounds.

### 2.3 Detection/acquisition

**PHY-ACQ-001 — Detect at expected offset (clean)**
- Given clean fixture with preamble inserted at known index.
- When running detector.
- Then lock index equals expected index within tolerance.

**PHY-ACQ-002 — Detect under low noise**
- Given low-noise fixture with known preamble offset.
- When detector runs.
- Then positive lock and bounded offset error.

**PHY-ACQ-003 — False-positive rejection on noise**
- Given noise-only fixture.
- When detector runs.
- Then no lock, explicit not-found status.

**PHY-ACQ-004 — Threshold boundary tests**
- Given fixtures just below and just above threshold.
- When detector runs.
- Then below rejects, above accepts (pinned behavior).

### 2.4 BPSK mod/demod

**PHY-MOD-001 — Noise-free roundtrip exact payload**
- Given random payload (fixed seed).
- When modulate -> demodulate.
- Then payload bytes equal exactly.

**PHY-MOD-002 — Bit-order correctness**
- Given known bit-pattern payload.
- When mod/demod.
- Then symbol-to-bit mapping order remains exact.

**PHY-MOD-003 — Non-byte-aligned payload handling**
- Given payload that ends mid-symbol group/padding path.
- When mod/demod.
- Then reconstructed payload and padding semantics are correct.

**PHY-MOD-004 — BER envelope under fixed SNR fixtures**
- Given deterministic AWGN fixtures by SNR bucket.
- When demodulating.
- Then BER stays within expected envelope per bucket.

---

## 3) Diagnostics/math unit test cases

**D-LAT-001 — Stable delay estimate**
- Given synthetic constant delay stream.
- When estimator updates.
- Then reported latency converges and stays bounded.

**D-LAT-002 — Step change convergence**
- Given delay changes from A to B.
- When updates continue.
- Then estimate converges within bounded samples.

**D-LAT-003 — Insufficient samples explicit unavailable**
- Given too few samples.
- When queried.
- Then output is explicit unavailable (not fabricated numeric).

**D-DRF-001 — Zero drift near zero**
- Given equal-rate synthetic clocks.
- When trend computed.
- Then drift near 0 ppm within tolerance.

**D-DRF-002 — Positive drift sign**
- Given RX faster than TX fixture.
- When trend computed.
- Then sign and approximate magnitude are correct.

**D-DRF-003 — Negative drift sign**
- Given RX slower than TX fixture.
- When trend computed.
- Then sign and approximate magnitude are correct.

**D-MET-001 — Counter invariant**
- Given mixed success/failure events.
- When metrics aggregated.
- Then success+fail classifications equal total attempts.

**D-MET-002 — Metrics finite values**
- Given stress updates + resets.
- When serializing diagnostics.
- Then no NaN/Infinity values exist.

**D-MET-003 — Last failure reason stability**
- Given transient warnings followed by terminal failure.
- When querying diagnostics.
- Then terminal reason is preserved until explicit reset.

---

## 4) Controller/FSM integration test cases

**I-HSK-001 — HELLO accept path**
- Given valid HELLO request.
- When receiver handles and sender processes HELLO_ACK accept.
- Then both transition to expected negotiated states + diagnostics updated.

**I-HSK-002 — Reject oversize file**
- Given HELLO with file size above MVP limit.
- When receiver validates.
- Then HELLO reject reason is deterministic and sender enters failure path cleanly.

**I-HSK-003 — Reject unsupported profile**
- Given unsupported profile in HELLO.
- When receiver validates.
- Then explicit reject reason and stable state transitions.

**I-HSK-004 — Session lock enforcement**
- Given accepted session already locked.
- When stale/foreign session HELLO arrives.
- Then frame ignored/rejected per rules and lock remains unchanged.

**I-HSK-005 — 10 MiB boundary accepted**
- Given HELLO declares file size exactly at MVP max (10 MiB).
- When receiver validates size.
- Then proposal remains eligible (not rejected as oversize).

**I-HSK-006 — Memory-feasibility rejection is explicit**
- Given HELLO with supported size but receiver allocation preflight fails.
- When receiver evaluates feasibility.
- Then HELLO is rejected with explicit memory-related reason and diagnostics note.

**I-TURN-001 — Wrong-turn frame ignored + metric**
- Given valid frame type arriving on wrong turn.
- When processed.
- Then state unchanged and invalid-turn increments.

**I-DUP-001 — Duplicate control idempotency**
- Given duplicate HELLO_ACK/terminal control in same state.
- When processed twice.
- Then second event is idempotent and cannot corrupt state.

**I-DUP-002 — Duplicate END replay safety**
- Given receiver already processed END for active session.
- When duplicate END arrives again.
- Then receiver response is deterministic and reconstructed file state is unchanged.

**I-DUP-003 — Duplicate FINAL_OK/FINAL_BAD terminal safety**
- Given sender in terminal success/failure state.
- When duplicate final confirmation frames arrive.
- Then sender remains in same terminal state without counter corruption.

**I-CAN-001 — Sender cancel mid-flight**
- Given active transfer before terminal finalization.
- When sender issues CANCEL.
- Then both sides transition to canceled/failed terminal path with explicit reason.

**I-CAN-002 — Receiver cancel mid-flight**
- Given active transfer before END confirmation.
- When receiver issues CANCEL.
- Then sender stops transmission promptly and both sides cleanup deterministically.

**I-TMO-001 — Timeout then retry**
- Given expected response absent.
- When timeout fires.
- Then retry attempt occurs and budget decrements exactly once.

**I-TMO-002 — Retry exhaustion**
- Given repeated timeouts beyond budget.
- When final timeout processed.
- Then terminal failure reason is explicit and stable.

---

## 5) Burst transport integration test cases (T5+)

**I-BRST-001 — Burst/slot sequencing**
- Given payload requiring multiple bursts.
- When builder emits frames.
- Then burst IDs and slot indices are contiguous and correct.

**I-BRST-002 — Final short burst correctness**
- Given payload not multiple of burst capacity.
- When final burst emitted.
- Then only expected slots exist; no phantom slot.

**I-ACK-001 — ACK bitmap exactness**
- Given receiver missing known slots.
- When ACK built.
- Then bitmap exactly encodes missing set.

**I-ACK-002 — ACK bitmap all-acked zero-missing path**
- Given burst fully received with no missing/corrupt slots.
- When ACK built.
- Then bitmap encodes empty-missing set and sender emits no retransmit frames.

**I-ACK-003 — ACK bitmap malformed input rejection**
- Given malformed ACK bitmap size/content from decoder input.
- When parsed/validated.
- Then ACK rejected deterministically with explicit validation reason.

**I-RETX-001 — Selective retransmit only missing**
- Given ACK with subset missing.
- When retransmit phase begins.
- Then only missing slots resent.

**I-RETX-002 — Duplicate DATA harmless**
- Given duplicate DATA slots arrive.
- When receiver reconstructs buffer.
- Then no overwrite corruption and state remains consistent.

---

## 6) End-to-end software simulation test cases

### 6.1 Channel matrix fixtures

**SIM-MTX-001 — Clean channel small file success**
- Given clean channel model and small file.
- When full transfer simulation runs.
- Then FINAL_OK and file CRC matches.

**SIM-MTX-002 — Mild AWGN with bounded retransmits**
- Given mild noise fixture.
- When full transfer runs.
- Then transfer succeeds with retransmit ratio below set threshold.

**SIM-MTX-003 — Burst noise windows**
- Given intermittent burst corruption periods.
- When run.
- Then selective recovery converges or explicit failure path reached without silent corruption.

**SIM-MTX-004 — Latency jitter**
- Given variable per-frame delay/jitter.
- When run.
- Then timeout logic behaves deterministically (no false deadlocks).

**SIM-MTX-005 — Clock drift injected**
- Given gradual drift model.
- When run long session.
- Then acquisition/diagnostics show drift and transfer outcome remains explicit.

### 6.2 End-state invariants

**SIM-INV-001 — No-save on FINAL_BAD**
- Given forced corruption causing final CRC mismatch.
- When run completes.
- Then FINAL_BAD and no persisted output.

**SIM-INV-002 — Success implies CRC match**
- Given any simulation labeled success.
- When checking terminal state.
- Then receiver file CRC equals END-declared CRC.

**SIM-INV-003 — Cancel cleanup**
- Given cancel mid-transfer.
- When cancellation completes.
- Then both sides return clean idle/failure states with buffers cleared per policy.

**SIM-INV-004 — No partial save on timeout/retry exhaustion**
- Given simulation that fails via timeout or retry-budget exhaustion.
- When transfer terminates.
- Then no output save side effect occurs and failure reason is explicit.

**SIM-INV-005 — Session isolation under stale-frame injection**
- Given active session with injected stale frames from older session IDs.
- When run completes.
- Then active session state/data remain unaffected by stale traffic.

### 6.3 Monte Carlo regression

**SIM-MC-001 — Seeded SNR grid baseline**
- Given fixed seeds across SNR buckets.
- When nightly runs execute.
- Then pass-rate and FER remain within baseline guardrails.

**SIM-MC-002 — Drift+jitter combined stress**
- Given fixed seeds for combined impairments.
- When run.
- Then no hangs; outcomes are success or explicit failure only.

---

## 7) Browser/runtime integration test cases

**B-AUD-001 — Applied settings exposed**
- Given mocked getUserMedia settings.
- When runtime starts.
- Then diagnostics show requested vs applied values distinctly.

**B-AUD-003 — Actual sample-rate reporting required**
- Given runtime with explicit AudioContext sample rate.
- When diagnostics are rendered.
- Then actual sample rate is present and consistent with runtime object.

**B-AUD-002 — Unsupported settings fail loudly**
- Given incompatible applied settings fixture.
- When startup attempted.
- Then startup fails with explicit reason in diagnostics.

**B-LIFE-001 — Start/cancel/start lifecycle**
- Given repeated start/cancel cycles.
- When running N cycles.
- Then no leaked nodes/listeners and state resets cleanly each cycle.

**B-LIFE-002 — Worklet registration failure path**
- Given worklet load/register failure.
- When startup attempted.
- Then explicit failure state and no partial-active runtime remains.

**B-UI-001 — UI reflects controller state exactly**
- Given scripted state progression.
- When rendering updates.
- Then displayed state/buttons are always consistent with controller state.

**B-UI-002 — Required diagnostics fields presence**
- Given active/failed runs.
- When diagnostics panel updates.
- Then required fields are always populated: state, session ID, profile, CRC failures, timeouts, elapsed, goodput, last failure reason.

---

## 8) Adversarial/fuzz/property test cases

**F-PARSE-001 — Random byte parser fuzz (bounded)**
- Given random/truncated/oversized buffers with fixed seeds.
- When parsed.
- Then parser never crashes and runtime stays under budget.

**F-PARSE-002 — Malformed corpus stability**
- Given curated malformed fixtures.
- When parsed across refactors.
- Then same error classes are emitted (unless intentionally changed).

**F-FSM-001 — Illegal event-order property**
- Given random but bounded illegal event sequences.
- When FSM applied.
- Then impossible states are unreachable.

**F-DIAG-001 — Metric monotonicity properties**
- Given random valid event streams.
- When aggregating diagnostics.
- Then monotonic counters never decrement unexpectedly.

---

## 9) Reliability/soak test cases (nightly/manual)

**S-SOAK-001 — 1k repeated small transfers**
- Given mild impairment profile.
- When 1000 transfers run.
- Then aggregate failure rate and retransmit ratio remain below baseline thresholds.

**S-SOAK-002 — Multi-hour idle/listen stability**
- Given receiver in listen with periodic activity.
- When run for hours.
- Then no stuck states or unbounded memory growth.

**S-SOAK-003 — Fail/retry memory leak guard**
- Given repeated induced failures and retries.
- When run for long loop.
- Then memory returns near baseline after GC windows.

**S-SOAK-004 — Diagnostics continuity**
- Given long run with mixed outcomes.
- When collecting diagnostics snapshots.
- Then counters and elapsed-time/throughput stay coherent and finite.

---

## 10) Minimal implementation order for these cases

1. Add deterministic unit case files by subsystem (`protocol`, `phy`, `diagnostics`).
2. Add controller integration table-driven suites (`handshake`, `turn`, `timeout`, `duplicate`).
3. Build seeded software channel harness and start with `SIM-MTX-001..003`.
4. Add browser lifecycle and applied-settings tests.
5. Add fuzz/property bounded suites.
6. Add nightly soak suites and threshold dashboards.

---

## 11) “Definition of done” for test expansion

- Every critical invariant has at least one direct test:
  - no silent corruption,
  - no invalid save,
  - strict turn ownership,
  - deterministic error classification,
  - cleanup after failure/cancel.
- Every production incident gets a deterministic regression fixture.
- PR CI stays fast/deterministic; nightly owns heavy simulation/fuzz/soak.
