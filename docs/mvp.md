# Audio Modem MVP Specification

## Purpose

This MVP defines a **browser-to-browser, direct-plug, half-duplex audio modem** whose priority is **correctness and reliability over speed**.

The goal is to transfer **one file up to 10 MiB** between two **desktop Chrome** browser instances connected by a **direct cable / plug audio path**. Transfer time may be long. Silent corruption is not acceptable.

This MVP is intended to prove:

- reliable turn-based transmission,
- deterministic framing and parsing,
- explicit retransmission behavior,
- practical long-running transfers with diagnostics,
- configurable speed profiles for testing.

---

## Scope

### In scope

- desktop Chrome only,
- direct plug / direct cable path only,
- half-duplex communication only,
- manual start on receiver and sender,
- one file per session,
- file transfer up to **10 MiB**,
- configurable manual transfer profiles,
- per-frame integrity checks,
- whole-file integrity verification before save,
- minimal UI with diagnostic feedback,
- save received file only after successful full verification.

### Out of scope

- acoustic speaker-to-mic mode,
- full duplex / simultaneous transmission,
- Firefox / Safari / mobile browser support,
- encryption, authentication, or replay protection,
- resume after refresh, crash, or disconnect,
- background installable PWA features,
- multi-file transfer,
- streaming save during transfer,
- adaptive bitrate or automatic profile switching.

---

## Runtime and Platform

### Browser target

- Google Chrome desktop only
- App served from `localhost` or HTTPS

### High-level implementation stack

- TypeScript frontend
- Minimal UI
- AudioWorklet for real-time TX/RX audio processing
- WASM core for DSP and frame processing
- Optional Web Worker for session/control logic and diagnostics aggregation

### Required browser audio constraints

The app must request audio input with:

- `channelCount: 1`
- `echoCancellation: false`
- `noiseSuppression: false`
- `autoGainControl: false`

The app must inspect `MediaStreamTrack.getSettings()` and show the actual applied settings in diagnostics.

### Environment assumptions

- Clean direct cable path is assumed.
- Mono input is assumed.
- The user starts both browser tabs manually.
- No unplug / replug handling is required in MVP.
- If input/output configuration is clearly unsupported, the session should fail early and loudly.

---

## Limits and Assumptions

- Maximum supported file size in MVP: **10 MiB** (`10 * 1024 * 1024` bytes)
- Receiver buffers the full file in memory before save.
- Receiver must reject `HELLO` if declared file size exceeds the MVP limit.
- If the receiver cannot allocate enough memory for the declared file size, the session must fail explicitly.
- No partial file is saved on failure.
- No resume or checkpointing exists in MVP.

---

## Product Behavior

### Receiver flow

1. User opens receiver UI.
2. User presses **Start Listening**.
3. Receiver enters `LISTEN` and waits for session negotiation.
4. Receiver accepts one session and ignores unrelated/stale frames.
5. Receiver stores received data in memory during transfer.
6. Receiver validates full file length and CRC32C at end.
7. Receiver offers save only after final success.

### Sender flow

1. User opens sender UI.
2. User selects a file.
3. User selects a transfer profile.
4. User presses **Start Sending**.
5. Sender negotiates session and chosen profile.
6. Sender transmits bursts of data frames.
7. Sender yields channel after each burst.
8. Sender retransmits only missing/corrupt frames for that burst.
9. Sender finishes only after receiver sends `FINAL_OK`.

---

## Duplex Model

The modem is **half duplex only**.

At any moment, only one side owns TX.

### Turn ownership rules

- Receiver starts in `LISTEN`, but does not transmit until it has something valid to answer.
- Sender owns TX for `HELLO`, `DATA`, `RETX_DATA`, `END`, and optional `CANCEL`.
- Receiver owns TX for `HELLO_ACK`, `BURST_ACK`, `FINAL_OK`, `FINAL_BAD`, and optional `CANCEL`.
- The sender yields TX immediately after each data burst.
- The receiver yields TX immediately after each acknowledgment/control response.
- The MVP must not attempt simultaneous transmission.

### Collision rule

If a side receives a valid frame type that is impossible for the current turn owner, the frame must be ignored and counted in diagnostics as an invalid-turn frame.

---

## PHY / Waveform Strategy

### Primary link type

- Direct plug / cable path only

### MVP PHY choice

Use a **cable-oriented multitone modem** inspired by OFDM-style design, but keep the constellation conservative:

- `safe` profile: BPSK only
- `normal` and `fast-test` profiles: QPSK only
- no higher-order QAM in MVP

### PHY design goals

- strong acquisition preamble,
- explicit training section,
- short fixed binary frames,
- conservative symbol decisions,
- stable operation over long sessions,
- manual speed selection via named profiles.

### Turn structure

Each transmitting turn consists of:

1. preamble,
2. training block,
3. one or more binary protocol frames,
4. end-of-turn guard interval.

Preamble and training are per-turn, not per-frame.

### Not required in MVP

- adaptive bitrate selection,
- acoustic optimization,
- ultrasonic mode,
- simultaneous duplex,
- advanced equalizer experimentation exposed in UI.

---

## Transfer Profiles

The MVP supports **manual profile selection**.

These values are **initial protocol defaults**, not performance guarantees. They may be tuned during implementation, but any change must update this document.

| Profile | Modulation | Carriers | Carrier spacing | Symbol rate | Preamble | Training | Payload bytes / DATA frame | Frames / burst | Intended use |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `safe` | BPSK | 16 | 125 Hz | 250 sym/s | 300 ms | 400 ms | 512 | 8 | first bring-up, cleanest reliability |
| `normal` | QPSK | 24 | 125 Hz | 250 sym/s | 250 ms | 300 ms | 768 | 16 | standard MVP profile |
| `fast-test` | QPSK | 32 | 125 Hz | 300 sym/s | 200 ms | 250 ms | 1024 | 16 | experimental cable-only speed test |

### Profile selection rule

- Sender proposes one profile in `HELLO`.
- Receiver either accepts that exact profile in `HELLO_ACK` or rejects the session.
- Automatic downgrade is out of scope for MVP.

---

## Session Protocol

### Session intent

The session protocol coordinates:

- startup,
- profile agreement,
- file metadata exchange,
- data burst transmission,
- retransmissions,
- final validation,
- orderly session close or explicit failure.

### Session stages

1. `LISTEN`
2. `HELLO`
3. `HELLO_ACK`
4. `DATA_BURST`
5. `BURST_ACK`
6. `RETX_BURST` if needed
7. `END`
8. `FINAL_OK` or `FINAL_BAD`
9. `CLOSE`

### Session IDs

- Each transfer uses a **32-bit unsigned session ID** chosen by the sender.
- Receiver locks to the first valid accepted session ID.
- Frames with other session IDs must be ignored.
- Reuse of a session ID after failure is not allowed within the same page lifetime.

---

## Data Model

### File handling

- Sender reads exactly one file per session.
- MVP sender must reject zero-byte files before emitting `HELLO`; empty-file transfer is out of scope for MVP.
- Receiver allocates one in-memory buffer equal to the declared file size.
- Receiver writes payload bytes into that buffer using absolute file offsets from `DATA` frames.
- Receiver saves the file only after full validation and `FINAL_OK` state.
- On failure, cancel, or final mismatch, the buffer is discarded.

### Metadata required at session start

`HELLO` must contain at minimum:

- file name,
- file size,
- total data frame count,
- payload bytes per `DATA` frame,
- frames per burst,
- selected profile ID,
- whole-file CRC32C.

---

## CRC Definition

All CRCs in MVP use **CRC-32C / Castagnoli** with these exact parameters:

- name: `CRC-32C`
- polynomial: `0x1EDC6F41`
- reflected input: `yes`
- reflected output: `yes`
- init: `0xFFFFFFFF`
- final XOR: `0xFFFFFFFF`
- serialized on wire as **big-endian uint32**
- expected CRC for empty byte string: `0x00000000`

This exact definition applies to:

- `header_crc32c`,
- `payload_crc32c`,
- whole-file CRC32C.

---

## Frame Model

All protocol traffic is frame-based.

Each binary frame must be self-contained and must carry enough metadata for deterministic parsing.

### Frame types

| Name | Code |
|---|---:|
| `HELLO` | `0x01` |
| `HELLO_ACK` | `0x02` |
| `DATA` | `0x03` |
| `BURST_ACK` | `0x04` |
| `END` | `0x05` |
| `FINAL_OK` | `0x06` |
| `FINAL_BAD` | `0x07` |
| `CANCEL` | `0x08` |

### Common conventions

- All integer fields are **unsigned**.
- All multi-byte integer fields are serialized as **big-endian**.
- `flags` is **1 byte**, all bits reserved in MVP, and must be `0x00` on transmit and ignored on receipt.
- `profile_id` values:
  - `0x01` = `safe`
  - `0x02` = `normal`
  - `0x03` = `fast-test`

### Common frame prefix

Every frame begins with:

| Field | Size |
|---|---:|
| `version` | 1 byte |
| `frame_type` | 1 byte |
| `flags` | 1 byte |
| `profile_id` | 1 byte |
| `session_id` | 4 bytes |

- `version` for this MVP is `0x01`.
- `header_crc32c` is always the **last field of the header** and covers all earlier header bytes in that frame.
- `payload_crc32c` covers the payload bytes only.

---

## Binary Protocol Appendix

### `HELLO`

Header layout, in order:

| Field | Size |
|---|---:|
| common frame prefix | 8 bytes |
| `file_size_bytes` | 8 bytes |
| `total_data_frames` | 4 bytes |
| `payload_bytes_per_frame` | 2 bytes |
| `frames_per_burst` | 2 bytes |
| `file_crc32c` | 4 bytes |
| `file_name_len` | 2 bytes |
| `file_name_utf8` | `file_name_len` bytes |
| `header_crc32c` | 4 bytes |

Rules:

- `file_name_len` may be zero.
- `file_name_utf8` is not null-terminated.
- Receiver must reject `HELLO` if any field conflicts with MVP limits.

### `HELLO_ACK`

Header layout, in order:

| Field | Size |
|---|---:|
| common frame prefix | 8 bytes |
| `accept_code` | 1 byte |
| `reserved0` | 1 byte |
| `accepted_payload_bytes_per_frame` | 2 bytes |
| `accepted_frames_per_burst` | 2 bytes |
| `reserved1` | 2 bytes |
| `header_crc32c` | 4 bytes |

`accept_code` values:

- `0x00` = accepted
- `0x01` = rejected: unsupported profile
- `0x02` = rejected: file too large
- `0x03` = rejected: memory unavailable
- `0x04` = rejected: invalid metadata
- `0x05` = rejected: busy

For MVP, `accepted_payload_bytes_per_frame` and `accepted_frames_per_burst` must exactly match `HELLO` on success.

### `DATA`

Header layout, in order:

| Field | Size |
|---|---:|
| common frame prefix | 8 bytes |
| `burst_id` | 4 bytes |
| `slot_index` | 2 bytes |
| `payload_file_offset` | 4 bytes |
| `payload_len` | 2 bytes |
| `header_crc32c` | 4 bytes |

Body layout:

| Field | Size |
|---|---:|
| `payload_bytes` | `payload_len` bytes |
| `payload_crc32c` | 4 bytes |

Rules:

- `slot_index` is zero-based inside the burst.
- `payload_file_offset` is the absolute byte offset in the target file buffer.
- `payload_len` may be smaller than the configured frame payload size only for the final file fragment.
- A `DATA` frame is valid only if header CRC and payload CRC both pass and all bounds are valid.

### `BURST_ACK`

Header layout, in order:

| Field | Size |
|---|---:|
| common frame prefix | 8 bytes |
| `burst_id` | 4 bytes |
| `slot_count` | 2 bytes |
| `ack_bitmap` | 2 bytes |
| `header_crc32c` | 4 bytes |

Rules:

- `slot_count` is the number of meaningful slots in this burst, from `1` to `16` inclusive.
- Only the lowest `slot_count` bits of `ack_bitmap` are meaningful.
- Bits above `slot_count` must be zero on transmit and ignored on receipt.
- **Bit value `1` means the slot was received validly.**
- **Bit value `0` means the slot is still missing or invalid** (missing frame, undecodable frame, header-CRC failure, payload-CRC failure, or bounds failure).
- `ack_bitmap` never distinguishes “missing” from “present but CRC-bad” in MVP.

Worked example:

- `slot_count = 8`
- burst contains slot indexes `0..7`
- slots `0,1,2,4,5,7` valid
- slots `3` and `6` missing or bad

Then:

- bitmap bits low-to-high by slot index: `1 1 1 0 1 1 0 1`
- binary: `0b10110111`
- serialized 16-bit value: `0x00B7`

### `END`

Header layout, in order:

| Field | Size |
|---|---:|
| common frame prefix | 8 bytes |
| `file_size_bytes` | 8 bytes |
| `total_data_frames` | 4 bytes |
| `file_crc32c` | 4 bytes |
| `header_crc32c` | 4 bytes |

Rules:

- `END` is required for success for all transfers, including non-empty files.
- Receiver must treat missing `END` as incomplete transfer, even if all data bytes appear present.

### `FINAL_OK`

Header layout, in order:

| Field | Size |
|---|---:|
| common frame prefix | 8 bytes |
| `observed_file_crc32c` | 4 bytes |
| `header_crc32c` | 4 bytes |

### `FINAL_BAD`

Header layout, in order:

| Field | Size |
|---|---:|
| common frame prefix | 8 bytes |
| `reason_code` | 1 byte |
| `reserved0` | 3 bytes |
| `observed_file_crc32c` | 4 bytes |
| `header_crc32c` | 4 bytes |

`reason_code` values:

- `0x01` = missing data remains
- `0x02` = file length mismatch
- `0x03` = whole-file CRC mismatch
- `0x04` = invalid END metadata

### `CANCEL`

Header layout, in order:

| Field | Size |
|---|---:|
| common frame prefix | 8 bytes |
| `reason_code` | 1 byte |
| `reserved0` | 3 bytes |
| `header_crc32c` | 4 bytes |

`reason_code` values:

- `0x01` = user cancel
- `0x02` = local timeout
- `0x03` = unrecoverable protocol error

---

## Integrity Rules

### Integrity only, no security

The MVP provides **error detection only**.

It does not provide:

- encryption,
- authentication,
- replay protection,
- confidentiality guarantees.

### Required checks

- `header_crc32c` on all frames,
- `payload_crc32c` on every `DATA` frame,
- whole-file CRC32C before final success.

### Completion rule

A transfer succeeds only when all of these are true:

1. all required data bytes are present,
2. all burst retransmissions are resolved,
3. reconstructed file length matches `HELLO` and `END`,
4. whole-file CRC32C matches expected value,
5. receiver sends `FINAL_OK`,
6. sender receives valid `FINAL_OK` for the current session.

### Final confirmation retry rule

If the receiver has already validated the file and sent `FINAL_OK`, but the sender times out waiting for it, the sender may retransmit `END` up to the final-confirmation retry limit.

On receipt of a duplicate valid `END` for an already validated session, the receiver must send `FINAL_OK` again and must not duplicate file save state.

### `FINAL_BAD` rule

`FINAL_BAD` terminates the session as failed.

In MVP, `FINAL_BAD` does **not** trigger targeted recovery after `END`. The user must restart the whole transfer.

---

## Reliability Strategy

### Reliability model

Use **half-duplex burst selective-repeat ARQ**.

The sender transmits one burst of `DATA` frames, then yields the channel so the receiver can send acknowledgment state for that burst.

### Required reliability features

- burst IDs,
- slot indexes within burst,
- ACK bitmap,
- retransmit missing/corrupt frames only,
- duplicate frame tolerance,
- timeout-based retry,
- deterministic failure after retry budget exhausted.

### Duplicate handling

If the receiver gets the same valid `DATA` frame again for the same `session_id`, `burst_id`, `slot_index`, and `payload_file_offset`, it must accept it as a duplicate and keep the already stored bytes.

### Not required in MVP

- forward error correction,
- resume after interruption,
- persistent checkpoints,
- congestion control,
- adaptive mode downgrade.

---

## Timeouts and Retry Policy

The exact values may be tuned during implementation, but the policy itself is frozen here.

| Item | Initial default |
|---|---:|
| `HELLO_ACK` timeout | 3 s |
| `BURST_ACK` timeout | 3 s |
| `FINAL_OK` / `FINAL_BAD` timeout | 3 s |
| max `HELLO` retries | 5 |
| max retries per burst | 8 |
| max `END` retries waiting for final result | 5 |

### Failure classes

- negotiation timeout,
- burst ACK timeout,
- final confirmation timeout,
- retry limit exceeded,
- loss of lock / loss of sync,
- invalid session ID,
- repeated CRC failure,
- user cancel.

When retry budget is exhausted, the session must fail explicitly rather than hang indefinitely.

---

## Sender and Receiver State Machines

### Sender state machine

| State | Allowed incoming | On success | On timeout / error |
|---|---|---|---|
| `IDLE` | none | user starts -> `HELLO_TX` | stay `IDLE` |
| `HELLO_TX` | none | send `HELLO` -> `WAIT_HELLO_ACK` | local encode error -> `FAILED` |
| `WAIT_HELLO_ACK` | `HELLO_ACK`, `CANCEL` | accepted -> `SEND_BURST`; rejected -> `FAILED`; cancel -> `CANCELLED` | retry `HELLO` or `FAILED` |
| `SEND_BURST` | none | burst sent -> `WAIT_BURST_ACK` | local encode error -> `FAILED` |
| `WAIT_BURST_ACK` | `BURST_ACK`, `CANCEL` | all acked -> next burst or `SEND_END`; partial ack -> `RETX_BURST` | retry burst or `FAILED` |
| `RETX_BURST` | none | retransmit missing slots -> `WAIT_BURST_ACK` | local encode error -> `FAILED` |
| `SEND_END` | none | send `END` -> `WAIT_FINAL` | local encode error -> `FAILED` |
| `WAIT_FINAL` | `FINAL_OK`, `FINAL_BAD`, `CANCEL` | `FINAL_OK` -> `SUCCESS`; `FINAL_BAD` -> `FAILED`; cancel -> `CANCELLED` | retry `END` or `FAILED` |
| `SUCCESS` | duplicate `FINAL_OK` ignored | user reset -> `IDLE` | stay `SUCCESS` |
| `FAILED` | optional `CANCEL` ignored | user reset -> `IDLE` | stay `FAILED` |
| `CANCELLED` | none | user reset -> `IDLE` | stay `CANCELLED` |

### Receiver state machine

| State | Allowed incoming | On success | On timeout / error |
|---|---|---|---|
| `IDLE` | none | user starts -> `LISTEN` | stay `IDLE` |
| `LISTEN` | `HELLO`, `CANCEL` | valid `HELLO` -> send `HELLO_ACK`, allocate buffer, `WAIT_DATA`; cancel -> `CANCELLED` | stay `LISTEN` |
| `WAIT_DATA` | `DATA`, `END`, `CANCEL` | valid `DATA` begins burst -> `RECV_BURST`; cancel -> `CANCELLED` | session timeout -> `FAILED` |
| `RECV_BURST` | `DATA`, `CANCEL` | end of turn -> send `BURST_ACK`, return `WAIT_DATA` | protocol error -> `FAILED` |
| `WAIT_END` | `END`, `CANCEL` | valid `END` -> validate file -> `SEND_FINAL_OK` or `SEND_FINAL_BAD` | session timeout -> `FAILED` |
| `SEND_FINAL_OK` | duplicate `END` allowed later | after transmit -> `SUCCESS` | local encode error -> `FAILED` |
| `SEND_FINAL_BAD` | duplicate `END` ignored | after transmit -> `FAILED` | local encode error -> `FAILED` |
| `SUCCESS` | duplicate `END`, duplicate `CANCEL` | duplicate `END` -> resend `FINAL_OK`; user save/reset -> `IDLE` | stay `SUCCESS` |
| `FAILED` | `CANCEL` ignored | user reset -> `IDLE` | stay `FAILED` |
| `CANCELLED` | none | user reset -> `IDLE` | stay `CANCELLED` |

### Invalid frame rule

- Frames with bad header CRC must be ignored.
- `DATA` frames with bad payload CRC must be treated as unreceived for ACK purposes.
- Frames not valid for the current state or session must be ignored and counted in diagnostics.

---

## File Write Semantics

- Receiver reconstructs the whole file in memory first.
- No output file is created before final validation.
- On `FINAL_BAD`, timeout failure, or cancel, no corrupt file is saved.
- On success, the receiver exposes the file through the browser download/save flow.

---

## Cancel / Abort Behavior

### User cancel

- Sender may send `CANCEL(reason_code = 0x01)` and transition to `CANCELLED`.
- Receiver may send `CANCEL(reason_code = 0x01)` and transition to `CANCELLED`.
- On receipt of valid `CANCEL` for the active session, the peer must discard in-memory transfer state and move to `CANCELLED`.

### Local failure abort

If a side detects unrecoverable timeout or protocol failure, it may send `CANCEL` with reason `0x02` or `0x03` before moving to `FAILED`.

### Reset behavior

After `SUCCESS`, `FAILED`, or `CANCELLED`, the UI must require an explicit user reset before returning to `IDLE`.

---

## UI Requirements

The UI should remain minimal.

### Sender UI

At minimum:

- file picker,
- profile selector,
- start button,
- stop / cancel button,
- live transfer diagnostics.

### Receiver UI

At minimum:

- start listening button,
- status display,
- save result only after final success,
- live diagnostics.

### Diagnostics to show

At minimum:

- selected profile,
- actual input sample rate,
- actual applied browser audio settings,
- session state,
- burst number,
- frames sent,
- frames acknowledged,
- frames retransmitted,
- header CRC failure count,
- payload CRC failure count,
- invalid-turn / invalid-state frame count,
- elapsed time,
- effective throughput (goodput),
- final file CRC status.

---

## Testing Requirements

The MVP must support reliability testing across long sessions.

### Required test capabilities

- repeatable transfer of small files,
- repeatable transfer of larger files up to 10 MiB,
- profile comparison (`safe`, `normal`, `fast-test`),
- visibility into retransmission behavior,
- ability to observe achieved throughput in practice.

### Recommended engineering tests

- fixed known test file with reference CRC,
- repeated session runs across all profiles,
- long-session soak test,
- deliberately poor profile selection to observe failure behavior,
- duplicate `END` / duplicate `FINAL_OK` handling test,
- malformed header and malformed ACK bitmap tests.

---

## Acceptance Criteria

The MVP is considered complete when all of these are true:

1. a **10 MiB** file can be transferred successfully over a direct plug path in desktop Chrome,
2. the receiver saves output only after whole-file CRC32C matches,
3. corrupted transfers are rejected and not saved,
4. `safe` and `normal` profiles both complete successfully in repeated tests,
5. retransmission counts and achieved goodput are visible in the UI,
6. cancel and failure states return the app to a predictable resettable state,
7. no major protocol ambiguity remains between independent implementations.

---

## Explicit Non-Goals

The MVP is not intended to prove:

- acoustic room transmission,
- full duplex chat-like experience,
- encrypted secure transport,
- resume after interruption,
- cross-browser compatibility,
- polished consumer UX,
- automatic profile adaptation.

It is intended to prove a reliable browser-based direct-plug file-transfer foundation.
