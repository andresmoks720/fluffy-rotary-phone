# Acceptance evidence template (provisional)

Use this template for each milestone acceptance run so evidence is deterministic and comparable.

> Status: **provisional for MVP bring-up**. Update fields only with measured values.

## Run metadata
- Milestone:
- Date (UTC):
- Operator:
- Sender commit:
- Receiver commit:
- Profile (`safe` for MVP):
- Runtime/browser:
- Link setup (cable/adapter):

## Command + checks
- Command:
- Check list:
  - [ ] start succeeds
  - [ ] handshake succeeds from decoded RX flow
  - [ ] transfer completion result explicit (`FINAL_OK`/`FINAL_BAD`)
  - [ ] cancel/failure returns both sides to clean idle

## Observed metrics
- Transfer size bytes:
- Elapsed ms:
- Effective goodput bps:
- Frames TX / RX:
- Retransmissions:
- Timeout counts (`HELLO_ACK`, `BURST_ACK`, `FINAL`):
- Header CRC failures:
- Payload CRC failures:
- Last failure/cancel reason:

## Result
- Pass/Fail:
- Notes:
