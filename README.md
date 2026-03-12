# audio-modem

Browser-based, half-duplex audio data transfer MVP.

## Quick start

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Current status

- Protocol and product contract docs live under `docs/`.
- T0/T1/T2 baseline is complete (contract/constants, codec+FSM tests, browser/audio shell scaffolding).
- T3/T4 are in progress: live PHY bring-up plus live handshake wiring.
- Current live handshake harness can transmit HELLO/HELLO_ACK frames and process strict hex frame handoff, with storage-coupled flow available only as explicit debug mode.
- Known limitation: end-to-end live decode over cable is still being completed, so full transfer telemetry (goodput/retransmit/CRC failure rates) is modeled but not fully populated by the transfer pipeline yet.
- See `docs/todo.md` for active acceptance checks.
