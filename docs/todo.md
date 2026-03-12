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

## Next focus: T2 — Browser shell and audio foundation

- [x] Create minimal sender screen.
- [x] Create minimal receiver screen.
- [x] Add file picker.
- [x] Add start / cancel buttons.
- [x] Add diagnostics panel shell.
- [x] Request mic with required constraints.
- [x] Create `AudioContext` + worklet registration skeleton.
- [x] Wire start/cancel actions to runtime initialization shell states.
- [x] Surface applied input/audio diagnostics in shell views.
- [x] Add basic amplitude/clipping helper primitives.
- [x] Create playback path.
- [x] Register `AudioWorklet`.
- [x] Establish TX sample path.
- [x] Establish RX sample path.

## T3 kickoff progress

- [x] Implement TX test tone generator.
- [x] Implement RX raw sample capture.
- [x] Add waveform debug buffer.

## Notes

- Protocol source of truth remains `docs/mvp.md`.
- Do not change wire semantics without updating `docs/mvp.md` in the same patch.
