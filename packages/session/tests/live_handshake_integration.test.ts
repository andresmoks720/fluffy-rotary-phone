import { HELLO_REJECT_CODES, PROFILE_IDS } from '../../../packages/contract/src/index.js';
import { describe, expect, it } from 'vitest';

import {
  LIVE_HANDSHAKE_DEFAULT_PROFILES,
  ReceiverLiveHandshake,
  SenderLiveHandshake,
  type LivePhyTransport
} from '../src/index.js';

class LoopbackLink {
  senderEndpoint: LivePhyTransport;
  receiverEndpoint: LivePhyTransport;

  private senderHandler: ((frameBytes: Uint8Array) => void) | null = null;
  private receiverHandler: ((frameBytes: Uint8Array) => void) | null = null;

  constructor() {
    this.senderEndpoint = {
      send: (frameBytes) => {
        if (!this.receiverHandler) throw new Error('receiver handler not wired');
        this.receiverHandler(frameBytes);
      }
    };

    this.receiverEndpoint = {
      send: (frameBytes) => {
        if (!this.senderHandler) throw new Error('sender handler not wired');
        this.senderHandler(frameBytes);
      }
    };
  }

  wire(senderOnFrame: (frameBytes: Uint8Array) => void, receiverOnFrame: (frameBytes: Uint8Array) => void): void {
    this.senderHandler = senderOnFrame;
    this.receiverHandler = receiverOnFrame;
  }
}

describe('live handshake integration', () => {
  it('accepts HELLO over live frame wiring and exposes handshake diagnostics', () => {
    const link = new LoopbackLink();

    const sender = new SenderLiveHandshake(link.senderEndpoint);
    const receiver = new ReceiverLiveHandshake({
      transport: link.receiverEndpoint,
      supportedProfiles: LIVE_HANDSHAKE_DEFAULT_PROFILES,
      canAllocate: () => true
    });

    link.wire((frameBytes) => sender.onFrame(frameBytes), (frameBytes) => receiver.onFrame(frameBytes));

    const senderStart = sender.start({
      fileName: 'ok.bin',
      fileSizeBytes: 1024,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x01020304
    });

    expect(senderStart.sessionId).toBe(0x01020304);
    expect(sender.snapshot().handshake).toEqual({ status: 'accepted' });
    expect(sender.snapshot().turnOwner).toBe('sender');
    expect(receiver.snapshot().handshake).toEqual({ status: 'accepted' });
    expect(receiver.snapshot().sessionId).toBe(0x01020304);
    expect(receiver.snapshot().turnOwner).toBe('sender');
  });

  it('rejects HELLO when memory feasibility fails using live ACK wiring', () => {
    const link = new LoopbackLink();

    const sender = new SenderLiveHandshake(link.senderEndpoint);
    const receiver = new ReceiverLiveHandshake({
      transport: link.receiverEndpoint,
      supportedProfiles: LIVE_HANDSHAKE_DEFAULT_PROFILES,
      canAllocate: () => false
    });

    link.wire((frameBytes) => sender.onFrame(frameBytes), (frameBytes) => receiver.onFrame(frameBytes));

    sender.start({
      fileName: 'mem-reject.bin',
      fileSizeBytes: 4096,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x11111111
    });

    expect(sender.snapshot().handshake).toEqual({
      status: 'rejected',
      reason: 'memory_unavailable',
      code: HELLO_REJECT_CODES.MEMORY_UNAVAILABLE
    });
    expect(receiver.snapshot().sessionId).toBeNull();
    expect(receiver.snapshot().handshake).toEqual({
      status: 'rejected',
      reason: 'memory_unavailable',
      code: HELLO_REJECT_CODES.MEMORY_UNAVAILABLE
    });
  });

  it('enforces receiver session-ID lock after accept', () => {
    const link = new LoopbackLink();
    const receiver = new ReceiverLiveHandshake({
      transport: link.receiverEndpoint,
      supportedProfiles: LIVE_HANDSHAKE_DEFAULT_PROFILES,
      canAllocate: () => true
    });

    const senderA = new SenderLiveHandshake(link.senderEndpoint);
    link.wire((frameBytes) => senderA.onFrame(frameBytes), (frameBytes) => receiver.onFrame(frameBytes));

    senderA.start({
      fileName: 'lock-a.bin',
      fileSizeBytes: 1024,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x22222222
    });

    const senderB = new SenderLiveHandshake(link.senderEndpoint);
    link.wire((frameBytes) => senderB.onFrame(frameBytes), (frameBytes) => receiver.onFrame(frameBytes));

    senderB.start({
      fileName: 'lock-b.bin',
      fileSizeBytes: 1024,
      profileId: PROFILE_IDS.SAFE,
      sessionId: 0x33333333
    });

    expect(receiver.snapshot().sessionId).toBe(0x22222222);
    expect(senderB.snapshot().handshake).toEqual({
      status: 'rejected',
      reason: 'busy',
      code: HELLO_REJECT_CODES.BUSY
    });
  });
});
