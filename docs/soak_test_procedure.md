# T2 idle soak test procedure (scripted)

## Goal
Validate 10+ minute idle runtime stability and no unexpected worklet crashes with deterministic sampling.

## Procedure
1. Start receiver and sender runtimes (`pnpm exec vite --config apps/receiver-web/vite.config.ts --host 0.0.0.0 --port 4174`, `pnpm exec vite --config apps/sender-web/vite.config.ts --host 0.0.0.0 --port 4173`) in Chrome.
2. Keep both pages idle (no transfer start) for 10 minutes minimum.
3. Every 30 seconds, capture diagnostics JSON snapshot from each page.
4. Record any uncaught errors, AudioWorklet exceptions, or runtime state changes.

## Pass/fail thresholds
- **Pass**:
  - No worklet crash/restart events for full duration.
  - State remains stable (`ready`/`listen`), no forced reload.
  - Diagnostics continue updating elapsed time and levels.
- **Fail**:
  - Any worklet crash, uncaught runtime error, or frozen diagnostics update > 60 seconds.

## Evidence format
Log each soak run in `docs/run_log.md` using `docs/acceptance_evidence_template.md` and include:
- diagnostics sample cadence summary,
- total duration,
- pass/fail outcome.
