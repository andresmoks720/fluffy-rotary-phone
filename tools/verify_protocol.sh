#!/usr/bin/env bash
set -euo pipefail

pnpm typecheck
if pnpm run | rg -q "\blint\b"; then
  pnpm lint
else
  echo "[verify:protocol] lint script not configured; skipping lint."
fi
pnpm --filter @audio-modem/contract test
pnpm --filter @audio-modem/crc test
pnpm --filter @audio-modem/protocol test
pnpm --filter @audio-modem/session test
