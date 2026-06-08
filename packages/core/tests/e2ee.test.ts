import { describe, expect, it } from "vitest";
import {
  AeadSFrameTransform,
  CallKeyEpochManager,
  MemoryKeyDistributor,
  MemoryKeyDistributorFabric,
  SFRAME_HEADER_BYTES,
  decodeSFrameHeader,
  encodeSFrameHeader,
  type AeadCryptoProvider,
  type CallMember,
  type EpochId,
  type KeyEpoch,
} from "../src/index.js";

/**
 * FR-85 — key-epoch management seam for optional per-room call E2EE.
 *
 * Drives the {@link CallKeyEpochManager}, the reference {@link AeadSFrameTransform}
 * (over a deterministic injected AEAD fake — no WebCrypto/DOM), and the
 * {@link MemoryKeyDistributor}. Asserts: rotation on membership change yields a
 * fresh epoch id + key; a frame encrypted under epoch N decrypts under N and
 * FAILS under N+1 (forward secrecy at epoch granularity); a receiver accepts the
 * previous epoch during the transition window then drops it; and the SFrame
 * header carries the epoch id.
 */

// -- deterministic test doubles ---------------------------------------------

/**
 * Deterministic, reversible "AEAD" for tests: XOR the plaintext with a keystream
 * derived from key+nonce, then append a tag = sum(key)+sum(nonce)+sum(aad).
 * `open` recomputes and verifies the tag, throwing on any mismatch (wrong key,
 * tampered header, tampered ciphertext) — the property the real AEAD guarantees.
 * NOT secure; it only has to be deterministic and authenticating for the seam.
 */
class FakeAead implements AeadCryptoProvider {
  #keystream(key: Uint8Array, nonce: Uint8Array, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = (key[i % key.length] ^ nonce[i % nonce.length] ^ (i & 0xff)) & 0xff;
    }
    return out;
  }
  #tag(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array): number {
    let t = 0;
    for (const b of key) t = (t + b) & 0xff;
    for (const b of nonce) t = (t + b) & 0xff;
    for (const b of aad) t = (t + b) & 0xff;
    return t;
  }
  async seal(args: {
    key: Uint8Array;
    nonce: Uint8Array;
    plaintext: Uint8Array;
    associatedData: Uint8Array;
  }): Promise<Uint8Array> {
    const ks = this.#keystream(args.key, args.nonce, args.plaintext.length);
    const out = new Uint8Array(args.plaintext.length + 1);
    for (let i = 0; i < args.plaintext.length; i++) out[i] = args.plaintext[i] ^ ks[i];
    out[args.plaintext.length] = this.#tag(args.key, args.nonce, args.associatedData);
    return out;
  }
  async open(args: {
    key: Uint8Array;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    associatedData: Uint8Array;
  }): Promise<Uint8Array> {
    const bodyLen = args.ciphertext.length - 1;
    if (bodyLen < 0) throw new Error("ciphertext too short");
    const tag = args.ciphertext[bodyLen];
    if (tag !== this.#tag(args.key, args.nonce, args.associatedData)) {
      throw new Error("auth failed");
    }
    const ks = this.#keystream(args.key, args.nonce, bodyLen);
    const out = new Uint8Array(bodyLen);
    for (let i = 0; i < bodyLen; i++) out[i] = args.ciphertext[i] ^ ks[i];
    return out;
  }
}

/** Deterministic per-epoch key: byte-filled with `epochId + 1` so epochs differ. */
function deterministicKeyFactory(epochId: EpochId): Uint8Array {
  return new Uint8Array(32).fill((epochId + 1) & 0xff);
}

const ALICE: CallMember = { userId: "alice", deviceId: "d1" };
const BOB: CallMember = { userId: "bob", deviceId: "d2" };
const CAROL: CallMember = { userId: "carol", deviceId: "d3" };

function newManager(now: () => number = () => 1000) {
  return new CallKeyEpochManager({ keyFactory: deterministicKeyFactory, now });
}

// -- key epoch manager -------------------------------------------------------

describe("CallKeyEpochManager", () => {
  it("rotation on membership change yields a fresh epoch id and key", () => {
    const mgr = newManager();
    const e0 = mgr.rotate([ALICE, BOB]);
    expect(e0.epochId).toBe(0);
    expect(mgr.current?.epochId).toBe(0);

    const e1 = mgr.rotate([ALICE, BOB, CAROL]);
    expect(e1.epochId).toBe(1);
    expect(mgr.current?.epochId).toBe(1);
    // Fresh key material per epoch.
    expect(Array.from(e1.key)).not.toEqual(Array.from(e0.key));
    // Membership snapshot is sorted + bound to the epoch.
    expect(e1.members).toEqual(["alice:d1", "bob:d2", "carol:d3"]);
  });

  it("accepts the previous epoch during the transition window then drops it", () => {
    let clock = 1000;
    const mgr = new CallKeyEpochManager({
      keyFactory: deterministicKeyFactory,
      previousEpochWindowMs: 5_000,
      now: () => clock,
    });
    mgr.rotate([ALICE, BOB]); // epoch 0
    mgr.rotate([ALICE]); // epoch 1 (bob left)

    // Inside the window: epoch 0's key still resolves on receive.
    clock = 1000 + 4_999;
    expect(mgr.keyFor(0)).toBeDefined();
    expect(mgr.keyFor(1)).toBeDefined();

    // Past the window: the departed member's epoch is gone (forward secrecy).
    clock = 1000 + 5_000;
    expect(mgr.keyFor(0)).toBeUndefined();
    expect(mgr.keyFor(1)).toBeDefined();
  });

  it("keyFor returns undefined for an unknown epoch", () => {
    const mgr = newManager();
    mgr.rotate([ALICE]);
    expect(mgr.keyFor(99)).toBeUndefined();
  });

  it("adopt() converges a peer onto an announced epoch and ignores stale ones", () => {
    const mgr = newManager();
    mgr.rotate([ALICE]); // epoch 0
    const peerEpoch: KeyEpoch = {
      epochId: 1,
      key: new Uint8Array(32).fill(7),
      members: ["alice:d1"],
      createdAt: 1000,
    };
    mgr.adopt(peerEpoch);
    expect(mgr.current?.epochId).toBe(1);
    // Re-adopting the same or an older epoch is a no-op.
    mgr.adopt(peerEpoch);
    expect(mgr.current?.epochId).toBe(1);
    mgr.adopt({ ...peerEpoch, epochId: 0 });
    expect(mgr.current?.epochId).toBe(1);
  });
});

// -- SFrame header -----------------------------------------------------------

describe("SFrame header", () => {
  it("round-trips and carries the epoch id", () => {
    const header = encodeSFrameHeader({ version: 1, epochId: 42, counter: 7n });
    expect(header.length).toBe(SFRAME_HEADER_BYTES);
    const decoded = decodeSFrameHeader(header);
    expect(decoded.epochId).toBe(42);
    expect(decoded.counter).toBe(7n);
  });

  it("throws on a truncated header", () => {
    expect(() => decodeSFrameHeader(new Uint8Array(4))).toThrow(/truncated/);
  });
});

// -- SFrame transform --------------------------------------------------------

describe("AeadSFrameTransform", () => {
  function setup() {
    const epochs = newManager();
    const transform = new AeadSFrameTransform({ epochs, crypto: new FakeAead() });
    return { epochs, transform };
  }

  it("encrypts then decrypts a frame round-trip under the current epoch", async () => {
    const { epochs, transform } = setup();
    epochs.rotate([ALICE, BOB]); // epoch 0
    const frame = new TextEncoder().encode("hello media frame");
    const sealed = await transform.encrypt(frame);

    // The opaque payload the SFU forwards = header || ciphertext, and its header
    // carries the epoch id.
    expect(decodeSFrameHeader(sealed).epochId).toBe(0);
    expect(sealed.length).toBeGreaterThan(frame.length);

    const opened = await transform.decrypt(sealed);
    expect(new TextDecoder().decode(opened)).toBe("hello media frame");
  });

  it("a frame encrypted under epoch N FAILS to decrypt once only epoch N+1 remains (forward secrecy)", async () => {
    let clock = 1000;
    const epochs = new CallKeyEpochManager({
      keyFactory: deterministicKeyFactory,
      previousEpochWindowMs: 5_000,
      now: () => clock,
    });
    const transform = new AeadSFrameTransform({ epochs, crypto: new FakeAead() });

    epochs.rotate([ALICE, BOB]); // epoch 0
    const sealedUnderN = await transform.encrypt(new TextEncoder().encode("secret"));

    epochs.rotate([ALICE]); // epoch 1 (bob left)

    // Still inside the transition window → epoch 0 key available → decrypts.
    expect(new TextDecoder().decode(await transform.decrypt(sealedUnderN))).toBe("secret");

    // After the window the epoch-0 key is gone → the frame is undecryptable.
    clock = 1000 + 5_000;
    await expect(transform.decrypt(sealedUnderN)).rejects.toThrow(/no key for epoch 0/);
  });

  it("decrypt fails if the SFrame header is tampered (authenticated associated data)", async () => {
    const { epochs, transform } = setup();
    epochs.rotate([ALICE]); // epoch 0
    const sealed = await transform.encrypt(new TextEncoder().encode("x"));
    // Flip the counter byte inside the header → AEAD auth must reject.
    const tampered = Uint8Array.from(sealed);
    tampered[SFRAME_HEADER_BYTES - 1] ^= 0xff;
    await expect(transform.decrypt(tampered)).rejects.toThrow(/auth failed/);
  });

  it("encrypt throws before any epoch exists", async () => {
    const { transform } = setup();
    await expect(transform.encrypt(new Uint8Array([1]))).rejects.toThrow(/no current epoch/);
  });
});

// -- key distribution --------------------------------------------------------

describe("MemoryKeyDistributor", () => {
  it("announces a rotated epoch to peers, who adopt it and converge", async () => {
    const fabric = new MemoryKeyDistributorFabric();
    const initiator = new MemoryKeyDistributor(fabric);
    const peerDist = new MemoryKeyDistributor(fabric);

    const initiatorMgr = newManager();
    const peerMgr = newManager();
    peerDist.onEpoch((epoch) => peerMgr.adopt(epoch));

    // Initiator rotates on a membership change and announces over the fabric.
    const epoch = initiatorMgr.rotate([ALICE, BOB]);
    await initiator.announce(epoch);

    // Peer converged on the same (epochId, key) without minting its own.
    expect(peerMgr.current?.epochId).toBe(epoch.epochId);
    expect(Array.from(peerMgr.current!.key)).toEqual(Array.from(epoch.key));
  });

  it("does not echo an announcement back to the announcer", async () => {
    const fabric = new MemoryKeyDistributorFabric();
    const dist = new MemoryKeyDistributor(fabric);
    let received = 0;
    dist.onEpoch(() => received++);
    await dist.announce({
      epochId: 0,
      key: new Uint8Array(32),
      members: [],
      createdAt: 0,
    });
    expect(received).toBe(0);
  });
});
