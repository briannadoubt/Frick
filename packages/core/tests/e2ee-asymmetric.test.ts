import { describe, expect, it } from "vitest";
import {
  AsymmetricKeyDistributor,
  CallKeyEpochManager,
  MapMemberKeyDirectory,
  SFrameCipherTransform,
  decodeSFrameV2Header,
  type AeadCryptoProvider,
  type AsymmetricCryptoProvider,
  type AsymmetricKeyEpochSignal,
  type AsymmetricKeyPair,
  type EpochId,
  type KeyDerivationProvider,
  type SignalRelayClient,
} from "../src/index.js";

/**
 * FR-158 — per-recipient ASYMMETRIC (ECDH) key wrapping. The epoch key is wrapped
 * INDIVIDUALLY to each current member's public key, so a removed member (not in
 * the recipient set, no blob wrapped to its key) cannot obtain future epoch keys
 * — forward-secrecy-on-membership-change without a shared room secret.
 *
 * Deterministic: the asymmetric/AEAD/KDF providers are injected fakes, so there
 * is no WebCrypto/DOM and no real curve math on the test path (mirroring the
 * FR-156 production tests).
 */

// -- deterministic providers -------------------------------------------------

/**
 * Deterministic, reversible, authenticating "AEAD" — the FR-156 test shape:
 * XOR keystream + a 16-bit tag bound to key, nonce, AAD AND plaintext, so `open`
 * rejects any wrong key / tampered nonce / tampered AAD / tampered ciphertext.
 * NOT secure; only deterministic + authenticating.
 */
class FakeAead implements AeadCryptoProvider {
  #keystream(key: Uint8Array, nonce: Uint8Array, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = (key[i % key.length]! ^ nonce[i % nonce.length]! ^ (i & 0xff)) & 0xff;
    }
    return out;
  }
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

/** Deterministic HKDF stand-in: a label-bound keystream over the secret. */
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

/**
 * Deterministic ECDH stand-in honoring the only property the distributor relies
 * on: shared-secret SYMMETRY (ECDH(privA, pubB) == ECDH(privB, pubA)). We model
 * a key pair as a single random scalar `s`; the public key encodes `s` and the
 * private key encodes `s`; the shared secret of (priv=a, pub=b) is a stable,
 * commutative function of {a, b} (sorted, hashed). A wrong private key yields a
 * different shared secret → the KEK differs → AEAD `open` fails closed.
 */
class FakeAsymmetric implements AsymmetricCryptoProvider {
  #seq = 0;
  constructor(private readonly seed = 100) {}
  async generateKeyPair(): Promise<AsymmetricKeyPair> {
    const scalar = (this.seed + this.#seq++) & 0xff;
    // Public and private both carry the scalar; a tag byte distinguishes them so
    // a public key is never mistaken for a private key in the (a,b) hash.
    return {
      publicKey: Uint8Array.of(0x02, scalar),
      privateKey: Uint8Array.of(0x01, scalar),
    };
  }
  async deriveSharedSecret(args: {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
  }): Promise<Uint8Array> {
    const a = args.privateKey[1]!;
    const b = args.publicKey[1]!;
    // Commutative in {a, b} → symmetric across the two parties.
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = (lo * 31 + hi * 17 + i) & 0xff;
    return out;
  }
}

/** Build a static key pair for a member from a fixed scalar (deterministic). */
function staticPair(scalar: number): AsymmetricKeyPair {
  return { publicKey: Uint8Array.of(0x02, scalar), privateKey: Uint8Array.of(0x01, scalar) };
}

function deterministicKeyFactory(epochId: EpochId): Uint8Array {
  return new Uint8Array(32).fill((epochId + 1) & 0xff);
}

function fixedNonce(): Uint8Array {
  return new Uint8Array(12).fill(9);
}

const ALICE = "alice:d1";
const BOB = "bob:d2";
const CAROL = "carol:d3";

/** In-memory shared signal bus mirroring the real `sendSignal`/`signalChannel`. */
class MemorySignalBus {
  readonly entries: Record<string, unknown>[] = [];
  clientFor(): SignalRelayClient {
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

const CALL_ID = "call-1";

function makeDirectory(): MapMemberKeyDirectory {
  return new MapMemberKeyDirectory([
    [ALICE, staticPair(11).publicKey],
    [BOB, staticPair(22).publicKey],
    [CAROL, staticPair(33).publicKey],
  ]);
}

interface MemberSetup {
  readonly dist: AsymmetricKeyDistributor;
  readonly epochs: CallKeyEpochManager;
}

function makeMember(
  bus: MemorySignalBus,
  args: { deviceId: string; selfMemberId: string; scalar: number; directory: MapMemberKeyDirectory },
): MemberSetup {
  const epochs = new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now: () => 1000 });
  const dist = new AsymmetricKeyDistributor({
    client: bus.clientFor(),
    callId: CALL_ID,
    senderDeviceId: args.deviceId,
    selfMemberId: args.selfMemberId,
    privateKey: staticPair(args.scalar).privateKey,
    directory: args.directory,
    asymmetric: new FakeAsymmetric(),
    aead: new FakeAead(),
    kdf: new FakeKdf(),
    randomNonce: fixedNonce,
  });
  dist.onEpoch((e) => epochs.adopt(e));
  return { dist, epochs };
}

describe("AsymmetricKeyDistributor", () => {
  it("wraps an epoch to {A,B}; both unwrap the SAME key and a frame round-trips A→B", async () => {
    const bus = new MemorySignalBus();
    const directory = makeDirectory();

    // Alice is the rotation initiator; Bob is a recipient.
    const alice = makeMember(bus, { deviceId: "d1", selfMemberId: ALICE, scalar: 11, directory });
    const bob = makeMember(bus, { deviceId: "d2", selfMemberId: BOB, scalar: 22, directory });

    const epoch = alice.epochs.rotate([{ userId: "alice", deviceId: "d1" }, { userId: "bob", deviceId: "d2" }]);
    await alice.dist.announce(epoch);

    // The relayed payload is opaque ECDH: raw key bytes never appear; it has a
    // blob per recipient + the ephemeral public key.
    const sent = bus.entries[0] as AsymmetricKeyEpochSignal;
    expect(sent.kind).toBe("keyEpoch");
    expect(sent.wrap).toBe("ecdh");
    expect(sent.blobs.map((b) => b.recipientId).sort()).toEqual([ALICE, BOB]);
    expect(JSON.stringify(sent)).not.toContain(JSON.stringify(Array.from(epoch.key)));

    // Bob drains the relay → finds HIS blob → unwraps → adopts the same key.
    await bob.dist.poll();
    expect(bob.epochs.current?.epochId).toBe(epoch.epochId);
    expect(Array.from(bob.epochs.current!.key)).toEqual(Array.from(epoch.key));

    // A frame Alice encrypts under that epoch decrypts on Bob.
    const sender = new SFrameCipherTransform({ epochs: alice.epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const recv = new SFrameCipherTransform({ epochs: bob.epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const sealed = await sender.encrypt(new TextEncoder().encode("per-recipient e2ee"));
    expect(new TextDecoder().decode(await recv.decrypt(sealed))).toBe("per-recipient e2ee");
    expect(decodeSFrameV2Header(sealed).epochId).toBe(epoch.epochId);
  });

  it("membership removal: an epoch announced only to {A,B} yields NO blob C can unwrap", async () => {
    const bus = new MemorySignalBus();
    const directory = makeDirectory();

    const alice = makeMember(bus, { deviceId: "d1", selfMemberId: ALICE, scalar: 11, directory });
    const bob = makeMember(bus, { deviceId: "d2", selfMemberId: BOB, scalar: 22, directory });
    const carol = makeMember(bus, { deviceId: "d3", selfMemberId: CAROL, scalar: 33, directory });

    // Epoch 0: everyone present {A,B,C}. All three can obtain it.
    const e0 = alice.epochs.rotate([
      { userId: "alice", deviceId: "d1" },
      { userId: "bob", deviceId: "d2" },
      { userId: "carol", deviceId: "d3" },
    ]);
    await alice.dist.announce(e0);
    await bob.dist.poll();
    await carol.dist.poll();
    expect(carol.epochs.current?.epochId).toBe(0);

    // Membership change: Carol removed. Epoch 1 announced ONLY to {A,B}.
    const e1 = alice.epochs.rotate([
      { userId: "alice", deviceId: "d1" },
      { userId: "bob", deviceId: "d2" },
    ]);
    await alice.dist.announce(e1);

    // The new announcement has no blob addressed to Carol.
    const announce1 = bus.entries[1] as AsymmetricKeyEpochSignal;
    expect(announce1.blobs.some((b) => b.recipientId === CAROL)).toBe(false);
    expect(announce1.blobs.map((b) => b.recipientId).sort()).toEqual([ALICE, BOB]);

    // A,B obtain epoch 1.
    await bob.dist.poll();
    expect(bob.epochs.current?.epochId).toBe(1);

    // Carol polls: no blob for her → fails closed → she does NOT advance to epoch 1.
    await carol.dist.poll();
    expect(carol.epochs.current?.epochId).toBe(0);

    // And she cannot decrypt media Alice now sends under epoch 1: her epoch
    // manager has no key for epoch 1 (after the previous-epoch window passes it's
    // also gone, but even now `keyFor(1)` is undefined since she never adopted it).
    expect(carol.epochs.keyFor(1)).toBeUndefined();
    const sender = new SFrameCipherTransform({ epochs: alice.epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const carolRecv = new SFrameCipherTransform({ epochs: carol.epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    const sealed = await sender.encrypt(new TextEncoder().encode("after carol left"));
    await expect(carolRecv.decrypt(sealed)).rejects.toThrow(/no key for epoch 1/);

    // Bob (still a member) decrypts it fine.
    const bobRecv = new SFrameCipherTransform({ epochs: bob.epochs, senderId: 1, aead: new FakeAead(), kdf: new FakeKdf() });
    expect(new TextDecoder().decode(await bobRecv.decrypt(sealed))).toBe("after carol left");
  });

  it("a tampered wrapped blob fails closed (no epoch adopted)", async () => {
    const bus = new MemorySignalBus();
    const directory = makeDirectory();
    const alice = makeMember(bus, { deviceId: "d1", selfMemberId: ALICE, scalar: 11, directory });
    const bob = makeMember(bus, { deviceId: "d2", selfMemberId: BOB, scalar: 22, directory });

    await alice.dist.announce(
      alice.epochs.rotate([{ userId: "alice", deviceId: "d1" }, { userId: "bob", deviceId: "d2" }]),
    );

    // Tamper with Bob's wrapped blob ciphertext in the relayed signal.
    const signal = bus.entries[0] as AsymmetricKeyEpochSignal;
    const bobBlob = signal.blobs.find((b) => b.recipientId === BOB)!;
    const corrupted = bobBlob.wrappedKey.slice(0, -2) + (bobBlob.wrappedKey.endsWith("AA") ? "BB" : "AA");
    (bobBlob as { wrappedKey: string }).wrappedKey = corrupted;

    await bob.dist.poll();
    expect(bob.epochs.current).toBeUndefined();
  });

  it("a wrong recipient private key cannot unwrap (fails closed)", async () => {
    const bus = new MemorySignalBus();
    const directory = makeDirectory();
    const alice = makeMember(bus, { deviceId: "d1", selfMemberId: ALICE, scalar: 11, directory });
    // Imposter claims to be Bob (selfMemberId BOB) but holds the WRONG private key.
    const imposter = makeMember(bus, { deviceId: "dX", selfMemberId: BOB, scalar: 99, directory });

    await alice.dist.announce(
      alice.epochs.rotate([{ userId: "alice", deviceId: "d1" }, { userId: "bob", deviceId: "d2" }]),
    );

    await imposter.dist.poll();
    // The blob is addressed to Bob, but the imposter's private key derives a
    // different ECDH secret → wrong KEK → AEAD open fails → no epoch adopted.
    expect(imposter.epochs.current).toBeUndefined();
  });

  it("ignores our own echo and stale-epoch announcements", async () => {
    const bus = new MemorySignalBus();
    const directory = makeDirectory();
    const alice = makeMember(bus, { deviceId: "d1", selfMemberId: ALICE, scalar: 11, directory });
    const bob = makeMember(bus, { deviceId: "d2", selfMemberId: BOB, scalar: 22, directory });

    // Own echo: Alice announces and polls her own channel → never delivered to herself.
    let aliceReceived = 0;
    alice.dist.onEpoch(() => aliceReceived++);
    await alice.dist.announce(
      alice.epochs.rotate([{ userId: "alice", deviceId: "d1" }, { userId: "bob", deviceId: "d2" }]),
    );
    await alice.dist.poll();
    expect(aliceReceived).toBe(0);

    // Bob adopts epoch 0.
    await bob.dist.poll();
    expect(bob.epochs.current?.epochId).toBe(0);

    // Alice announces epoch 1, then re-announces a STALE epoch 0 onto the relay.
    const e1 = alice.epochs.rotate([{ userId: "alice", deviceId: "d1" }, { userId: "bob", deviceId: "d2" }]);
    await alice.dist.announce(e1);
    // Manually replay the original epoch-0 signal after epoch 1.
    bus.entries.push({ ...(bus.entries[0] as Record<string, unknown>) });

    await bob.dist.poll();
    // Bob advanced to epoch 1 and did NOT regress to the replayed stale epoch 0.
    expect(bob.epochs.current?.epochId).toBe(1);
  });

  it("a member with no directory key simply gets no blob (others still keyed)", async () => {
    const bus = new MemorySignalBus();
    // Directory is missing Carol's public key entirely.
    const directory = new MapMemberKeyDirectory([
      [ALICE, staticPair(11).publicKey],
      [BOB, staticPair(22).publicKey],
    ]);
    const alice = makeMember(bus, { deviceId: "d1", selfMemberId: ALICE, scalar: 11, directory });
    const bob = makeMember(bus, { deviceId: "d2", selfMemberId: BOB, scalar: 22, directory });

    await alice.dist.announce(
      alice.epochs.rotate([
        { userId: "alice", deviceId: "d1" },
        { userId: "bob", deviceId: "d2" },
        { userId: "carol", deviceId: "d3" },
      ]),
    );

    const signal = bus.entries[0] as AsymmetricKeyEpochSignal;
    // No blob for Carol (no published key), but A and B are keyed.
    expect(signal.blobs.map((b) => b.recipientId).sort()).toEqual([ALICE, BOB]);
    await bob.dist.poll();
    expect(bob.epochs.current?.epochId).toBe(0);
  });
});
