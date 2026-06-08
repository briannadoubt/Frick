import { describe, expect, it } from "vitest";
import {
  CallKeyEpochManager,
  MemoryFrameTransformInserter,
  ReplayWindow,
  SFRAME_V2_HEADER_BYTES,
  SFrameCipherTransform,
  SignalKeyDistributor,
  decodeSFrameV2Header,
  encodeSFrameV2Header,
  startSfuCall,
  type AeadCryptoProvider,
  type CallMediaGrant,
  type CreateSfuDevice,
  type EpochId,
  type KeyDerivationProvider,
  type MediaStreamLike,
  type MediaStreamTrackLike,
  type SfuConsumeOptions,
  type SfuConsumerLike,
  type SfuDeviceLike,
  type SfuProduceEventArgs,
  type SfuProducerLike,
  type SfuRtpCapabilities,
  type SfuTransportLike,
  type SfuTransportOptions,
  type SignalRelayClient,
} from "../src/index.js";
import type {
  CallCommandOp,
  CallCommandResultPayload,
} from "@fricken/protocol";

/**
 * FR-156 — production SFrame cipher suite, replay protection, control-plane
 * key-epoch distribution, and SFU media-path insertion. All deterministic: the
 * AEAD + KDF providers are injected fakes, so there is no WebCrypto/DOM on the
 * test path (exactly as the FR-85 seam tests do for the reference transform).
 */

// -- deterministic providers -------------------------------------------------

/**
 * Deterministic, reversible, authenticating "AEAD" for tests — the same shape
 * the FR-85 seam test uses: XOR keystream + a checksum tag bound to key, nonce,
 * and AAD, so `open` rejects any wrong key / tampered nonce / tampered AAD /
 * tampered ciphertext. NOT secure; only deterministic + authenticating.
 */
class FakeAead implements AeadCryptoProvider {
  #keystream(key: Uint8Array, nonce: Uint8Array, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = (key[i % key.length]! ^ nonce[i % nonce.length]! ^ (i & 0xff)) & 0xff;
    }
    return out;
  }
  /**
   * Tag over key, nonce, AAD, AND the plaintext body — so, like real AEAD, a
   * flipped ciphertext byte (which changes the recovered plaintext) breaks auth,
   * not just header/AAD tampering. 16-bit tag for low collision odds across keys.
   */
  #tag(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, body: Uint8Array): number {
    let t = 0x1234;
    const mix = (b: number, m: number) => {
      t = (t * 31 + b * m + 1) & 0xffff;
    };
    for (const b of key) mix(b, 7);
    for (const b of nonce) mix(b, 13);
    for (const b of aad) mix(b, 31);
    for (const b of body) mix(b, 17);
    return t;
  }
  async seal(args: {
    key: Uint8Array;
    nonce: Uint8Array;
    plaintext: Uint8Array;
    associatedData: Uint8Array;
  }): Promise<Uint8Array> {
    const ks = this.#keystream(args.key, args.nonce, args.plaintext.length);
    const out = new Uint8Array(args.plaintext.length + 2);
    for (let i = 0; i < args.plaintext.length; i++) out[i] = args.plaintext[i]! ^ ks[i]!;
    const tag = this.#tag(args.key, args.nonce, args.associatedData, args.plaintext);
    out[args.plaintext.length] = (tag >> 8) & 0xff;
    out[args.plaintext.length + 1] = tag & 0xff;
    return out;
  }
  async open(args: {
    key: Uint8Array;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    associatedData: Uint8Array;
  }): Promise<Uint8Array> {
    const bodyLen = args.ciphertext.length - 2;
    if (bodyLen < 0) throw new Error("ciphertext too short");
    const ks = this.#keystream(args.key, args.nonce, bodyLen);
    const out = new Uint8Array(bodyLen);
    for (let i = 0; i < bodyLen; i++) out[i] = args.ciphertext[i]! ^ ks[i]!;
    const tag = ((args.ciphertext[bodyLen]! << 8) | args.ciphertext[bodyLen + 1]!) & 0xffff;
    if (tag !== this.#tag(args.key, args.nonce, args.associatedData, out)) {
      throw new Error("auth failed");
    }
    return out;
  }
}

/**
 * Deterministic HKDF stand-in: a label-bound keystream over the secret. Same
 * (secret, label, length) → same bytes (so two members converge), and distinct
 * labels (`key` vs `salt`) yield distinct material.
 */
class FakeKdf implements KeyDerivationProvider {
  async derive(args: { secret: Uint8Array; label: string; length: number }): Promise<Uint8Array> {
    const out = new Uint8Array(args.length);
    let acc = 0;
    for (let i = 0; i < args.label.length; i++) acc = (acc + args.label.charCodeAt(i)) & 0xff;
    for (let i = 0; i < args.length; i++) {
      out[i] = (args.secret[i % args.secret.length]! ^ acc ^ (i * 7 + 1)) & 0xff;
    }
    return out;
  }
}

function deterministicKeyFactory(epochId: EpochId): Uint8Array {
  return new Uint8Array(32).fill((epochId + 1) & 0xff);
}

function fixedNonce(): Uint8Array {
  return new Uint8Array(12).fill(9);
}

const ALICE = { userId: "alice", deviceId: "d1" } as const;
const BOB = { userId: "bob", deviceId: "d2" } as const;

function newTransform(senderId = 1, replayWindow?: number) {
  const epochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
  const transform = new SFrameCipherTransform({
    epochs,
    senderId,
    aead: new FakeAead(),
    kdf: new FakeKdf(),
    replayWindow,
  });
  return { epochs, transform };
}

// -- SFrame v2 header --------------------------------------------------------

describe("SFrame v2 header", () => {
  it("round-trips epoch + sender + counter", () => {
    const bytes = encodeSFrameV2Header({ version: 2, epochId: 5, senderId: 3, counter: 99n });
    expect(bytes.length).toBe(SFRAME_V2_HEADER_BYTES);
    const decoded = decodeSFrameV2Header(bytes);
    expect(decoded).toEqual({ version: 2, epochId: 5, senderId: 3, counter: 99n });
  });

  it("throws on a truncated header", () => {
    expect(() => decodeSFrameV2Header(new Uint8Array(4))).toThrow(/truncated/);
  });
});

// -- production cipher suite -------------------------------------------------

describe("SFrameCipherTransform", () => {
  it("round-trips a frame: encrypt under epoch N → decrypt under epoch N", async () => {
    const { epochs, transform } = newTransform();
    epochs.rotate([ALICE, BOB]); // epoch 0
    const frame = new TextEncoder().encode("hello e2ee media");
    const sealed = await transform.encrypt(frame);

    const header = decodeSFrameV2Header(sealed);
    expect(header.epochId).toBe(0);
    expect(header.senderId).toBe(1);
    expect(header.counter).toBe(1n);
    expect(sealed.length).toBeGreaterThan(frame.length);

    const opened = await transform.decrypt(sealed);
    expect(new TextDecoder().decode(opened)).toBe("hello e2ee media");
  });

  it("derives a fresh nonce per frame (monotonic counter)", async () => {
    const { epochs, transform } = newTransform();
    epochs.rotate([ALICE]); // epoch 0
    const a = await transform.encrypt(new TextEncoder().encode("frame-a"));
    const b = await transform.encrypt(new TextEncoder().encode("frame-b"));
    expect(decodeSFrameV2Header(a).counter).toBe(1n);
    expect(decodeSFrameV2Header(b).counter).toBe(2n);
    // Both decrypt (separate receive transform so replay state is independent).
    const recv = new SFrameCipherTransform({ epochs, senderId: 2, aead: new FakeAead(), kdf: new FakeKdf() });
    expect(new TextDecoder().decode(await recv.decrypt(a))).toBe("frame-a");
    expect(new TextDecoder().decode(await recv.decrypt(b))).toBe("frame-b");
  });

  it("rejects a tampered header (authenticated associated data)", async () => {
    const { epochs, transform } = newTransform();
    epochs.rotate([ALICE]);
    const sealed = await transform.encrypt(new TextEncoder().encode("x"));
    const tampered = Uint8Array.from(sealed);
    tampered[SFRAME_V2_HEADER_BYTES - 1] ^= 0xff; // flip a counter byte
    // Receiver: fresh transform so the counter isn't a self-replay.
    const recv = new SFrameCipherTransform({ epochs, senderId: 9, aead: new FakeAead(), kdf: new FakeKdf() });
    await expect(recv.decrypt(tampered)).rejects.toThrow(/auth failed/);
  });

  it("rejects a tampered ciphertext body", async () => {
    const { epochs, transform } = newTransform();
    epochs.rotate([ALICE]);
    const sealed = await transform.encrypt(new TextEncoder().encode("secret payload"));
    const tampered = Uint8Array.from(sealed);
    tampered[SFRAME_V2_HEADER_BYTES + 1] ^= 0xff;
    const recv = new SFrameCipherTransform({ epochs, senderId: 9, aead: new FakeAead(), kdf: new FakeKdf() });
    await expect(recv.decrypt(tampered)).rejects.toThrow(/auth failed/);
  });

  it("rejects decryption under the wrong epoch (epoch key gone after window)", async () => {
    let clock = 1000;
    const epochs = new CallKeyEpochManager({
      keyFactory: deterministicKeyFactory,
      previousEpochWindowMs: 5_000,
      now: () => clock,
    });
    const sender = new SFrameCipherTransform({ epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const recv = new SFrameCipherTransform({ epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });

    epochs.rotate([ALICE, BOB]); // epoch 0
    const sealed = await sender.encrypt(new TextEncoder().encode("secret"));
    epochs.rotate([ALICE]); // epoch 1 (bob left)

    // Inside the window epoch 0's key still resolves → decrypts.
    expect(new TextDecoder().decode(await recv.decrypt(sealed))).toBe("secret");

    // After the window epoch 0 is dropped → undecryptable.
    clock = 1000 + 5_000;
    await expect(recv.decrypt(sealed)).rejects.toThrow(/no key for epoch 0/);
  });

  it("encrypt throws before any epoch exists", async () => {
    const { transform } = newTransform();
    await expect(transform.encrypt(new Uint8Array([1]))).rejects.toThrow(/no current epoch/);
  });
});

// -- replay protection -------------------------------------------------------

describe("ReplayWindow", () => {
  it("accepts in-order counters and rejects exact replays", () => {
    const w = new ReplayWindow(64);
    expect(w.check(1n)).toBe(true);
    expect(w.check(2n)).toBe(true);
    expect(w.check(2n)).toBe(false); // replay
    expect(w.check(1n)).toBe(false); // replay
    expect(w.check(3n)).toBe(true);
  });

  it("accepts out-of-order-but-fresh counters inside the window", () => {
    const w = new ReplayWindow(64);
    w.check(10n);
    expect(w.check(8n)).toBe(true); // reordered, still fresh
    expect(w.check(9n)).toBe(true);
    expect(w.check(8n)).toBe(false); // now a replay
  });

  it("rejects counters that fall off the bottom of the window", () => {
    const w = new ReplayWindow(4);
    w.check(100n);
    expect(w.check(96n)).toBe(false); // delta == size → too old
    expect(w.check(97n)).toBe(true); // delta 3 < size → inside window
    expect(w.check(0n)).toBe(false); // reserved
  });

  it("seen() is non-mutating", () => {
    const w = new ReplayWindow(8);
    w.check(5n);
    expect(w.seen(5n)).toBe(true);
    expect(w.seen(6n)).toBe(false); // future → not yet seen
    expect(w.check(6n)).toBe(true); // still acceptable (seen didn't record)
  });
});

describe("SFrameCipherTransform replay protection", () => {
  it("rejects a replayed frame on receive; accepts new ones", async () => {
    const epochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    const sender = new SFrameCipherTransform({ epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const recv = new SFrameCipherTransform({ epochs, senderId: 2, aead: new FakeAead(), kdf: new FakeKdf() });
    epochs.rotate([ALICE, BOB]);

    const f1 = await sender.encrypt(new TextEncoder().encode("one"));
    const f2 = await sender.encrypt(new TextEncoder().encode("two"));

    expect(new TextDecoder().decode(await recv.decrypt(f1))).toBe("one");
    expect(new TextDecoder().decode(await recv.decrypt(f2))).toBe("two");
    // Replaying f1 (counter 1, already committed) is rejected.
    await expect(recv.decrypt(f1)).rejects.toThrow(/replayed or stale/);
  });

  it("tracks replay per sender independently", async () => {
    const epochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    epochs.rotate([ALICE, BOB]);
    const senderA = new SFrameCipherTransform({ epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const senderB = new SFrameCipherTransform({ epochs, senderId: 2, aead: new FakeAead(), kdf: new FakeKdf() });
    const recv = new SFrameCipherTransform({ epochs, senderId: 3, aead: new FakeAead(), kdf: new FakeKdf() });

    const a1 = await senderA.encrypt(new TextEncoder().encode("a1")); // sender 1, counter 1
    const b1 = await senderB.encrypt(new TextEncoder().encode("b1")); // sender 2, counter 1
    // Same counter value (1) but different senders → both accepted.
    expect(new TextDecoder().decode(await recv.decrypt(a1))).toBe("a1");
    expect(new TextDecoder().decode(await recv.decrypt(b1))).toBe("b1");
  });

  it("a forged (auth-failing) frame does not poison the replay window", async () => {
    const epochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    epochs.rotate([ALICE]);
    const sender = new SFrameCipherTransform({ epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const recv = new SFrameCipherTransform({ epochs, senderId: 2, aead: new FakeAead(), kdf: new FakeKdf() });

    const real = await sender.encrypt(new TextEncoder().encode("real"));
    // Forge a frame at the same counter with a corrupt body → auth fails.
    const forged = Uint8Array.from(real);
    forged[SFRAME_V2_HEADER_BYTES + 1] ^= 0xff;
    await expect(recv.decrypt(forged)).rejects.toThrow(/auth failed/);
    // The genuine frame at that counter still decrypts (window not poisoned).
    expect(new TextDecoder().decode(await recv.decrypt(real))).toBe("real");
  });
});

// -- key-epoch distribution over the signal relay ----------------------------

/** In-memory shared signal bus mirroring the real `sendSignal`/`signalChannel`. */
class MemorySignalBus {
  readonly entries: Record<string, unknown>[] = [];
  clientFor(deviceId: string): SignalRelayClient {
    const entries = this.entries;
    return {
      async sendSignal(_name: string, _key: string, value: Record<string, unknown>) {
        entries.push(value);
      },
      signalChannel() {
        return { get: () => entries };
      },
    };
  }
}

describe("SignalKeyDistributor", () => {
  function makeDistributor(bus: MemorySignalBus, deviceId: string, roomSecret: Uint8Array) {
    return new SignalKeyDistributor({
      client: bus.clientFor(deviceId),
      callId: "call-1",
      senderDeviceId: deviceId,
      roomSecret,
      aead: new FakeAead(),
      kdf: new FakeKdf(),
      randomNonce: fixedNonce,
    });
  }

  it("wraps + announces an epoch; a peer unwraps and converges, decrypting post-rotation media", async () => {
    const bus = new MemorySignalBus();
    const roomSecret = new Uint8Array(32).fill(0xab);

    const initiatorDist = makeDistributor(bus, "d1", roomSecret);
    const peerDist = makeDistributor(bus, "d2", roomSecret);

    const initiatorEpochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    const peerEpochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    peerDist.onEpoch((e) => peerEpochs.adopt(e));

    // Initiator rotates on a membership change and announces the wrapped key.
    const epoch = initiatorEpochs.rotate([ALICE, BOB]);
    await initiatorDist.announce(epoch);

    // The relayed payload is opaque: the raw key bytes never appear in it.
    const sent = bus.entries[0]!;
    expect(sent.kind).toBe("keyEpoch");
    expect(JSON.stringify(sent)).not.toContain(JSON.stringify(Array.from(epoch.key)));

    // Peer drains the relay → unwraps → adopts the SAME (epochId, key).
    await peerDist.poll();
    expect(peerEpochs.current?.epochId).toBe(epoch.epochId);
    expect(Array.from(peerEpochs.current!.key)).toEqual(Array.from(epoch.key));

    // A frame the initiator encrypts post-rotation decrypts on the peer.
    const sender = new SFrameCipherTransform({ epochs: initiatorEpochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const recv = new SFrameCipherTransform({ epochs: peerEpochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const sealed = await sender.encrypt(new TextEncoder().encode("post-rotation"));
    expect(new TextDecoder().decode(await recv.decrypt(sealed))).toBe("post-rotation");
  });

  it("the transition window still accepts the previous epoch briefly", async () => {
    const bus = new MemorySignalBus();
    const roomSecret = new Uint8Array(32).fill(7);
    let clock = 1000;
    const peerEpochs = new CallKeyEpochManager({
      keyFactory: deterministicKeyFactory,
      previousEpochWindowMs: 5_000,
      now: () => clock,
    });
    const initiatorEpochs = new CallKeyEpochManager({
      keyFactory: deterministicKeyFactory,
      previousEpochWindowMs: 5_000,
      now: () => clock,
    });
    const initiatorDist = makeDistributor(bus, "d1", roomSecret);
    const peerDist = makeDistributor(bus, "d2", roomSecret);
    peerDist.onEpoch((e) => peerEpochs.adopt(e));

    const e0 = initiatorEpochs.rotate([ALICE, BOB]);
    await initiatorDist.announce(e0);
    await peerDist.poll();

    const sender = new SFrameCipherTransform({ epochs: initiatorEpochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const sealedUnderE0 = await sender.encrypt(new TextEncoder().encode("in-flight"));

    // Membership change → epoch 1 announced + adopted.
    const e1 = initiatorEpochs.rotate([ALICE]);
    await initiatorDist.announce(e1);
    await peerDist.poll();
    expect(peerEpochs.current?.epochId).toBe(1);

    // The in-flight epoch-0 frame still decrypts during the window.
    const recv = new SFrameCipherTransform({ epochs: peerEpochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    expect(new TextDecoder().decode(await recv.decrypt(sealedUnderE0))).toBe("in-flight");
  });

  it("a wrong room secret fails closed (cannot unwrap)", async () => {
    const bus = new MemorySignalBus();
    const initiatorDist = makeDistributor(bus, "d1", new Uint8Array(32).fill(1));
    const wrongPeer = makeDistributor(bus, "d2", new Uint8Array(32).fill(2));
    const peerEpochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    wrongPeer.onEpoch((e) => peerEpochs.adopt(e));

    const epochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    await initiatorDist.announce(epochs.rotate([ALICE]));
    await wrongPeer.poll();
    // Unwrap failed → no epoch adopted.
    expect(peerEpochs.current).toBeUndefined();
  });

  it("does not deliver our own announcement back to us", async () => {
    const bus = new MemorySignalBus();
    const dist = makeDistributor(bus, "d1", new Uint8Array(32).fill(3));
    let received = 0;
    dist.onEpoch(() => received++);
    const epochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    await dist.announce(epochs.rotate([ALICE]));
    await dist.poll();
    expect(received).toBe(0);
  });
});

// -- SFU media-path insertion ------------------------------------------------

type ConnectListener = (
  args: { dtlsParameters: Record<string, unknown> },
  callback: () => void,
  errback: (e: Error) => void,
) => void;
type ProduceListener = (
  args: SfuProduceEventArgs,
  callback: (r: { id: string }) => void,
  errback: (e: Error) => void,
) => void;

class FakeTransport implements SfuTransportLike {
  connectListener: ConnectListener | undefined;
  produceListener: ProduceListener | undefined;
  #producerSeq = 0;
  constructor(readonly id: string) {}
  on(event: "connect" | "produce", listener: ConnectListener | ProduceListener): void {
    if (event === "connect") this.connectListener = listener as ConnectListener;
    else this.produceListener = listener as ProduceListener;
  }
  async produce(options: { track: MediaStreamTrackLike }): Promise<SfuProducerLike> {
    await this.#fireConnect();
    const kind = options.track.kind === "audio" ? "audio" : "video";
    const id = await new Promise<string>((resolve, reject) => {
      this.produceListener?.({ kind, rtpParameters: {} }, (r) => resolve(r.id), reject);
    });
    return { id, kind, close: () => undefined };
  }
  async consume(options: SfuConsumeOptions): Promise<SfuConsumerLike> {
    await this.#fireConnect();
    return {
      id: options.id,
      producerId: options.producerId,
      kind: options.kind,
      track: { kind: options.kind, id: `track-${options.id}` },
      close: () => undefined,
    };
  }
  #connected = false;
  async #fireConnect(): Promise<void> {
    if (this.#connected || !this.connectListener) return;
    this.#connected = true;
    await new Promise<void>((resolve, reject) => {
      this.connectListener?.({ dtlsParameters: {} }, resolve, reject);
    });
  }
  close(): void {}
}

class FakeDevice implements SfuDeviceLike {
  readonly rtpCapabilities: SfuRtpCapabilities = { codecs: [] };
  sendTransport: FakeTransport | undefined;
  recvTransport: FakeTransport | undefined;
  async load(): Promise<void> {}
  createSendTransport(o: SfuTransportOptions): SfuTransportLike {
    this.sendTransport = new FakeTransport(o.id);
    return this.sendTransport;
  }
  createRecvTransport(o: SfuTransportOptions): SfuTransportLike {
    this.recvTransport = new FakeTransport(o.id);
    return this.recvTransport;
  }
}

class FakeServer {
  #producerSeq = 0;
  #consumerSeq = 0;
  readonly remoteProducers = new Map<string, { kind: "audio" | "video" }>();
  async callCommand(command: CallCommandOp): Promise<CallCommandResultPayload> {
    switch (command.op) {
      case "sfuConnectTransport":
        return { requestId: "r", op: "sfuConnectTransport" };
      case "sfuProduce":
        return { requestId: "r", op: "sfuProduce", producer: { producerId: `producer-${this.#producerSeq++}`, kind: command.kind } };
      case "sfuConsume": {
        const p = this.remoteProducers.get(command.producerId)!;
        return {
          requestId: "r",
          op: "sfuConsume",
          consumer: { consumerId: `consumer-${this.#consumerSeq++}`, producerId: command.producerId, kind: p.kind, rtpParameters: {} },
        };
      }
      default:
        throw new Error(`unexpected op ${command.op}`);
    }
  }
}

function makeGrant(): CallMediaGrant {
  return {
    callId: "call-1",
    mediaSessionId: "router-1",
    userId: "u1",
    deviceId: "d1",
    token: "0.mac",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    connection: {
      routerRtpCapabilities: JSON.stringify({ codecs: [] }),
      sendTransport: JSON.stringify({ id: "send-1", iceParameters: {}, iceCandidates: [], dtlsParameters: {} }),
      recvTransport: JSON.stringify({ id: "recv-1", iceParameters: {}, iceCandidates: [], dtlsParameters: {} }),
    },
  };
}

function makeLocalStream(): MediaStreamLike {
  return { id: "local", getTracks: () => [{ kind: "audio", id: "mic" }] };
}

describe("startSfuCall E2EE insertion (FR-156)", () => {
  function e2eeBundle() {
    const epochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
    epochs.rotate([ALICE, BOB]);
    const transform = new SFrameCipherTransform({ epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const inserter = new MemoryFrameTransformInserter();
    return { epochs, transform, inserter };
  }

  it("with e2ee enabled, attaches an encrypt transform to producers and decrypt to consumers; round-trips through the seam", async () => {
    const server = new FakeServer();
    server.remoteProducers.set("p-remote", { kind: "video" });
    const device = new FakeDevice();
    const { transform, inserter } = e2eeBundle();
    const createDevice: CreateSfuDevice = () => device;

    const handle = await startSfuCall(server, {
      callId: "call-1",
      participant: { userId: "u1", deviceId: "d1" },
      grant: makeGrant(),
      localStream: makeLocalStream(),
      createDevice,
      e2ee: { transform, inserter },
    });

    // One producer attachment (encrypt) so far.
    expect(inserter.attachmentCount).toBe(1);
    const [producer] = [...handle.producers.values()];

    // Outbound: the producer endpoint's transform SFrame-wraps the frame.
    const frame = new TextEncoder().encode("camera frame");
    const wrapped = await inserter.pump("encrypt", producer, frame);
    expect(decodeSFrameV2Header(wrapped).epochId).toBe(0);
    expect(wrapped.length).toBeGreaterThan(frame.length);

    // Consume a remote producer → a decrypt transform is attached to the consumer.
    await handle.consume("p-remote");
    expect(inserter.attachmentCount).toBe(2);

    // Inbound: the consumer endpoint unwraps a frame wrapped under the same epoch.
    const [decryptEndpoint] = inserter.endpointsFor("decrypt");
    const unwrapped = await inserter.pump("decrypt", decryptEndpoint, wrapped);
    expect(new TextDecoder().decode(unwrapped)).toBe("camera frame");

    handle.close();
    // Detached on close.
    expect(inserter.attachmentCount).toBe(0);
  });

  it("with e2ee disabled, no transform is attached (path unchanged)", async () => {
    const server = new FakeServer();
    server.remoteProducers.set("p-remote", { kind: "audio" });
    const device = new FakeDevice();
    const inserter = new MemoryFrameTransformInserter();

    const handle = await startSfuCall(server, {
      callId: "call-1",
      participant: { userId: "u1", deviceId: "d1" },
      grant: makeGrant(),
      localStream: makeLocalStream(),
      createDevice: () => device,
      // no e2ee
    });
    await handle.consume("p-remote");
    expect(inserter.attachmentCount).toBe(0);
    expect(handle.producers.size).toBe(1);
    handle.close();
  });
});
