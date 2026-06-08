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
    algorithm: { name: string },
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
}
type CryptoKeyLike = unknown;

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
  readonly #windowMs: number;
  readonly #keyFactory: EpochKeyFactory;
  readonly #now: () => number;

  constructor(options: CallKeyEpochManagerOptions = {}) {
    this.#windowMs = options.previousEpochWindowMs ?? 5_000;
    this.#keyFactory = options.keyFactory ?? ((_id, _members) => defaultKeyFactory());
    this.#now = options.now ?? Date.now;
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
    this.#previous = this.#current;
    this.#current = epoch;
    return epoch;
  }

  /**
   * Adopt an epoch announced by a peer (received via the {@link KeyDistributor}
   * over the control plane) rather than minting one locally. Used by members who
   * did NOT trigger the rotation: the rotation initiator distributes the new
   * epoch and everyone else adopts it so all participants converge on the same
   * `(epochId, key)`. Ignores an epoch we already have or an older one.
   */
  adopt(epoch: KeyEpoch): void {
    if (this.#current && epoch.epochId <= this.#current.epochId) return;
    this.#previous = this.#current;
    this.#current = epoch;
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
    if (this.#now() - this.#previous.createdAt >= this.#windowMs) {
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
