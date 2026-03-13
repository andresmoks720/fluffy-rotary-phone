#!/usr/bin/env bash
set -euo pipefail

pnpm typecheck
if pnpm run | rg -q "\blint\b"; then
  pnpm lint
else
  echo "[verify:mvp] lint script not configured; skipping lint."
fi
pnpm -r test
