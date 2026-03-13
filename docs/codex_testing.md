# Codex Testing Guide (Repo-Specific)

## Purpose

This guide makes verification disciplined, mandatory, executable, and difficult to fake for the browser audio modem MVP. It defines what Codex **must run** before claiming success and what proof levels are actually established.

## Testing philosophy for this repo

- `docs/mvp.md` is the protocol/wire-contract source of truth.
- Prefer deterministic tests over manual or visual assumptions.
- Never rely on Codex “hearing” browser audio.
- Surface audio behavior as waveforms, buffers, counters, thresholds, and browser-visible diagnostics state.
- If a known bug class lacks a deterministic test, add the smallest reproducer first.
- Start browser E2E by proving one-way sender -> receiver before duplex/turn-taking complexity.

## Verification policy: no reasoned-but-unrun success

Codex must never claim a runtime/protocol/PHY fix based on reasoning alone.

Before declaring success:
1. Run the required verify command for the changed area.
2. Inspect failures.
3. Fix failures.
4. Rerun until green (or report exact still-failing commands).
5. Explicitly list what remains unverified in real cable/hardware runtime.

## Mandatory verification entrypoint

Use one mandatory entrypoint:

- `pnpm verify:mvp`

Use narrower commands only for scoped iterations; final claim for cross-layer/runtime/PHY/audio work should be backed by `verify:mvp`.

## Verification command ladder

- `pnpm verify:fast`
  - workspace typecheck
  - workspace lint (if configured)
  - fast unit suite
- `pnpm verify:protocol`
  - typecheck + lint
  - contract/crc/protocol/session contract tests
  - deterministic vectors/golden checks
- `pnpm verify:runtime`
  - typecheck + lint
  - PHY/runtime/browser-harness deterministic tests
  - waveform/detector/telemetry/buffer sufficiency checks
- `pnpm verify:mvp`
  - typecheck + lint
  - all deterministic unit/integration tests
  - protocol + session + PHY + browser-shell tests

## File-to-test routing rules

At minimum run:

- changes under `packages/contract`, `packages/crc`, `packages/protocol`:
  - `pnpm verify:protocol`
- changes under `packages/phy-safe`, runtime/session bridge, browser audio runtime:
  - `pnpm verify:runtime`
- changes under `apps/*` or any cross-layer runtime + PHY/session change:
  - `pnpm verify:mvp`

If unsure, run `pnpm verify:mvp`.

## What counts as done

A task is done only when:
- required verify command(s) were executed,
- required tests for changed bug classes exist and pass,
- docs/instructions are updated when policy or behavior changed,
- summary includes explicit pass/fail command output status,
- summary calls out what is still unverified on real cable/hardware.

## Required deterministic tests by change type

For runtime/PHY/protocol changes, maintain deterministic tests for:

- Symmetric safe preamble TX behavior (sender + receiver replies).
- Waveform round-trip via production modulation path with non-zero sample offsets.
- Sample-offset tolerance across offsets within one chip.
- Detector telemetry truthfulness (`detectorWindowsEvaluated`, best score/offset, threshold diagnostics).
- Buffer sufficiency calculations (preamble-only, safe preamble+HELLO minimum, representative DATA frame minimum).
- Truncation behavior (detector lock with insufficient buffered frame samples must be explicit).
- Sender/receiver safe PHY lock (no silent divergence from shared safe constants in MVP mode).

## Browser one-way E2E strategy

The browser E2E path should:

1. Produce sender waveform from production TX modulation.
2. Inject samples at receiver rolling-buffer/detector boundary (not a high-level decoded-frame shortcut).
3. Assert receiver diagnostics/counters:
   - `preambleDetectorHits >= 1`
   - `candidateFrameCount >= 1`
   - `demodAttempts >= 1`
   - `parserInvocations >= 1`
   - `processedHelloCount >= 1` (or equivalent accepted-handshake evidence)
4. Include non-zero sample offset variant when stable.

## Proof levels and manual gaps

Always separate proof levels:

1. Deterministic/container proof
   - unit/integration tests over protocol, PHY, detector, diagnostics, runtime shell logic.
2. Browser automation proof
   - jsdom/browser-harness tests with waveform/sample injection.
3. Not yet proven
   - real direct cable/hardware live runtime behavior over extended runs.

Never imply level (3) is proven by level (1) or (2).

## Reporting requirements for Codex summaries

Every implementation summary must include:

1. files changed,
2. tests added/updated,
3. commands run,
4. exact pass/fail status per command,
5. remaining unverified real browser/cable runtime claims.
