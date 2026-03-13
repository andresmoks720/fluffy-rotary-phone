#!/usr/bin/env bash
set -euo pipefail

pnpm typecheck
if pnpm run | rg -q "\blint\b"; then
  pnpm lint
else
  echo "[verify:runtime] lint script not configured; skipping lint."
fi
pnpm --filter @audio-modem/phy-safe test
pnpm --filter @audio-modem/audio-browser test
pnpm --filter @audio-modem/receiver-web test
pnpm --filter @audio-modem/sender-web test
