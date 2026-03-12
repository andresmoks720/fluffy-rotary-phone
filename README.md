# audio-modem

Browser-based, half-duplex audio data transfer MVP.

## Quick start

```bash
pnpm install
pnpm test
pnpm typecheck
```

Install precondition note: run `pnpm install` first in fresh environments; running tests before install can fail with missing `jsdom`.

## Current status

- Protocol and product contract docs live under `docs/`.
- T0/T1/T2 baseline is complete (contract/constants, codec+FSM tests, browser/audio shell scaffolding).
- T3/T4 are in progress: live PHY bring-up plus live handshake wiring.
- Current browser shells now drive HELLO/HELLO_ACK plus DATA/BURST_ACK/END/FINAL transfer state transitions from decoded RX frame events (with debug storage bridge still optional).
- Known limitation: end-to-end live decode over cable is still being completed, so full transfer telemetry (goodput/retransmit/CRC failure rates) is modeled but not fully populated by the transfer pipeline yet.
- See `docs/todo.md` for active acceptance checks.


## GitHub Pages deployment

This repo now includes a `deploy-pages` GitHub Actions workflow that builds and publishes both web apps to GitHub Pages on pushes to `main`.

After deployment, app URLs are:

- Sender: `https://andresmoks720.github.io/fluffy-rotary-phone/sender/`
- Receiver: `https://andresmoks720.github.io/fluffy-rotary-phone/receiver/`
