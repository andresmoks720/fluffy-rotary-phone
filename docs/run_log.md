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
