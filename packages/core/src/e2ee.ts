/**
 * FR-85 — optional per-room E2EE for calls: key-epoch management seam.
 *
 * This module is the **client-side seam** a future implementation ticket
 * (FR-156) wires into the SFU media path. It is intentionally NOT a full
 * SFrame/MLS implementation — see `docs/e2ee-calls.md` for the design and the
 * threat model. What it ships is:
 *
 *   - {@link CallKeyEpochManager}: tracks the call's *current* key epoch, rotates
 *     it on a membership change (join/leave), retains the *previous* epoch for a
 *     short transition window so in-flight frames still decrypt, and looks up the
 *     key for an epoch id on receive.
 *   - {@link SFrameTransform}: the per-frame encrypt/decrypt seam. Given raw
 *     frame bytes + an epoch context it produces an opaque encrypted payload with
 *     a small epoch header (and the inverse). The reference impl
 *     ({@link AeadSFrameTransform}) is a deterministic AEAD-over-injectable-crypto
 *     implementation for the seam and its tests — it is **NOT a production SFrame
 *     cipher suite**; the real cipher suite lands in FR-156.
 *   - {@link KeyDistributor}: an abstract seam modeling how a fresh epoch key is
 *     announced/wrapped to current members over the call control plane / signal
 *     relay. Real per-recipient public-key wrapping (sender-key / MLS) is FR-156.
 *
 * FR-156 builds ON this seam: it adds a PRODUCTION SFrame cipher suite
 * ({@link SFrameCipherTransform}) with a real per-epoch key schedule (HKDF →
 * key + salt), a per-frame nonce derived from `salt XOR (sender || counter)`
 * (the RFC 9605 construction), sliding-window {@link ReplayWindow} replay
 * protection per sender, a control-plane-backed {@link SignalKeyDistributor}
 * that wraps the epoch key under a symmetric room secret and rides the additive
 * `"keyEpoch"` signal kind, and an injectable {@link FrameTransformInserter}
 * insertion seam so the SFU driver (FR-155) can encrypt-before-produce /
 * decrypt-after-consume without a browser. The reference
 * {@link AeadSFrameTransform} is retained for the FR-85 seam tests; the
 * production path is {@link SFrameCipherTransform}.
 *
 * Why a seam matters: in an SFU call (FR-83/FR-155) the media server forwards
 * SRTP it can decrypt at the transport layer, so the SFU sees media. E2EE adds a
 * SECOND, inner encryption layer applied to each frame BEFORE it reaches the SFU,
 * keyed by material the SFU never sees. The SFU forwards opaque payloads; only
 * participants hold the frame keys. Key epochs rotate the frame key on membership
 * change so a departed member can't decrypt future media and a new member can't
 * decrypt past media (forward secrecy / post-compromise security at epoch
 * granularity).
 *
 * Everything here is framework-agnostic and DOM-free: the AEAD provider is
 * injectable so it tests without a browser. The default provider lazily uses
 * `globalThis.crypto.subtle` when present.
 */

// -- crypto provider seam ----------------------------------------------------

/**
 * Minimal AEAD provider the reference transform depends on. Defining it
 * explicitly (rather than reaching for `globalThis.crypto.subtle` directly) lets
 * tests inject a deterministic fake with no browser/WebCrypto, exactly like the
 * FR-81/FR-155 drivers abstract their browser dependencies.
 *
 * The shape mirrors AES-GCM-style AEAD: `seal` encrypts `plaintext` under `key`
 * with a unique `nonce`, binding `associatedData` (the SFrame header — so the
 * epoch id is authenticated, not just attached); `open` reverses it and MUST
 * reject (throw) on any authentication failure (wrong key, tampered header,
 * tampered ciphertext).
 */
export interface AeadCryptoProvider {
  /** Encrypt + authenticate. Returns ciphertext (incl. auth tag). */
  seal(args: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly plaintext: Uint8Array;
    readonly associatedData: Uint8Array;
  }): Promise<Uint8Array>;
  /** Decrypt + verify. MUST throw if authentication fails. */
  open(args: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly ciphertext: Uint8Array;
    readonly associatedData: Uint8Array;
  }): Promise<Uint8Array>;
}

/**
 * Default AEAD provider backed by `globalThis.crypto.subtle` (AES-GCM, 12-byte
 * nonce). Constructed lazily so importing this module never requires WebCrypto;
 * the seam only touches `subtle` when E2EE is actually turned on in a browser.
 *
 * NOTE: this is a *reference* AEAD for the seam, not the negotiated SFrame
 * cipher suite. FR-156 replaces it with the real suite (and a real key schedule).
 */
export class WebCryptoAeadProvider implements AeadCryptoProvider {
  #subtle(): SubtleCryptoLike {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto?.subtle;
    if (!subtle) {
      throw new Error(
        "WebCryptoAeadProvider requires globalThis.crypto.subtle; inject an AeadCryptoProvider in non-browser environments",
      );
    }
    return subtle;
  }

  async seal(args: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly plaintext: Uint8Array;
    readonly associatedData: Uint8Array;
  }): Promise<Uint8Array> {
    const subtle = this.#subtle();
    const cryptoKey = await subtle.importKey("raw", args.key, { name: "AES-GCM" }, false, [
      "encrypt",
    ]);
    const buf = await subtle.encrypt(
      { name: "AES-GCM", iv: args.nonce, additionalData: args.associatedData },
      cryptoKey,
      args.plaintext,
    );
    return new Uint8Array(buf);
  }

  async open(args: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly ciphertext: Uint8Array;
    readonly associatedData: Uint8Array;
  }): Promise<Uint8Array> {
    const subtle = this.#subtle();
    const cryptoKey = await subtle.importKey("raw", args.key, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    const buf = await subtle.decrypt(
      { name: "AES-GCM", iv: args.nonce, additionalData: args.associatedData },
      cryptoKey,
      args.ciphertext,
    );
    return new Uint8Array(buf);
  }
}

/** The slice of `SubtleCrypto` {@link WebCryptoAeadProvider} uses. */
interface SubtleCryptoLike {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: string } | string,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyLike>;
  encrypt(
    algorithm: { name: string; iv: Uint8Array; additionalData: Uint8Array },
    key: CryptoKeyLike,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: { name: string; iv: Uint8Array; additionalData: Uint8Array },
    key: CryptoKeyLike,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  deriveBits(
    algorithm: { name: string; hash: string; salt: Uint8Array; info: Uint8Array },
    key: CryptoKeyLike,
    length: number,
  ): Promise<ArrayBuffer>;
}
type CryptoKeyLike = unknown;

// -- key-derivation provider seam (FR-156) -----------------------------------

/**
 * The key-derivation half of the crypto seam the PRODUCTION SFrame suite
 * depends on. The epoch's shared secret is never used directly as an AEAD key;
 * instead it is HKDF-expanded into a per-epoch AEAD `key` and a per-epoch `salt`
 * (the nonce-derivation input). Defining this as an injectable provider — like
 * {@link AeadCryptoProvider} — keeps the production transform deterministically
 * testable with no WebCrypto.
 */
export interface KeyDerivationProvider {
  /**
   * HKDF-expand `secret` into `length` bytes bound to a `label` (the
   * domain-separation info string, e.g. `"sframe key"` vs `"sframe salt"`).
   * Deterministic: the same `(secret, label, length)` always yields the same
   * bytes, so two members holding the same epoch secret derive identical
   * key+salt material independently.
   */
  derive(args: {
    readonly secret: Uint8Array;
    readonly label: string;
    readonly length: number;
  }): Promise<Uint8Array>;
}

/**
 * Default {@link KeyDerivationProvider} backed by `globalThis.crypto.subtle`'s
 * HKDF-SHA-256. Constructed lazily so importing this module never requires
 * WebCrypto. Tests inject a deterministic fake.
 */
export class WebCryptoKeyDerivation implements KeyDerivationProvider {
  #subtle(): SubtleCryptoLike {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto?.subtle;
    if (!subtle) {
      throw new Error(
        "WebCryptoKeyDerivation requires globalThis.crypto.subtle; inject a KeyDerivationProvider in non-browser environments",
      );
    }
    return subtle;
  }

  async derive(args: {
    readonly secret: Uint8Array;
    readonly label: string;
    readonly length: number;
  }): Promise<Uint8Array> {
    const subtle = this.#subtle();
    const key = await subtle.importKey("raw", args.secret, "HKDF", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(args.label),
      },
      key,
      args.length * 8,
    );
    return new Uint8Array(bits);
  }
}

// -- key epochs --------------------------------------------------------------

/** A monotonically increasing epoch number for a single call. */
export type EpochId = number;

/** Stable participant identity used to snapshot membership for an epoch. */
export interface CallMember {
  readonly userId: string;
  readonly deviceId: string;
}

/**
 * A key epoch: an immutable `(epochId, key)` bound to the membership snapshot
 * it was rotated for. The `key` is the symmetric frame-key material every
 * current member shares for this epoch; senders tag each frame with `epochId`
 * so receivers know which key to use.
 */
export interface KeyEpoch {
  readonly epochId: EpochId;
  readonly key: Uint8Array;
  /** Sorted member ids this epoch's key was distributed to. */
  readonly members: readonly string[];
  /** When this epoch became current (epoch ms). Used to age out the previous epoch. */
  readonly createdAt: number;
}

/** Derives fresh epoch key material on rotation. Injectable for deterministic tests. */
export type EpochKeyFactory = (epochId: EpochId, members: readonly string[]) => Uint8Array;

export interface CallKeyEpochManagerOptions {
  /**
   * How long (ms) a superseded epoch's key is still accepted on *receive* after
   * a rotation, so frames already in flight under the old epoch still decrypt
   * during the transition. After this window the previous epoch is dropped
   * (a departed member's key stops working → forward secrecy). Default 5_000.
   */
  readonly previousEpochWindowMs?: number;
  /** Override key derivation (tests inject a deterministic factory). */
  readonly keyFactory?: EpochKeyFactory;
  /** Override the clock (tests inject a fake). Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Largest forward jump in epochId a single {@link CallKeyEpochManager.adopt}
   * is allowed to take relative to the current epoch. An adopted epoch beyond
   * `current.epochId + maxEpochJump` is rejected (no state change), so even an
   * *authenticated* but malicious announcement carrying an implausibly large
   * epochId (e.g. 2^31) cannot leap the local counter and wedge all subsequent
   * legitimate epochs (which only ever advance by ~1 per membership change).
   * Generous default (1024) tolerates missed announcements / churn bursts while
   * still bounding the blast radius. See crypto-e2ee-5.
   */
  readonly maxEpochJump?: number;
}

/** A stable, sorted member-id list from a membership snapshot. */
export function memberKey(member: CallMember): string {
  return `${member.userId}:${member.deviceId}`;
}

function snapshotMembers(members: readonly CallMember[]): string[] {
  return members.map(memberKey).sort();
}

/** Default key factory: 32 random bytes per epoch (replaced by the real key schedule in FR-156). */
function defaultKeyFactory(): Uint8Array {
  const key = new Uint8Array(32);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(key);
  } else {
    // Non-crypto fallback so the seam is usable in bare Node without WebCrypto.
    // The real key schedule (FR-156) never relies on this.
    for (let i = 0; i < key.length; i++) key[i] = Math.floor(Math.random() * 256);
  }
  return key;
}

/**
 * Manages the key epochs for ONE call on the client side. It does not move
 * bytes and is transport-agnostic: a caller drives {@link rotate} from call
 * membership changes (observed via the existing CallParticipant records / call
 * event stream) and feeds the resulting {@link KeyEpoch} to the
 * {@link KeyDistributor} (to announce it to peers over the control plane) and to
 * the {@link SFrameTransform} (to key outbound frames).
 *
 * Receive side: {@link keyFor} resolves the key for an inbound frame's epoch id,
 * accepting the current epoch and — during the transition window — the
 * immediately-previous epoch.
 */
export class CallKeyEpochManager {
  #current: KeyEpoch | undefined;
  #previous: KeyEpoch | undefined;
  /**
   * Local-clock timestamp (this.#now()) at the moment #previous was DEMOTED from
   * current — NOT the epoch's createdAt. The transition window is measured from
   * supersession, on the local clock, so it is correct regardless of how long the
   * superseded epoch was current and immune to remote announcer clock skew
   * (createdAt may be a peer's clock). See crypto-e2ee-1.
   */
  #previousDemotedAt = 0;
  readonly #windowMs: number;
  readonly #keyFactory: EpochKeyFactory;
  readonly #now: () => number;
  readonly #maxEpochJump: number;

  constructor(options: CallKeyEpochManagerOptions = {}) {
    this.#windowMs = options.previousEpochWindowMs ?? 5_000;
    this.#keyFactory = options.keyFactory ?? ((_id, _members) => defaultKeyFactory());
    this.#now = options.now ?? Date.now;
    this.#maxEpochJump = options.maxEpochJump ?? 1024;
  }

  /** The current epoch, or undefined before the first {@link rotate}. */
  get current(): KeyEpoch | undefined {
    return this.#current;
  }

  /** The previous epoch while it is still inside the transition window, else undefined. */
  get previous(): KeyEpoch | undefined {
    this.#expirePrevious();
    return this.#previous;
  }

  /**
   * Rotate to a fresh epoch for the given membership snapshot. Produces a new
   * `epochId` (monotonic) and fresh key material, retiring the prior epoch to the
   * transition-window slot. Called on every membership change (join/leave) so the
   * frame key never outlives the membership it was bound to.
   *
   * Idempotency note: rotation is unconditional by design — callers decide when
   * membership actually changed; the manager just mints the next epoch.
   */
  rotate(members: readonly CallMember[]): KeyEpoch {
    const epochId = this.#current ? this.#current.epochId + 1 : 0;
    const snapshot = snapshotMembers(members);
    const epoch: KeyEpoch = {
      epochId,
      key: this.#keyFactory(epochId, snapshot),
      members: snapshot,
      createdAt: this.#now(),
    };
    // The just-superseded epoch becomes the transition-window "previous"; any
    // older previous is dropped immediately (we keep at most one prior epoch).
    // Stamp the demotion on the LOCAL clock so the window is measured from
    // supersession, not from the epoch's createdAt (crypto-e2ee-1).
    this.#demote(this.#current);
    this.#current = epoch;
    return epoch;
  }

  /**
   * Adopt an epoch announced by a peer (received via the {@link KeyDistributor}
   * over the control plane) rather than minting one locally. Used by members who
   * did NOT trigger the rotation: the rotation initiator distributes the new
   * epoch and everyone else adopts it so all participants converge on the same
   * `(epochId, key)`. Ignores an epoch we already have or an older one.
   *
   * Defends against monotonic-counter poisoning (crypto-e2ee-5): an epoch whose
   * id leaps more than `maxEpochJump` past the current one is rejected outright
   * — no state change — so a single (even authenticated) malicious announcement
   * carrying an absurd epochId cannot wedge adoption of all later legitimate
   * epochs. Returns true iff the epoch was adopted.
   */
  adopt(epoch: KeyEpoch): boolean {
    if (this.#current && epoch.epochId <= this.#current.epochId) return false;
    if (this.#current && epoch.epochId - this.#current.epochId > this.#maxEpochJump) {
      // Implausible forward jump → refuse so the local counter can't be poisoned.
      return false;
    }
    this.#demote(this.#current);
    this.#current = epoch;
    return true;
  }

  /**
   * Move `epoch` into the transition-window "previous" slot, stamping the LOCAL
   * clock so {@link #expirePrevious} measures the window from supersession (not
   * the epoch's createdAt, which may be a remote announcer's clock).
   */
  #demote(epoch: KeyEpoch | undefined): void {
    this.#previous = epoch;
    if (epoch) this.#previousDemotedAt = this.#now();
  }

  /**
   * Resolve the key to use for a frame tagged with `epochId` on receive.
   * Accepts the current epoch and the immediately-previous epoch while it is
   * still inside the transition window; returns undefined otherwise (the frame
   * is undecryptable and must be dropped — e.g. a departed member's old epoch
   * after the window, giving forward secrecy at epoch granularity).
   */
  keyFor(epochId: EpochId): Uint8Array | undefined {
    if (this.#current?.epochId === epochId) return this.#current.key;
    this.#expirePrevious();
    if (this.#previous?.epochId === epochId) return this.#previous.key;
    return undefined;
  }

  #expirePrevious(): void {
    if (!this.#previous) return;
    // Measure from the LOCAL demotion timestamp, never the (possibly remote)
    // createdAt — so the window is exactly `windowMs` from supersession and is
    // not skewed by a peer's clock (crypto-e2ee-1).
    if (this.#now() - this.#previousDemotedAt >= this.#windowMs) {
      this.#previous = undefined;
    }
  }
}

// -- key distribution seam ---------------------------------------------------

/**
 * Abstract seam for announcing a freshly-rotated {@link KeyEpoch} to the call's
 * current members and for receiving epochs announced by peers. The transport is
 * the EXISTING call control plane / `WebRTCSignal` relay (a future `keyEpoch`
 * signal kind), NOT a new channel — see `docs/e2ee-calls.md`.
 *
 * This interface is deliberately abstract: the reference flow distributes the
 * raw epoch (suitable for the in-memory/test fabric). The real implementation
 * (FR-156) wraps the key *per recipient* (sender-key today, MLS later) so the
 * key material is never exposed to the SFU or the control-plane server — only
 * the wrapped blobs ride the relay.
 */
export interface KeyDistributor {
  /** Announce a newly-rotated epoch to current members. Best-effort. */
  announce(epoch: KeyEpoch): Promise<void>;
  /** Subscribe to epochs announced by peers. Returns an unsubscribe fn. */
  onEpoch(listener: (epoch: KeyEpoch) => void): () => void;
}

/**
 * In-memory {@link KeyDistributor} for the seam and its tests: announcing on one
 * instance delivers to every *other* instance sharing the same
 * {@link MemoryKeyDistributorFabric}. Mirrors `MemoryRegionFabric`/`MemoryRegionBus`
 * (FR-105) — a deterministic single-process stand-in for the real
 * control-plane-backed distributor.
 *
 * SECURITY NOTE: this passes raw key material through the fabric. That is fine
 * for an in-process test where there is no untrusted middlebox; the production
 * distributor (FR-156) MUST wrap keys per recipient so the relay/SFU never sees
 * them.
 */
export class MemoryKeyDistributorFabric {
  readonly #peers = new Set<(epoch: KeyEpoch) => void>();

  attach(listener: (epoch: KeyEpoch) => void): () => void {
    this.#peers.add(listener);
    return () => this.#peers.delete(listener);
  }

  broadcast(from: (epoch: KeyEpoch) => void, epoch: KeyEpoch): void {
    for (const peer of this.#peers) {
      if (peer === from) continue; // don't echo to the announcer
      try {
        peer(epoch);
      } catch {
        // Isolate per-peer failures.
      }
    }
  }
}

export class MemoryKeyDistributor implements KeyDistributor {
  readonly #fabric: MemoryKeyDistributorFabric;
  readonly #listeners = new Set<(epoch: KeyEpoch) => void>();
  readonly #self: (epoch: KeyEpoch) => void;
  #detach: (() => void) | undefined;

  constructor(fabric: MemoryKeyDistributorFabric) {
    this.#fabric = fabric;
    this.#self = (epoch) => {
      for (const listener of this.#listeners) {
        try {
          listener(epoch);
        } catch {
          // Isolate per-listener failures.
        }
      }
    };
    this.#detach = this.#fabric.attach(this.#self);
  }

  async announce(epoch: KeyEpoch): Promise<void> {
    this.#fabric.broadcast(this.#self, epoch);
  }

  onEpoch(listener: (epoch: KeyEpoch) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#detach?.();
    this.#detach = undefined;
    this.#listeners.clear();
  }
}

// -- SFrame transform seam ---------------------------------------------------

/**
 * The fixed-size SFrame header the reference transform prepends to every
 * encrypted frame. Real SFrame uses a compact variable-length header; this is a
 * deliberately simple, self-describing layout for the seam/tests. The header is
 * passed as AEAD associated data so the epoch id is *authenticated*, not merely
 * attached — a receiver can't be tricked into decrypting under the wrong epoch.
 *
 * Layout (big-endian):
 *   byte 0      : version (1)
 *   bytes 1..4  : epochId (uint32)
 *   bytes 5..12 : frame counter (uint64) — the per-epoch nonce source
 */
export const SFRAME_HEADER_BYTES = 13;
const SFRAME_VERSION = 1;

export interface SFrameHeader {
  readonly version: number;
  readonly epochId: EpochId;
  readonly counter: bigint;
}

export function encodeSFrameHeader(header: SFrameHeader): Uint8Array {
  const out = new Uint8Array(SFRAME_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, header.version);
  view.setUint32(1, header.epochId, false);
  view.setBigUint64(5, header.counter, false);
  return out;
}

export function decodeSFrameHeader(bytes: Uint8Array): SFrameHeader {
  if (bytes.length < SFRAME_HEADER_BYTES) {
    throw new Error("SFrame header truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint8(0),
    epochId: view.getUint32(1, false),
    counter: view.getBigUint64(5, false),
  };
}

/**
 * The per-frame encrypt/decrypt seam. A future implementation (FR-156) inserts
 * an {@link SFrameTransform} into the FR-155 media path: `encrypt` runs on
 * outbound frames just before they reach the SFU producer, `decrypt` runs on
 * inbound frames just after they leave the SFU consumer. The SFU only ever sees
 * the {@link encrypt} output (header + ciphertext) and forwards it opaquely.
 */
export interface SFrameTransform {
  /**
   * Encrypt a raw media frame under the current epoch. Returns
   * `header || ciphertext`, where the header carries the epoch id the receiver
   * needs to pick the key.
   */
  encrypt(frame: Uint8Array): Promise<Uint8Array>;
  /**
   * Decrypt a framed payload. Reads the epoch id from the header, resolves the
   * key via the {@link CallKeyEpochManager}, and authenticates the header as
   * associated data. Throws if the epoch key is unavailable (dropped/expired) or
   * authentication fails.
   */
  decrypt(payload: Uint8Array): Promise<Uint8Array>;
}

export interface AeadSFrameTransformOptions {
  readonly epochs: CallKeyEpochManager;
  /** AEAD provider; defaults to {@link WebCryptoAeadProvider}. Tests inject a fake. */
  readonly crypto?: AeadCryptoProvider;
}

/**
 * Reference {@link SFrameTransform} over an injectable {@link AeadCryptoProvider}.
 *
 * !!! NOT PRODUCTION CRYPTO !!! This exists to validate the SEAM and to give the
 * tests a deterministic encrypt→decrypt path with no browser. It uses a single
 * AEAD pass with the epoch key, a monotonic per-epoch frame counter as the nonce
 * source, and the SFrame header as associated data. The real SFrame cipher suite
 * — key derivation (per-sender keys / ratchet), nonce construction, salt, tag
 * handling, replay protection — is the subject of FR-156. Do not ship this as-is.
 */
export class AeadSFrameTransform implements SFrameTransform {
  readonly #epochs: CallKeyEpochManager;
  readonly #crypto: AeadCryptoProvider;
  /** Per-epoch monotonic frame counter, reset implicitly per epoch via the map. */
  readonly #counters = new Map<EpochId, bigint>();

  constructor(options: AeadSFrameTransformOptions) {
    this.#epochs = options.epochs;
    this.#crypto = options.crypto ?? new WebCryptoAeadProvider();
  }

  async encrypt(frame: Uint8Array): Promise<Uint8Array> {
    const epoch = this.#epochs.current;
    if (!epoch) {
      throw new Error("AeadSFrameTransform.encrypt: no current epoch (call rotate first)");
    }
    const counter = this.#nextCounter(epoch.epochId);
    const header = encodeSFrameHeader({
      version: SFRAME_VERSION,
      epochId: epoch.epochId,
      counter,
    });
    const ciphertext = await this.#crypto.seal({
      key: epoch.key,
      nonce: nonceFor(epoch.epochId, counter),
      plaintext: frame,
      associatedData: header,
    });
    return concat(header, ciphertext);
  }

  async decrypt(payload: Uint8Array): Promise<Uint8Array> {
    const header = decodeSFrameHeader(payload);
    if (header.version !== SFRAME_VERSION) {
      throw new Error(`AeadSFrameTransform.decrypt: unsupported SFrame version ${header.version}`);
    }
    const key = this.#epochs.keyFor(header.epochId);
    if (!key) {
      throw new Error(
        `AeadSFrameTransform.decrypt: no key for epoch ${header.epochId} (expired or unknown)`,
      );
    }
    const ciphertext = payload.subarray(SFRAME_HEADER_BYTES);
    const headerBytes = payload.subarray(0, SFRAME_HEADER_BYTES);
    return this.#crypto.open({
      key,
      nonce: nonceFor(header.epochId, header.counter),
      ciphertext,
      associatedData: headerBytes,
    });
  }

  #nextCounter(epochId: EpochId): bigint {
    const next = (this.#counters.get(epochId) ?? 0n) + 1n;
    this.#counters.set(epochId, next);
    return next;
  }
}

/** 12-byte AEAD nonce derived from the epoch id + frame counter (reference only). */
function nonceFor(epochId: EpochId, counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, epochId, false);
  view.setBigUint64(4, counter, false);
  return nonce;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ===========================================================================
// FR-156 — PRODUCTION SFrame cipher suite
// ===========================================================================
//
// The reference AeadSFrameTransform above validates the FR-85 seam. Everything
// below is the real, shippable path: a proper key schedule (HKDF), a per-frame
// nonce built per RFC 9605, an authenticated header carrying the SENDER id (so
// nonces never collide across senders sharing one epoch key), and sliding-
// window replay protection on receive. It still runs over the SAME injectable
// providers so it stays deterministically testable with no browser.

/**
 * The production SFrame header. Unlike the fixed reference header it carries a
 * `senderId` so (a) the per-frame nonce is unique per sender even though all
 * members share one epoch key, and (b) replay state can be tracked per sender.
 * The whole header is authenticated as AEAD associated data.
 *
 * Layout (big-endian):
 *   byte 0      : version (2)
 *   bytes 1..4  : epochId  (uint32)
 *   bytes 5..8  : senderId (uint32) — stable per-call sender ordinal
 *   bytes 9..16 : counter  (uint64) — per-(epoch,sender) monotonic frame counter
 */
export const SFRAME_V2_HEADER_BYTES = 17;
const SFRAME_V2_VERSION = 2;

/** A stable per-call sender ordinal (e.g. derived from sorted member id). */
export type SenderId = number;

export interface SFrameV2Header {
  readonly version: number;
  readonly epochId: EpochId;
  readonly senderId: SenderId;
  readonly counter: bigint;
}

export function encodeSFrameV2Header(header: SFrameV2Header): Uint8Array {
  const out = new Uint8Array(SFRAME_V2_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, header.version);
  view.setUint32(1, header.epochId, false);
  view.setUint32(5, header.senderId, false);
  view.setBigUint64(9, header.counter, false);
  return out;
}

export function decodeSFrameV2Header(bytes: Uint8Array): SFrameV2Header {
  if (bytes.length < SFRAME_V2_HEADER_BYTES) {
    throw new Error("SFrame v2 header truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint8(0),
    epochId: view.getUint32(1, false),
    senderId: view.getUint32(5, false),
    counter: view.getBigUint64(9, false),
  };
}

// -- replay protection -------------------------------------------------------

/** AEAD nonce length in bytes (AES-GCM standard 96-bit IV). */
const SFRAME_NONCE_BYTES = 12;

/**
 * Sliding-window replay guard for a single (epoch, sender) stream. Tracks the
 * highest counter seen and a bitmap of the `windowSize` counters below it, so a
 * replayed or stale frame is rejected while legitimate reordering inside the
 * window is still accepted (media frames can arrive slightly out of order).
 *
 * `check(counter)` returns true and records the counter if it is fresh; returns
 * false (without recording) if it is a replay or has fallen off the bottom of
 * the window. Counter 0 is reserved/never used (counters start at 1), so a
 * never-seen stream has `#highest === 0n`.
 */
export class ReplayWindow {
  readonly #size: bigint;
  #highest = 0n;
  /** Bitmap of seen counters in (#highest - size, #highest]; bit 0 == #highest. */
  #bitmap = 0n;

  constructor(windowSize = 1024) {
    if (windowSize < 1) throw new Error("ReplayWindow size must be >= 1");
    this.#size = BigInt(windowSize);
  }

  /** Test whether `counter` is fresh without recording it. */
  seen(counter: bigint): boolean {
    if (counter <= 0n) return true; // 0 is reserved → treat as replay
    if (counter > this.#highest) return false;
    const delta = this.#highest - counter;
    if (delta >= this.#size) return true; // below the window → treat as replay
    return (this.#bitmap & (1n << delta)) !== 0n;
  }

  /**
   * Validate + record `counter`. Returns false (and records nothing) for a
   * replay or an out-of-window-old counter; returns true and advances the
   * window otherwise.
   */
  check(counter: bigint): boolean {
    if (counter <= 0n) return false;
    if (counter > this.#highest) {
      const shift = counter - this.#highest;
      // Slide the window up; bits shifted past `size` drop off the bottom.
      this.#bitmap = shift >= this.#size ? 0n : (this.#bitmap << shift) & this.#mask();
      this.#bitmap |= 1n; // mark the new highest (bit 0)
      this.#highest = counter;
      return true;
    }
    const delta = this.#highest - counter;
    if (delta >= this.#size) return false; // too old
    const bit = 1n << delta;
    if ((this.#bitmap & bit) !== 0n) return false; // replay
    this.#bitmap |= bit;
    return true;
  }

  #mask(): bigint {
    return (1n << this.#size) - 1n;
  }
}

// -- production cipher suite --------------------------------------------------

/**
 * Per-epoch derived key material: the AEAD `key` and the nonce `salt`, both
 * HKDF-expanded from the epoch's shared secret. Cached per epoch id so the HKDF
 * runs once per epoch, not once per frame.
 */
interface DerivedEpochKeys {
  readonly key: Uint8Array;
  readonly salt: Uint8Array;
}

const SFRAME_KEY_BYTES = 16; // AES-128-GCM by default
const SFRAME_KEY_LABEL = "fricken/sframe/v2 key";
const SFRAME_SALT_LABEL = "fricken/sframe/v2 salt";

export interface SFrameCipherTransformOptions {
  readonly epochs: CallKeyEpochManager;
  /**
   * This client's stable per-call sender ordinal. Stamped into every outbound
   * header so receivers derive the matching nonce and track replay per sender.
   */
  readonly senderId: SenderId;
  /** AEAD provider; defaults to {@link WebCryptoAeadProvider}. Tests inject a fake. */
  readonly aead?: AeadCryptoProvider;
  /** Key-derivation provider; defaults to {@link WebCryptoKeyDerivation}. */
  readonly kdf?: KeyDerivationProvider;
  /** Replay window size (frames). Default 1024. */
  readonly replayWindow?: number;
  /**
   * Maximum number of distinct senders tracked per epoch on the receive path.
   * Replay windows (and derived state) are allocated only AFTER a frame
   * authenticates (crypto-e2ee-3), and the count of authenticated senders per
   * epoch is capped here (LRU-evicted) so an attacker cannot grow memory without
   * bound. A real call has a handful of senders; the default (256) is far above
   * any plausible participant count while still bounding the blast radius.
   */
  readonly maxSendersPerEpoch?: number;
}

/**
 * PRODUCTION {@link SFrameTransform}. Per frame:
 *
 *  - Outbound: derive (once per epoch, cached) `key`+`salt` from the epoch
 *    secret via HKDF; take the next per-(epoch,sender) counter; build the v2
 *    header (epoch + sender + counter); derive the 96-bit nonce as
 *    `salt XOR (senderId || counter)`; AES-GCM-seal the frame with the header
 *    as AAD; emit `header || ciphertext`.
 *  - Inbound: read the header, resolve the epoch key (via the epoch manager's
 *    transition window), reject the frame if its (epoch,sender,counter) is a
 *    replay or too old (sliding {@link ReplayWindow} per sender), then derive
 *    the same nonce and AES-GCM-open — which also fails closed on any header or
 *    ciphertext tampering or a wrong-epoch key.
 *
 * Nonce uniqueness: the (epoch secret → salt) is unique per epoch; XOR-ing in
 * `senderId || counter` makes each (epoch, sender, counter) triple a distinct
 * nonce, so no two frames ever reuse an (key, nonce) pair — the AES-GCM
 * security requirement.
 */
export class SFrameCipherTransform implements SFrameTransform {
  readonly #epochs: CallKeyEpochManager;
  readonly #senderId: SenderId;
  readonly #aead: AeadCryptoProvider;
  readonly #kdf: KeyDerivationProvider;
  readonly #replayWindowSize: number;
  readonly #maxSendersPerEpoch: number;
  /** Cached derived (key,salt) per epoch id, keyed by the epoch's identity. */
  readonly #derived = new Map<EpochId, { secret: Uint8Array; keys: Promise<DerivedEpochKeys> }>();
  /** Outbound per-epoch frame counter for THIS sender. */
  readonly #counters = new Map<EpochId, bigint>();
  /**
   * Inbound replay windows, keyed by `${epochId}:${senderId}`. A Map preserves
   * insertion order, which we use for LRU eviction (crypto-e2ee-3). Entries are
   * created ONLY after a frame authenticates, never on a pre-auth header lookup.
   */
  readonly #replay = new Map<string, ReplayWindow>();
  /**
   * Per-(epoch,sender) serialization tail. The replay pre-screen and the
   * post-auth commit straddle two awaits; without serialization two concurrent
   * decrypts of the SAME counter could both pass the pre-screen and both succeed
   * (crypto-e2ee-2). Chaining each decrypt for a given key behind the previous
   * one makes seen()→…→check() atomic with respect to other frames of that
   * stream, so a duplicated counter is accepted at most once.
   */
  readonly #decryptTail = new Map<string, Promise<unknown>>();

  constructor(options: SFrameCipherTransformOptions) {
    this.#epochs = options.epochs;
    // Reject an out-of-range senderId instead of silently truncating to 32 bits
    // (crypto-e2ee-7): truncation would let two distinct logical senders collapse
    // to one 32-bit ordinal and reuse the (key, nonce) pair under AES-GCM. The
    // caller MUST assign a collision-free per-call ordinal in [0, 2^32).
    if (!Number.isInteger(options.senderId) || options.senderId < 0 || options.senderId > 0xffff_ffff) {
      throw new RangeError(
        `SFrameCipherTransform: senderId must be an integer in [0, 2^32); got ${options.senderId}. ` +
          `Assign a collision-free per-call ordinal (e.g. the sorted member index).`,
      );
    }
    this.#senderId = options.senderId;
    this.#aead = options.aead ?? new WebCryptoAeadProvider();
    this.#kdf = options.kdf ?? new WebCryptoKeyDerivation();
    this.#replayWindowSize = options.replayWindow ?? 1024;
    this.#maxSendersPerEpoch = options.maxSendersPerEpoch ?? 256;
  }

  async encrypt(frame: Uint8Array): Promise<Uint8Array> {
    const epoch = this.#epochs.current;
    if (!epoch) {
      throw new Error("SFrameCipherTransform.encrypt: no current epoch (call rotate first)");
    }
    const { key, salt } = await this.#deriveFor(epoch.epochId, epoch.key);
    const counter = this.#nextCounter(epoch.epochId);
    const header = encodeSFrameV2Header({
      version: SFRAME_V2_VERSION,
      epochId: epoch.epochId,
      senderId: this.#senderId,
      counter,
    });
    const ciphertext = await this.#aead.seal({
      key,
      nonce: deriveNonce(salt, this.#senderId, counter),
      plaintext: frame,
      associatedData: header,
    });
    return concat(header, ciphertext);
  }

  async decrypt(payload: Uint8Array): Promise<Uint8Array> {
    const header = decodeSFrameV2Header(payload);
    if (header.version !== SFRAME_V2_VERSION) {
      throw new Error(`SFrameCipherTransform.decrypt: unsupported SFrame version ${header.version}`);
    }
    // Serialize all decrypts for one (epoch,sender) stream so the replay
    // pre-screen and post-auth commit are atomic — two concurrent decrypts of
    // the same counter cannot both pass (crypto-e2ee-2). Different streams stay
    // fully parallel. We chain on a tail promise and clean it up when we are the
    // last in line.
    const streamKey = `${header.epochId}:${header.senderId}`;
    const prior = this.#decryptTail.get(streamKey) ?? Promise.resolve();
    const run = prior.then(
      () => this.#decryptSerialized(payload, header),
      () => this.#decryptSerialized(payload, header),
    );
    this.#decryptTail.set(streamKey, run);
    try {
      return await run;
    } finally {
      if (this.#decryptTail.get(streamKey) === run) this.#decryptTail.delete(streamKey);
    }
  }

  /** The body of {@link decrypt}, run under the per-stream serialization lock. */
  async #decryptSerialized(payload: Uint8Array, header: SFrameV2Header): Promise<Uint8Array> {
    const secret = this.#epochs.keyFor(header.epochId);
    if (!secret) {
      // The epoch is gone (expired/unknown). Drop any state we no longer need so
      // long-lived calls don't leak across rotations (crypto-e2ee-3).
      this.#pruneStaleEpochs();
      throw new Error(
        `SFrameCipherTransform.decrypt: no key for epoch ${header.epochId} (expired or unknown)`,
      );
    }
    // Replay pre-screen against an EXISTING window only — we never allocate a new
    // window for an unauthenticated header (crypto-e2ee-3), so an attacker varying
    // senderId on injected frames can't grow memory before auth. `seen()` is
    // non-mutating; the counter is committed only after the AEAD authenticates,
    // so a forged frame can't poison the window and starve the real future frame.
    const existing = this.#replay.get(`${header.epochId}:${header.senderId}`);
    if (existing?.seen(header.counter)) {
      throw new Error(
        `SFrameCipherTransform.decrypt: replayed or stale frame (epoch ${header.epochId} sender ${header.senderId} counter ${header.counter})`,
      );
    }
    const { key, salt } = await this.#deriveFor(header.epochId, secret);
    const ciphertext = payload.subarray(SFRAME_V2_HEADER_BYTES);
    const headerBytes = payload.subarray(0, SFRAME_V2_HEADER_BYTES);
    const plaintext = await this.#aead.open({
      key,
      nonce: deriveNonce(salt, header.senderId, header.counter),
      ciphertext,
      associatedData: headerBytes,
    });
    // Authenticated: now it is safe to allocate the window (bounded per epoch) and
    // commit the counter. A second concurrent decrypt of this counter, serialized
    // behind us, will now see it via seen() and be rejected (crypto-e2ee-2).
    // Defense-in-depth: gate the RETURN on check() too — if a concurrent committer
    // already recorded this counter, check() returns false and we reject rather
    // than emit a duplicate plaintext, so a replay is never accepted twice even if
    // the serialization above were somehow bypassed.
    const window = this.#commitWindowFor(header.epochId, header.senderId);
    if (!window.check(header.counter)) {
      throw new Error(
        `SFrameCipherTransform.decrypt: replayed or stale frame (epoch ${header.epochId} sender ${header.senderId} counter ${header.counter})`,
      );
    }
    return plaintext;
  }

  /**
   * Look up (or lazily create) the replay window for an AUTHENTICATED frame,
   * bounding the number of senders tracked per epoch via LRU eviction so memory
   * cannot grow without bound even if many distinct senders legitimately appear
   * (crypto-e2ee-3). Touch-on-access keeps active senders hot.
   */
  #commitWindowFor(epochId: EpochId, senderId: SenderId): ReplayWindow {
    const k = `${epochId}:${senderId}`;
    const found = this.#replay.get(k);
    if (found) {
      // Refresh LRU recency (re-insert at the tail).
      this.#replay.delete(k);
      this.#replay.set(k, found);
      return found;
    }
    // Evict the least-recently-used sender(s) for THIS epoch if at capacity.
    const prefix = `${epochId}:`;
    let tracked = 0;
    for (const key of this.#replay.keys()) if (key.startsWith(prefix)) tracked++;
    if (tracked >= this.#maxSendersPerEpoch) {
      for (const key of this.#replay.keys()) {
        if (key.startsWith(prefix)) {
          this.#replay.delete(key); // oldest insertion for this epoch
          break;
        }
      }
    }
    const w = new ReplayWindow(this.#replayWindowSize);
    this.#replay.set(k, w);
    return w;
  }

  /**
   * Drop derived-key / counter / replay state for epochs the manager can no
   * longer resolve (neither current nor inside the previous-epoch window), so a
   * long-lived call doesn't accumulate per-epoch state forever (crypto-e2ee-3).
   */
  #pruneStaleEpochs(): void {
    const live = new Set<EpochId>();
    const cur = this.#epochs.current;
    const prev = this.#epochs.previous;
    if (cur) live.add(cur.epochId);
    if (prev) live.add(prev.epochId);
    for (const epochId of this.#derived.keys()) if (!live.has(epochId)) this.#derived.delete(epochId);
    for (const epochId of this.#counters.keys()) if (!live.has(epochId)) this.#counters.delete(epochId);
    for (const key of this.#replay.keys()) {
      const epochId = Number(key.slice(0, key.indexOf(":")));
      if (!live.has(epochId)) this.#replay.delete(key);
    }
  }

  /**
   * Diagnostic snapshot of the receive-side bookkeeping: how many replay windows
   * (one per authenticated `(epoch,sender)`) and per-epoch derived-key entries
   * are currently retained. Used for operational metrics and to assert the
   * memory bounds (crypto-e2ee-3) in tests. Reading it never mutates state.
   */
  trackedState(): { readonly replayWindows: number; readonly derivedEpochs: number } {
    return { replayWindows: this.#replay.size, derivedEpochs: this.#derived.size };
  }

  #deriveFor(epochId: EpochId, secret: Uint8Array): Promise<DerivedEpochKeys> {
    const cached = this.#derived.get(epochId);
    if (cached && bytesEqual(cached.secret, secret)) return cached.keys;
    const keys = (async (): Promise<DerivedEpochKeys> => {
      const [key, salt] = await Promise.all([
        this.#kdf.derive({ secret, label: SFRAME_KEY_LABEL, length: SFRAME_KEY_BYTES }),
        this.#kdf.derive({ secret, label: SFRAME_SALT_LABEL, length: SFRAME_NONCE_BYTES }),
      ]);
      return { key, salt };
    })();
    this.#derived.set(epochId, { secret: Uint8Array.from(secret), keys });
    return keys;
  }

  #nextCounter(epochId: EpochId): bigint {
    const next = (this.#counters.get(epochId) ?? 0n) + 1n;
    this.#counters.set(epochId, next);
    return next;
  }
}

/**
 * Derive the 96-bit AES-GCM nonce as `salt XOR (0…0 || senderId(4) ||
 * counter(8))` — the RFC 9605 IV construction. `salt` is the per-epoch
 * 12-byte secret; the low 12 bytes encode (senderId, counter) so every
 * (epoch, sender, counter) yields a distinct nonce.
 */
function deriveNonce(salt: Uint8Array, senderId: SenderId, counter: bigint): Uint8Array {
  const nonce = new Uint8Array(SFRAME_NONCE_BYTES);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, senderId >>> 0, false);
  view.setBigUint64(4, counter, false);
  for (let i = 0; i < SFRAME_NONCE_BYTES; i++) {
    nonce[i] = (nonce[i] ?? 0) ^ (salt[i] ?? 0);
  }
  return nonce;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ===========================================================================
// FR-156 — control-plane key-epoch distribution (symmetric sender-key)
// ===========================================================================
//
// The PRODUCTION distributor announces a freshly-rotated epoch to current
// members over the EXISTING WebRTCSignal relay (the additive "keyEpoch" signal
// kind), NOT a new transport. The epoch key is WRAPPED under a symmetric
// per-room secret (a pre-shared / transport-derived key every member holds) so
// the relay and SFU only ever see opaque ciphertext — the sender-key scheme the
// design recommends as the starting point. Per-recipient ASYMMETRIC wrapping /
// MLS is the genuine future step and is intentionally left to the pluggable
// KeyDistributor seam (see docs/e2ee-calls.md "Follow-ups").

/**
 * The minimal slice of the Frick client the signal-backed distributor needs —
 * the same `sendSignal` / `signalChannel` pair the P2P driver (FR-81) and SFU
 * driver (FR-155) use. Defined structurally so tests inject an in-memory bus
 * with no runtime.
 */
export interface SignalRelayClient {
  sendSignal(name: string, key: string, value: Record<string, unknown>): Promise<void>;
  signalChannel(name: string, key: string): { get(): readonly Record<string, unknown>[] };
}

/** The opaque `"keyEpoch"` signal payload: a wrapped epoch announcement. */
export interface KeyEpochSignal {
  readonly senderDeviceId: string;
  readonly kind: "keyEpoch";
  readonly epochId: EpochId;
  readonly members: readonly string[];
  readonly createdAt: number;
  /** Base64 AES-GCM nonce used to wrap the key. */
  readonly wrapNonce: string;
  /** Base64 AES-GCM ciphertext of the raw epoch key (wrapped under the room secret). */
  readonly wrappedKey: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export interface SignalKeyDistributorOptions {
  readonly client: SignalRelayClient;
  readonly callId: string;
  /** This device's id (stamped on announcements; used to drop our own echoes). */
  readonly senderDeviceId: string;
  /**
   * The symmetric per-room secret the epoch key is wrapped under. Every member
   * holds the same secret (pre-shared out of band, or transport-derived). The
   * relay/SFU never see it — they carry only the wrapped blob.
   */
  readonly roomSecret: Uint8Array;
  /** AEAD provider used to wrap/unwrap. Defaults to {@link WebCryptoAeadProvider}. */
  readonly aead?: AeadCryptoProvider;
  /** KDF used to derive the wrap key from the room secret. Default WebCrypto HKDF. */
  readonly kdf?: KeyDerivationProvider;
  /** Nonce source for wrapping (12 random bytes). Tests inject a deterministic one. */
  readonly randomNonce?: () => Uint8Array;
  /** Signal type name; defaults to the shared WebRTC signal relay type. */
  readonly signalType?: string;
  /**
   * Largest forward jump in epochId the receiver will surface in a single
   * `poll()` relative to the highest already seen. Bounds monotonic-counter
   * poisoning (crypto-e2ee-5): a single room-secret holder cannot push an absurd
   * epochId that wedges all later legitimate epochs. Default 1024.
   *
   * NOTE on authentication (crypto-e2ee-4): the symmetric scheme authenticates
   * only that the announcer holds the ROOM SECRET — every current member does, so
   * any member (or a leaked-secret holder) can forge an announcement. This is
   * inherent to sender-key distribution; use {@link AsymmetricKeyDistributor}
   * with a {@link SenderKeyDirectory} for per-sender authentication.
   */
  readonly maxEpochJump?: number;
}

const WRAP_KEY_LABEL = "fricken/sframe/v2 keywrap";
const WRAP_KEY_BYTES = 16;

function defaultRandomNonce(): Uint8Array {
  const n = new Uint8Array(12);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(n);
  else for (let i = 0; i < n.length; i++) n[i] = Math.floor(Math.random() * 256);
  return n;
}

/**
 * PRODUCTION {@link KeyDistributor} riding the call control plane's signal relay.
 *
 * `announce(epoch)` wraps the epoch key under a key derived from the room secret
 * and sends it as an opaque `"keyEpoch"` signal. `onEpoch(listener)` polls the
 * signal channel, unwraps inbound `"keyEpoch"` signals (skipping our own
 * echoes and already-seen epochs), and surfaces the reconstructed
 * {@link KeyEpoch} — the caller wires this to `CallKeyEpochManager.adopt`.
 *
 * The wrap is the symmetric sender-key scheme: confidentiality + integrity of
 * the key blob against the relay/SFU. The signal relay name defaults to the
 * shared `WEBRTC_SIGNAL_TYPE` (passed by the caller) so it reuses the existing
 * fan-out exactly like SDP/ICE/sfuToken.
 */
export class SignalKeyDistributor implements KeyDistributor {
  readonly #client: SignalRelayClient;
  readonly #callId: string;
  readonly #senderDeviceId: string;
  readonly #roomSecret: Uint8Array;
  readonly #aead: AeadCryptoProvider;
  readonly #kdf: KeyDerivationProvider;
  readonly #randomNonce: () => Uint8Array;
  readonly #signalType: string;
  readonly #maxEpochJump: number;
  readonly #listeners = new Set<(epoch: KeyEpoch) => void>();
  #wrapKey: Promise<Uint8Array> | undefined;
  #processed = 0;
  #highestSeen = -1;

  constructor(options: SignalKeyDistributorOptions) {
    this.#client = options.client;
    this.#callId = options.callId;
    this.#senderDeviceId = options.senderDeviceId;
    this.#roomSecret = options.roomSecret;
    this.#aead = options.aead ?? new WebCryptoAeadProvider();
    this.#kdf = options.kdf ?? new WebCryptoKeyDerivation();
    this.#randomNonce = options.randomNonce ?? defaultRandomNonce;
    this.#signalType = options.signalType ?? "WebRTCSignal";
    this.#maxEpochJump = options.maxEpochJump ?? 1024;
  }

  #wrapKeyMaterial(): Promise<Uint8Array> {
    if (!this.#wrapKey) {
      this.#wrapKey = this.#kdf.derive({
        secret: this.#roomSecret,
        label: WRAP_KEY_LABEL,
        length: WRAP_KEY_BYTES,
      });
    }
    return this.#wrapKey;
  }

  async announce(epoch: KeyEpoch): Promise<void> {
    const wrapKey = await this.#wrapKeyMaterial();
    const nonce = this.#randomNonce();
    const aad = encodeWrapAad(this.#callId, epoch.epochId);
    const wrapped = await this.#aead.seal({
      key: wrapKey,
      nonce,
      plaintext: epoch.key,
      associatedData: aad,
    });
    const signal: KeyEpochSignal = {
      senderDeviceId: this.#senderDeviceId,
      kind: "keyEpoch",
      epochId: epoch.epochId,
      members: epoch.members,
      createdAt: epoch.createdAt,
      wrapNonce: toBase64(nonce),
      wrappedKey: toBase64(wrapped),
    };
    await this.#client.sendSignal(
      this.#signalType,
      this.#callId,
      signal as unknown as Record<string, unknown>,
    );
  }

  onEpoch(listener: (epoch: KeyEpoch) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Drain new `"keyEpoch"` signals off the relay channel, unwrap them, and
   * deliver each reconstructed epoch to listeners. Idempotent + monotonic:
   * skips our own echoes, malformed/foreign signals, and any epoch id not newer
   * than the highest already surfaced. The caller drives this from the same
   * place it drains the SDP/ICE channel (e.g. a signal subscription tick).
   */
  async poll(): Promise<void> {
    const entries = this.#client.signalChannel(this.#signalType, this.#callId).get();
    const wrapKey = await this.#wrapKeyMaterial();
    for (let i = this.#processed; i < entries.length; i++) {
      const raw = entries[i] as Partial<KeyEpochSignal>;
      if (!raw || raw.kind !== "keyEpoch") continue;
      // Skip the asymmetric variant — it rides the same signal kind but is
      // unwrappable here; routing by `wrap` keeps the two distributors disjoint.
      if ((raw as { wrap?: string }).wrap === "ecdh") continue;
      if (raw.senderDeviceId === this.#senderDeviceId) continue; // our own echo
      if (typeof raw.epochId !== "number" || raw.epochId <= this.#highestSeen) continue;
      // Bound the forward jump so an absurd epochId can't poison #highestSeen and
      // wedge later legitimate epochs (crypto-e2ee-5). Never advances #highestSeen
      // on rejection.
      if (raw.epochId - this.#highestSeen > this.#maxEpochJump) continue;
      const epoch = await this.#tryUnwrap(raw, wrapKey);
      if (!epoch) continue;
      this.#highestSeen = epoch.epochId;
      for (const l of this.#listeners) {
        try {
          l(epoch);
        } catch {
          // Isolate per-listener failures.
        }
      }
    }
    this.#processed = entries.length;
  }

  async #tryUnwrap(raw: Partial<KeyEpochSignal>, wrapKey: Uint8Array): Promise<KeyEpoch | undefined> {
    try {
      const nonce = fromBase64(raw.wrapNonce as string);
      const wrapped = fromBase64(raw.wrappedKey as string);
      const aad = encodeWrapAad(this.#callId, raw.epochId as number);
      const key = await this.#aead.open({ key: wrapKey, nonce, ciphertext: wrapped, associatedData: aad });
      return {
        epochId: raw.epochId as number,
        key,
        members: (raw.members as readonly string[]) ?? [],
        createdAt: (raw.createdAt as number) ?? Date.now(),
      };
    } catch {
      // Wrong room secret or tampered blob → fail closed, drop the announcement.
      return undefined;
    }
  }
}

/** AAD binding a wrapped key to its call + epoch so it can't be replayed cross-epoch. */
function encodeWrapAad(callId: string, epochId: EpochId): Uint8Array {
  return new TextEncoder().encode(`keyEpoch:${callId}:${epochId}`);
}

// ===========================================================================
// FR-158 — per-recipient ASYMMETRIC key wrapping (ECDH)
// ===========================================================================
//
// FR-156's SignalKeyDistributor wraps the epoch key under a SYMMETRIC per-room
// secret every member shares. Security gap: a removed member who learned that
// room secret can still unwrap FUTURE epoch keys — there is no per-recipient
// confidentiality and no membership-change forward secrecy without rotating the
// (shared) secret out of band.
//
// FR-158 closes that gap with per-recipient ASYMMETRIC wrapping. Each member has
// an ECDH key pair (default WebCrypto P-256, via an injectable provider). To
// announce an epoch, the sender wraps the epoch key INDIVIDUALLY to each current
// member's public key: it generates an ephemeral ECDH key pair, does
// ECDH(ephemeralPriv, recipientPub) → HKDF → AES-GCM key-encryption-key (KEK),
// and AES-GCM-seals the epoch key under that KEK with AAD bound to
// `callId:epochId:recipientId`. The signal carries the ephemeral public key plus
// one wrapped blob per recipient. A removed member is simply NOT in the recipient
// set, so NO blob is wrapped to its public key → it cannot derive any KEK →
// it cannot obtain the new epoch's key. True forward-secrecy-on-membership-change
// without a shared secret.
//
// This is an OPT-IN alternative KeyDistributor; the symmetric SignalKeyDistributor
// is unchanged. It is NOT MLS: there is no group ratchet / log-sized re-keying /
// tree — re-keying is O(members) per epoch and the member key directory's
// authenticity is an app-side input. MLS (RFC 9420) remains the further evolution
// and can replace this distributor behind the same seam. See docs/e2ee-calls.md.

/**
 * The asymmetric (ECDH) half of the crypto seam FR-158's distributor depends on.
 * Defined as an injectable provider — like {@link AeadCryptoProvider} /
 * {@link KeyDerivationProvider} — so tests inject a deterministic fake with no
 * WebCrypto and no real curve math, and so the runtime's available curve is a
 * provider choice rather than a hardcoded constant.
 *
 * Keys are opaque `Uint8Array`s at this boundary (raw/SPKI public, PKCS8/raw
 * private — the provider decides the encoding; the distributor never inspects
 * them). `deriveSharedSecret(priv, pub)` is the ECDH primitive: ECDH(privA, pubB)
 * == ECDH(privB, pubA), the shared-secret symmetry the wrap/unwrap relies on.
 */
export interface AsymmetricCryptoProvider {
  /** Generate a fresh ECDH key pair (e.g. the sender's per-announce ephemeral). */
  generateKeyPair(): Promise<AsymmetricKeyPair>;
  /**
   * ECDH: derive the raw shared secret from one party's private key and the
   * other party's public key. MUST be symmetric across the two parties.
   */
  deriveSharedSecret(args: {
    readonly privateKey: Uint8Array;
    readonly publicKey: Uint8Array;
  }): Promise<Uint8Array>;
}

/** An ECDH key pair as opaque bytes (encoding is the provider's concern). */
export interface AsymmetricKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/**
 * Default {@link AsymmetricCryptoProvider} backed by `globalThis.crypto.subtle`
 * ECDH over **P-256** (portable across Node 16+/modern browsers). Constructed
 * lazily so importing this module never requires WebCrypto. Public keys are
 * exported as **raw** (uncompressed point) bytes and private keys as **PKCS8**,
 * so they round-trip through the opaque-bytes boundary. Tests inject a fake.
 */
export class WebCryptoAsymmetric implements AsymmetricCryptoProvider {
  #subtle(): EcdhSubtleLike {
    const subtle = (globalThis as { crypto?: { subtle?: EcdhSubtleLike } }).crypto?.subtle;
    if (!subtle) {
      throw new Error(
        "WebCryptoAsymmetric requires globalThis.crypto.subtle; inject an AsymmetricCryptoProvider in non-browser environments",
      );
    }
    return subtle;
  }

  async generateKeyPair(): Promise<AsymmetricKeyPair> {
    const subtle = this.#subtle();
    const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const [publicKey, privateKey] = await Promise.all([
      subtle.exportKey("raw", pair.publicKey),
      subtle.exportKey("pkcs8", pair.privateKey),
    ]);
    return { publicKey: new Uint8Array(publicKey), privateKey: new Uint8Array(privateKey) };
  }

  async deriveSharedSecret(args: {
    readonly privateKey: Uint8Array;
    readonly publicKey: Uint8Array;
  }): Promise<Uint8Array> {
    const subtle = this.#subtle();
    const [priv, pub] = await Promise.all([
      subtle.importKey("pkcs8", args.privateKey, { name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
      ]),
      subtle.importKey("raw", args.publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []),
    ]);
    // P-256 shared secret is the 32-byte X coordinate (256 bits).
    const bits = await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
    return new Uint8Array(bits);
  }
}

/** The slice of `SubtleCrypto` {@link WebCryptoAsymmetric} uses. */
interface EcdhSubtleLike {
  generateKey(
    algorithm: { name: "ECDH"; namedCurve: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<{ publicKey: CryptoKeyLike; privateKey: CryptoKeyLike }>;
  exportKey(format: "raw" | "pkcs8", key: CryptoKeyLike): Promise<ArrayBuffer>;
  importKey(
    format: "raw" | "pkcs8",
    keyData: Uint8Array,
    algorithm: { name: "ECDH"; namedCurve: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyLike>;
  deriveBits(
    algorithm: { name: "ECDH"; public: CryptoKeyLike },
    key: CryptoKeyLike,
    length: number,
  ): Promise<ArrayBuffer>;
}

/**
 * Resolves the published ECDH **public key** for a call member id (the
 * `memberKey(member)` form, `"userId:deviceId"`). Injected into the asymmetric
 * distributor as a seam: HOW public keys are published and AUTHENTICATED app-side
 * (a key transparency log, the directory service, a safety-number check, …) is
 * OUT OF SCOPE for FR-158 — the directory is an input. Returning `undefined`
 * means "no key for this member" → that member simply gets no wrapped blob.
 */
export interface MemberKeyDirectory {
  publicKeyFor(memberId: string): Promise<Uint8Array | undefined> | (Uint8Array | undefined);
}

/**
 * In-memory {@link MemberKeyDirectory} for tests and simple deployments: a plain
 * `memberId → publicKey` map. The real directory authenticates keys app-side
 * (out of FR-158 scope).
 */
export class MapMemberKeyDirectory implements MemberKeyDirectory {
  readonly #keys = new Map<string, Uint8Array>();
  constructor(entries?: Iterable<readonly [string, Uint8Array]>) {
    if (entries) for (const [id, key] of entries) this.#keys.set(id, key);
  }
  set(memberId: string, publicKey: Uint8Array): void {
    this.#keys.set(memberId, publicKey);
  }
  publicKeyFor(memberId: string): Uint8Array | undefined {
    return this.#keys.get(memberId);
  }
}

// -- sender authentication seam (crypto-e2ee-4) ------------------------------

/**
 * Signs/verifies an epoch announcement with the SENDER's long-term identity key
 * so a receiver can prove WHO produced it before adopting. Injectable — like
 * {@link AsymmetricCryptoProvider} — so tests use a deterministic fake and the
 * runtime signature scheme (Ed25519 / ECDSA-P256) is a provider choice.
 *
 * Without this, the ECDH wrap authenticates only that *someone who knows a
 * recipient's PUBLIC key* (i.e. anyone, since the directory is public) produced
 * the blob — NOT that a legitimate member did. The relay, or any directory
 * reader, could forge an epoch the victim adopts (crypto-e2ee-4). The signature
 * binds the whole announcement to the sender's identity key.
 */
export interface SignatureProvider {
  /** Sign `message` with the sender's long-term private signing key. */
  sign(args: {
    readonly privateKey: Uint8Array;
    readonly message: Uint8Array;
  }): Promise<Uint8Array>;
  /**
   * Verify `signature` over `message` against `publicKey`. MUST return false
   * (never throw) on any mismatch / malformed input — the caller fails closed.
   */
  verify(args: {
    readonly publicKey: Uint8Array;
    readonly message: Uint8Array;
    readonly signature: Uint8Array;
  }): Promise<boolean>;
}

/**
 * Default {@link SignatureProvider} backed by `globalThis.crypto.subtle` ECDSA
 * over P-256 / SHA-256. Public keys are **raw** (uncompressed point), private
 * keys **PKCS8**, signatures the raw `r||s` IEEE-P1363 form — matching the
 * encodings {@link WebCryptoAsymmetric} uses so a deployment can publish one
 * P-256 key pair per member for both ECDH wrapping and announcement signing if
 * it chooses (separate key pairs are still recommended). Lazily touches subtle.
 */
export class WebCryptoSignature implements SignatureProvider {
  #subtle(): EcdsaSubtleLike {
    const subtle = (globalThis as { crypto?: { subtle?: EcdsaSubtleLike } }).crypto?.subtle;
    if (!subtle) {
      throw new Error(
        "WebCryptoSignature requires globalThis.crypto.subtle; inject a SignatureProvider in non-browser environments",
      );
    }
    return subtle;
  }

  async sign(args: { privateKey: Uint8Array; message: Uint8Array }): Promise<Uint8Array> {
    const subtle = this.#subtle();
    const key = await subtle.importKey(
      "pkcs8",
      args.privateKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, args.message);
    return new Uint8Array(sig);
  }

  async verify(args: {
    publicKey: Uint8Array;
    message: Uint8Array;
    signature: Uint8Array;
  }): Promise<boolean> {
    try {
      const subtle = this.#subtle();
      const key = await subtle.importKey(
        "raw",
        args.publicKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      return await subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        args.signature,
        args.message,
      );
    } catch {
      return false;
    }
  }
}

/** The slice of `SubtleCrypto` {@link WebCryptoSignature} uses. */
interface EcdsaSubtleLike {
  importKey(
    format: "raw" | "pkcs8",
    keyData: Uint8Array,
    algorithm: { name: "ECDSA"; namedCurve: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyLike>;
  sign(
    algorithm: { name: "ECDSA"; hash: string },
    key: CryptoKeyLike,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: { name: "ECDSA"; hash: string },
    key: CryptoKeyLike,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

/**
 * Resolves the published long-term **signing** public key for a member id, so
 * the receiver can verify who signed an announcement. Authentication of these
 * keys (key transparency, safety numbers, …) is app-side, exactly like
 * {@link MemberKeyDirectory}. `undefined` → no key on file → the announcement
 * cannot be authenticated → it is dropped (fail closed).
 */
export interface SenderKeyDirectory {
  signingKeyFor(memberId: string): Promise<Uint8Array | undefined> | (Uint8Array | undefined);
}

/** In-memory {@link SenderKeyDirectory}: a plain `memberId → signingPublicKey` map. */
export class MapSenderKeyDirectory implements SenderKeyDirectory {
  readonly #keys = new Map<string, Uint8Array>();
  constructor(entries?: Iterable<readonly [string, Uint8Array]>) {
    if (entries) for (const [id, key] of entries) this.#keys.set(id, key);
  }
  set(memberId: string, signingPublicKey: Uint8Array): void {
    this.#keys.set(memberId, signingPublicKey);
  }
  signingKeyFor(memberId: string): Uint8Array | undefined {
    return this.#keys.get(memberId);
  }
}

/** One recipient's wrapped epoch key inside an asymmetric `"keyEpoch"` signal. */
export interface AsymmetricWrappedBlob {
  /** `memberKey(member)` the blob is wrapped to. */
  readonly recipientId: string;
  /** Base64 AES-GCM nonce used to seal the epoch key under the per-recipient KEK. */
  readonly wrapNonce: string;
  /** Base64 AES-GCM ciphertext of the raw epoch key. */
  readonly wrappedKey: string;
}

/**
 * The opaque `"keyEpoch"` signal payload for asymmetric wrapping. Distinguished
 * from {@link KeyEpochSignal} by `wrap: "ecdh"` so a receiver routes it to the
 * right distributor and never confuses it with the symmetric blob. Carries the
 * sender's per-announce **ephemeral public key** plus one {@link AsymmetricWrappedBlob}
 * per current recipient.
 */
export interface AsymmetricKeyEpochSignal {
  readonly senderDeviceId: string;
  readonly kind: "keyEpoch";
  readonly wrap: "ecdh";
  readonly epochId: EpochId;
  readonly members: readonly string[];
  readonly createdAt: number;
  /** Base64 sender ephemeral ECDH public key (the static-ephemeral ECDH peer). */
  readonly ephemeralPublicKey: string;
  /** Per-recipient wrapped epoch-key blobs. */
  readonly blobs: readonly AsymmetricWrappedBlob[];
  /**
   * The announcing member's id (`memberKey` form). Bound into the AAD and the
   * signed digest, and the key under which the receiver verifies {@link signature}
   * against the {@link SenderKeyDirectory}. Optional only for back-compat with
   * unsigned legacy announcements; a distributor configured with a sender
   * directory drops any announcement lacking a valid signature (crypto-e2ee-4).
   */
  readonly signerId?: string;
  /** Base64 signature over the announcement digest, made with the sender's identity key. */
  readonly signature?: string;
}

const ASYM_KEK_LABEL = "fricken/sframe/v2 ecdh-kek";
const ASYM_KEK_BYTES = 16;

export interface AsymmetricKeyDistributorOptions {
  readonly client: SignalRelayClient;
  readonly callId: string;
  /** This device's id (stamped on announcements; used to drop our own echoes). */
  readonly senderDeviceId: string;
  /**
   * This member's id in `memberKey(member)` form (`"userId:deviceId"`). Used to
   * find OUR wrapped blob on receive — the blob whose `recipientId` is ours.
   */
  readonly selfMemberId: string;
  /** This member's long-term ECDH private key (matches the directory's public key). */
  readonly privateKey: Uint8Array;
  /** Resolves each recipient's published ECDH public key. */
  readonly directory: MemberKeyDirectory;
  /** Asymmetric/ECDH provider; defaults to {@link WebCryptoAsymmetric} (P-256). */
  readonly asymmetric?: AsymmetricCryptoProvider;
  /** AEAD provider used to wrap/unwrap under the derived KEK. Default WebCrypto. */
  readonly aead?: AeadCryptoProvider;
  /** KDF used to derive the KEK from the ECDH shared secret. Default WebCrypto HKDF. */
  readonly kdf?: KeyDerivationProvider;
  /** Nonce source for each per-recipient wrap (12 bytes). Tests inject a deterministic one. */
  readonly randomNonce?: () => Uint8Array;
  /** Signal type name; defaults to the shared WebRTC signal relay type. */
  readonly signalType?: string;
  // -- sender authentication (crypto-e2ee-4) --
  /**
   * Signature provider used to SIGN our announcements and VERIFY peers'.
   * Defaults to {@link WebCryptoSignature} (ECDSA P-256). Authentication is
   * ACTIVE iff BOTH a `signingPrivateKey` (to sign) and a `senderDirectory` (to
   * verify) are supplied; otherwise the distributor runs in legacy unauthenticated
   * mode (back-compat) and only the AAD binding protects against tampering.
   */
  readonly signature?: SignatureProvider;
  /** This member's long-term signing private key (used to sign announcements). */
  readonly signingPrivateKey?: Uint8Array;
  /**
   * Resolves each member's signing public key. When present, the distributor
   * REQUIRES every adopted announcement to carry a valid signature from the
   * member it claims to be (`signerId`), and fails closed otherwise.
   */
  readonly senderDirectory?: SenderKeyDirectory;
  /**
   * Largest forward jump in epochId the receiver will surface in a single
   * `poll()` relative to the highest already seen. Bounds monotonic-counter
   * poisoning (crypto-e2ee-5) even from an authenticated-but-malicious member.
   * Default 1024.
   */
  readonly maxEpochJump?: number;
}

/**
 * PRODUCTION {@link KeyDistributor} that wraps the epoch key **per recipient**
 * using ECDH (asymmetric), riding the same `"keyEpoch"` signal relay as
 * {@link SignalKeyDistributor} but with NO shared room secret.
 *
 * `announce(epoch)`: generate an ephemeral ECDH key pair; for EACH member in
 * `epoch.members` resolve its public key from the {@link MemberKeyDirectory},
 * derive `KEK = HKDF(ECDH(ephemeralPriv, recipientPub))`, and AES-GCM-seal the
 * epoch key under that KEK with AAD bound to `callId:epochId:recipientId`. Emit
 * one signal carrying the ephemeral public key + all per-recipient blobs.
 *
 * `poll()`/receive: find OUR blob by `recipientId === selfMemberId`; derive the
 * same KEK via `ECDH(ourPriv, ephemeralPub)`; AES-GCM-open. Fail-closed: no blob
 * for us / wrong key / tamper / stale or own-echo epoch → drop, never throw out.
 *
 * Membership-removal forward secrecy: an epoch announced to {A,B} (not C)
 * produces blobs ONLY for A and B. C is not in the recipient set, so there is no
 * blob C can find and no KEK C can derive → C cannot obtain that epoch's key.
 */
export class AsymmetricKeyDistributor implements KeyDistributor {
  readonly #client: SignalRelayClient;
  readonly #callId: string;
  readonly #senderDeviceId: string;
  readonly #selfMemberId: string;
  readonly #privateKey: Uint8Array;
  readonly #directory: MemberKeyDirectory;
  readonly #asym: AsymmetricCryptoProvider;
  readonly #aead: AeadCryptoProvider;
  readonly #kdf: KeyDerivationProvider;
  readonly #randomNonce: () => Uint8Array;
  readonly #signalType: string;
  readonly #sig: SignatureProvider;
  readonly #signingPrivateKey: Uint8Array | undefined;
  readonly #senderDirectory: SenderKeyDirectory | undefined;
  readonly #maxEpochJump: number;
  readonly #listeners = new Set<(epoch: KeyEpoch) => void>();
  #processed = 0;
  #highestSeen = -1;

  constructor(options: AsymmetricKeyDistributorOptions) {
    this.#client = options.client;
    this.#callId = options.callId;
    this.#senderDeviceId = options.senderDeviceId;
    this.#selfMemberId = options.selfMemberId;
    this.#privateKey = options.privateKey;
    this.#directory = options.directory;
    this.#asym = options.asymmetric ?? new WebCryptoAsymmetric();
    this.#aead = options.aead ?? new WebCryptoAeadProvider();
    this.#kdf = options.kdf ?? new WebCryptoKeyDerivation();
    this.#randomNonce = options.randomNonce ?? defaultRandomNonce;
    this.#signalType = options.signalType ?? "WebRTCSignal";
    this.#sig = options.signature ?? new WebCryptoSignature();
    this.#signingPrivateKey = options.signingPrivateKey;
    this.#senderDirectory = options.senderDirectory;
    this.#maxEpochJump = options.maxEpochJump ?? 1024;
  }

  /** Derive the per-recipient KEK from an ECDH shared secret. */
  #deriveKek(sharedSecret: Uint8Array): Promise<Uint8Array> {
    return this.#kdf.derive({ secret: sharedSecret, label: ASYM_KEK_LABEL, length: ASYM_KEK_BYTES });
  }

  async announce(epoch: KeyEpoch): Promise<void> {
    const ephemeral = await this.#asym.generateKeyPair();
    const ephemeralB64 = toBase64(ephemeral.publicKey);
    const blobs: AsymmetricWrappedBlob[] = [];
    for (const recipientId of epoch.members) {
      const recipientPub = await this.#directory.publicKeyFor(recipientId);
      if (!recipientPub) continue; // no published key → no blob (fail-closed for that member)
      const shared = await this.#asym.deriveSharedSecret({
        privateKey: ephemeral.privateKey,
        publicKey: recipientPub,
      });
      const kek = await this.#deriveKek(shared);
      const nonce = this.#randomNonce();
      // Bind the sender device + ephemeral key into the AAD so a relay cannot
      // splice a victim's blob under a DIFFERENT sender/ephemeral key (crypto-e2ee-4).
      const aad = encodeAsymWrapAad(
        this.#callId,
        epoch.epochId,
        recipientId,
        this.#senderDeviceId,
        ephemeralB64,
      );
      const wrapped = await this.#aead.seal({
        key: kek,
        nonce,
        plaintext: epoch.key,
        associatedData: aad,
      });
      blobs.push({
        recipientId,
        wrapNonce: toBase64(nonce),
        wrappedKey: toBase64(wrapped),
      });
    }
    const base: AsymmetricKeyEpochSignal = {
      senderDeviceId: this.#senderDeviceId,
      kind: "keyEpoch",
      wrap: "ecdh",
      epochId: epoch.epochId,
      members: epoch.members,
      createdAt: epoch.createdAt,
      ephemeralPublicKey: ephemeralB64,
      blobs,
      signerId: this.#selfMemberId,
    };
    // Sign the whole announcement with our identity key so receivers can prove
    // WHO produced it before adopting (crypto-e2ee-4). Skipped only in legacy
    // unauthenticated mode (no signing key configured).
    const signal: AsymmetricKeyEpochSignal = this.#signingPrivateKey
      ? {
          ...base,
          signature: toBase64(
            await this.#sig.sign({
              privateKey: this.#signingPrivateKey,
              message: encodeAnnouncementDigest(this.#callId, base),
            }),
          ),
        }
      : base;
    await this.#client.sendSignal(
      this.#signalType,
      this.#callId,
      signal as unknown as Record<string, unknown>,
    );
  }

  onEpoch(listener: (epoch: KeyEpoch) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Drain new asymmetric `"keyEpoch"` signals off the relay, AUTHENTICATE the
   * sender (when a sender directory is configured), unwrap OUR blob, and deliver
   * each reconstructed epoch to listeners. Idempotent + monotonic: skips our own
   * echoes, foreign/symmetric/malformed signals, stale epoch ids, implausible
   * forward jumps (crypto-e2ee-5), unsigned/forged announcements (crypto-e2ee-4),
   * and any announcement with no blob addressed to us (fail-closed). The caller
   * drives this from the same place it drains SDP/ICE.
   */
  async poll(): Promise<void> {
    const entries = this.#client.signalChannel(this.#signalType, this.#callId).get();
    for (let i = this.#processed; i < entries.length; i++) {
      const raw = entries[i] as Partial<AsymmetricKeyEpochSignal>;
      if (!raw || raw.kind !== "keyEpoch" || raw.wrap !== "ecdh") continue;
      if (raw.senderDeviceId === this.#senderDeviceId) continue; // our own echo
      if (typeof raw.epochId !== "number" || raw.epochId <= this.#highestSeen) continue;
      // Bound the forward jump so an absurd epochId can't poison #highestSeen and
      // wedge later legitimate epochs (crypto-e2ee-5). Applied BEFORE we advance
      // #highestSeen, and the guard never advances it on rejection.
      if (raw.epochId - this.#highestSeen > this.#maxEpochJump) continue;
      // Sender authentication gate (crypto-e2ee-4): only authenticated epochs may
      // advance #highestSeen or be surfaced. A failed/forged/unsigned announcement
      // is dropped WITHOUT touching #highestSeen.
      if (!(await this.#verifySender(raw))) continue;
      const epoch = await this.#tryUnwrap(raw);
      if (!epoch) continue;
      this.#highestSeen = epoch.epochId;
      for (const l of this.#listeners) {
        try {
          l(epoch);
        } catch {
          // Isolate per-listener failures.
        }
      }
    }
    this.#processed = entries.length;
  }

  /**
   * Authenticate the announcement's claimed sender. When a {@link SenderKeyDirectory}
   * is configured, REQUIRE a signature that verifies under the signing key the
   * directory holds for `signerId` (and that `signerId` is a declared member).
   * With no sender directory, runs in legacy unauthenticated mode (returns true).
   */
  async #verifySender(raw: Partial<AsymmetricKeyEpochSignal>): Promise<boolean> {
    if (!this.#senderDirectory) return true; // legacy unauthenticated mode
    const signerId = raw.signerId;
    const signatureB64 = raw.signature;
    if (typeof signerId !== "string" || typeof signatureB64 !== "string") return false;
    // The signer must be one of the members the announcement itself declares —
    // a non-member cannot legitimately rotate the epoch.
    const members = Array.isArray(raw.members) ? raw.members : [];
    if (!members.includes(signerId)) return false;
    const signingPub = await this.#senderDirectory.signingKeyFor(signerId);
    if (!signingPub) return false; // no key on file → cannot authenticate → drop
    try {
      // Reconstruct the exact digest the sender signed (everything but the signature).
      const { signature: _sig, ...signed } = raw as AsymmetricKeyEpochSignal;
      return await this.#sig.verify({
        publicKey: signingPub,
        message: encodeAnnouncementDigest(this.#callId, signed),
        signature: fromBase64(signatureB64),
      });
    } catch {
      return false;
    }
  }

  async #tryUnwrap(raw: Partial<AsymmetricKeyEpochSignal>): Promise<KeyEpoch | undefined> {
    try {
      const blobs = raw.blobs;
      if (!Array.isArray(blobs)) return undefined;
      const mine = blobs.find((b) => b?.recipientId === this.#selfMemberId);
      if (!mine) return undefined; // no blob for us → fail closed (e.g. removed member)
      const ephemeralB64 = raw.ephemeralPublicKey as string;
      const ephemeralPub = fromBase64(ephemeralB64);
      const shared = await this.#asym.deriveSharedSecret({
        privateKey: this.#privateKey,
        publicKey: ephemeralPub,
      });
      const kek = await this.#deriveKek(shared);
      const nonce = fromBase64(mine.wrapNonce);
      const wrapped = fromBase64(mine.wrappedKey);
      // Must match the AAD the announcer bound: call+epoch+recipient+sender+ephemeral.
      const aad = encodeAsymWrapAad(
        this.#callId,
        raw.epochId as number,
        this.#selfMemberId,
        raw.senderDeviceId as string,
        ephemeralB64,
      );
      const key = await this.#aead.open({ key: kek, nonce, ciphertext: wrapped, associatedData: aad });
      return {
        epochId: raw.epochId as number,
        key,
        members: (raw.members as readonly string[]) ?? [],
        createdAt: (raw.createdAt as number) ?? Date.now(),
      };
    } catch {
      // Wrong key / tampered blob / malformed → fail closed, drop the announcement.
      return undefined;
    }
  }
}

/**
 * AAD binding a wrapped blob to its call + epoch + RECIPIENT + SENDER + ephemeral
 * key, so it can't be replayed cross-recipient/epoch NOR spliced under a different
 * sender/ephemeral key by a relay (crypto-e2ee-4).
 */
function encodeAsymWrapAad(
  callId: string,
  epochId: EpochId,
  recipientId: string,
  senderDeviceId: string,
  ephemeralPublicKeyB64: string,
): Uint8Array {
  return new TextEncoder().encode(
    `keyEpoch:ecdh:${callId}:${epochId}:${recipientId}:${senderDeviceId}:${ephemeralPublicKeyB64}`,
  );
}

/**
 * Canonical, signature-free digest of an asymmetric announcement — the exact
 * bytes the sender signs and the receiver verifies (crypto-e2ee-4). Includes
 * every security-relevant field (call/epoch/members/sender/ephemeral key + every
 * recipient blob) in a fixed order so signer and verifier agree byte-for-byte.
 */
function encodeAnnouncementDigest(
  callId: string,
  signal: Omit<AsymmetricKeyEpochSignal, "signature">,
): Uint8Array {
  const blobs = [...signal.blobs]
    .map((b) => `${b.recipientId}|${b.wrapNonce}|${b.wrappedKey}`)
    .sort()
    .join(",");
  const canonical = [
    "keyEpoch:ecdh:sig:v1",
    callId,
    signal.epochId,
    signal.senderDeviceId,
    signal.signerId ?? "",
    [...signal.members].sort().join(","),
    signal.ephemeralPublicKey,
    blobs,
  ].join("\n");
  return new TextEncoder().encode(canonical);
}

// ===========================================================================
// FR-156 — SFU media-path insertion seam
// ===========================================================================
//
// The real browser hook is an Encoded Transform (RTCRtpScriptTransform /
// insertable streams) attached per-sender/-receiver. That is browser-only, so —
// exactly as FR-155 abstracted the mediasoup Device behind SfuDeviceLike — we
// abstract the insertion point behind FrameTransformInserter. A browser impl
// wires the Encoded Transform; tests inject a fake that simply pumps frames
// through, proving encrypt-before-produce / decrypt-after-consume with no DOM.

/**
 * Direction of an encoded-frame transform: outbound frames are encrypted before
 * they reach the producer; inbound frames are decrypted after the consumer.
 */
export type FrameTransformDirection = "encrypt" | "decrypt";

/**
 * Attaches an {@link SFrameTransform} to a media sender or receiver. The browser
 * implementation builds an Encoded Transform around the supplied transform; the
 * test fake records the attachment and lets a test pump frames through. Returns
 * a detach function.
 */
export interface FrameTransformInserter {
  insert(args: {
    readonly direction: FrameTransformDirection;
    readonly transform: SFrameTransform;
    /** Opaque sink handle (an RTCRtpSender/Receiver in the browser). */
    readonly endpoint: unknown;
  }): () => void;
}

/**
 * In-memory {@link FrameTransformInserter} for tests: records each attachment and
 * exposes `pump(direction, endpoint, frame)` to run a frame through the attached
 * transform — the deterministic stand-in for the browser Encoded Transform, so
 * the SFU-insertion path is unit-testable with no DOM.
 */
export class MemoryFrameTransformInserter implements FrameTransformInserter {
  readonly #attached = new Map<
    unknown,
    { direction: FrameTransformDirection; transform: SFrameTransform }
  >();

  insert(args: {
    direction: FrameTransformDirection;
    transform: SFrameTransform;
    endpoint: unknown;
  }): () => void {
    this.#attached.set(args.endpoint, { direction: args.direction, transform: args.transform });
    return () => this.#attached.delete(args.endpoint);
  }

  /** Run `frame` through the transform attached to `endpoint` in `direction`. */
  async pump(
    direction: FrameTransformDirection,
    endpoint: unknown,
    frame: Uint8Array,
  ): Promise<Uint8Array> {
    const entry = this.#attached.get(endpoint);
    if (!entry) throw new Error("MemoryFrameTransformInserter.pump: no transform attached");
    if (entry.direction !== direction) {
      throw new Error(
        `MemoryFrameTransformInserter.pump: endpoint attached for ${entry.direction}, not ${direction}`,
      );
    }
    return direction === "encrypt"
      ? entry.transform.encrypt(frame)
      : entry.transform.decrypt(frame);
  }

  get attachmentCount(): number {
    return this.#attached.size;
  }

  /** Endpoints currently attached for `direction` (test introspection). */
  endpointsFor(direction: FrameTransformDirection): unknown[] {
    const out: unknown[] = [];
    for (const [endpoint, entry] of this.#attached) {
      if (entry.direction === direction) out.push(endpoint);
    }
    return out;
  }
}
