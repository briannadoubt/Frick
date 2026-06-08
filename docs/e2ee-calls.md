# End-to-end encrypted calls (E2EE)

> Status: design + key-epoch seam (FR-85) + **production SFrame cipher suite,
> replay protection, key-epoch distribution wire path, and SFU-path insertion
> (FR-156)** + **per-recipient asymmetric (ECDH) key wrapping (FR-158)** — all
> part of the FR-15 calls epic.
> FR-85 delivered the **design** plus a clean, testable **client-side
> key-epoch / SFrame-transform seam** ([`packages/core/src/e2ee.ts`](../packages/core/src/e2ee.ts)).
> **FR-156 makes it real** (see [What FR-156 delivered](#what-fr-156-delivered)):
> a production AEAD SFrame cipher suite with a real key schedule + per-frame
> nonce, sliding-window replay protection, a control-plane-backed key-epoch
> distributor over the additive `"keyEpoch"` signal kind (symmetric sender-key
> wrapping), and an injectable insertion seam wired into the FR-155 SFU driver
> behind a per-room opt-in toggle. **FR-158** adds an opt-in alternative
> distributor that wraps the epoch key **per recipient** with ECDH (no shared
> room secret), closing the removed-member forward-secrecy gap (see
> [What FR-158 delivered](#what-fr-158-delivered)). The only thing still deferred
> is **MLS** (RFC 9420) group key agreement (see [Follow-ups](#follow-ups)).
> E2EE remains opt-in per room: with it off, call behavior is byte-for-byte as
> before — no transform inserted, no epoch traffic.

## Why calls need a second encryption layer

Frick group calls run over an SFU (FR-83, mediasoup — see
[`sfu-media-plane.ts`](../apps/server/src/calls/sfu-media-plane.ts) and the web
driver [`packages/core/src/sfu.ts`](../packages/core/src/sfu.ts)). An SFU
*forwards* each participant's media to the others. SRTP encrypts media on the
wire, but the SFU terminates that transport encryption: it decrypts incoming
RTP, inspects/repackages it, and re-encrypts it outbound. **So the media server
— and anyone who controls it — can see the media.** That is fine for a
trusted-server product; it is not fine when the threat model includes the server
operator.

End-to-end encryption adds a **second, inner layer**: each media frame is
encrypted with a key the SFU never holds, *before* it reaches the SFU, and
decrypted only by the other call participants *after* the SFU hands it back. The
SFU forwards opaque ciphertext it cannot read. This frame-level scheme is
**SFrame** (Secure Frames). The shared frame key is managed in **key epochs**
that rotate on membership change.

```
  sender  ── encode ──▶ [SFrame encrypt] ──▶ SRTP ──▶ SFU ──▶ SRTP ──▶ [SFrame decrypt] ──▶ decode  receiver
                              ▲                         (opaque)                  ▲
                         epoch key                  forwards bytes          epoch key
                       (SFU never sees)             it can't read         (SFU never sees)
```

## Threat model

**E2EE for calls protects against an honest-but-curious media path:**

- **The SFU / media server.** It forwards SFrame-encrypted payloads it cannot
  decrypt. A compromised or subpoenaed SFU sees ciphertext, not media.
- **The control-plane / signaling server.** Key epochs are distributed over the
  call control plane (see below) wrapped per recipient; the relay carries opaque
  blobs, never raw key material.
- **The network / passive on-path attacker.** Already covered by SRTP/DTLS for
  confidentiality on the wire; SFrame additionally denies the *terminating*
  middlebox (the SFU) any plaintext.

**It explicitly does NOT protect against:**

- **Endpoint compromise.** If a participant's device is compromised, that
  participant's keys and decrypted media are exposed. E2EE is about the path,
  not the endpoints.
- **Metadata.** Who is in a call, when, for how long, packet sizes/timing,
  speaking activity, network-quality buckets (FR-82) — all still visible to the
  server. E2EE encrypts media *content*, not call metadata.
- **Traffic analysis.** Frame sizes and cadence leak (e.g. voice activity).
  Mitigations (padding, constant-bitrate) are out of scope and not planned.
- **A malicious participant.** Anyone admitted to the call's current epoch can
  decrypt that epoch's media — E2EE assumes the participant set is the trust
  boundary. Authenticating *who* may join is the call control plane's job
  (FR-79 authz), not SFrame's.
- **Active group-membership attacks by the server** in the simple (sender-key)
  key-distribution mode — see the MLS trade-off below.

## SFrame vs MLS: the decision

The ticket names both SFrame and MLS. They solve **different** problems and are
complementary, not alternatives:

| | SFrame | MLS |
|---|---|---|
| What it is | A frame-level **encryption + framing** format (RFC 9605). | A group **key-agreement** protocol (RFC 9420). |
| Job | Encrypt each media frame with a supplied key; carry the metadata (key id / epoch) a receiver needs. | Let a dynamic group continuously agree on a shared secret with forward secrecy + post-compromise security. |
| Analogy | The cipher + on-the-wire frame. | How everyone learns the key the cipher uses. |

SFrame needs *a key*; it does not say where the key comes from. The real
decision is **how the per-epoch frame key is distributed**, and that admits a
spectrum:

- **Sender-key / hash-ratchet (simple, recommended starting point).** When
  membership changes, one participant (deterministically chosen — e.g. the call
  creator, or the lowest participant id, mirroring the P2P "polite peer"
  tie-break in [`p2p.ts`](../packages/core/src/p2p.ts)) mints a fresh epoch key
  and distributes it to each current member, wrapped to that member's device
  key, over the call control plane. Cheap, easy to implement, no third-party
  library, well-understood. Its weakness: it trusts the distributor to send the
  same key to everyone and gives weaker *post-compromise* guarantees than a full
  ratchet tree.
- **MLS (target for stronger security).** MLS gives efficient (log-sized)
  re-keying on membership change, forward secrecy, and post-compromise security
  via its ratchet tree, and authenticates group membership cryptographically so
  a malicious server can't silently inject a ghost member. The cost is
  significant: a mature MLS library, credential/identity plumbing, and
  considerably more protocol surface.

**Recommendation.** Use **SFrame for the media framing/encryption**, keyed by
**per-epoch secrets**, and start key distribution with the **simple sender-key /
ratchet scheme over the existing control plane**, with the
[`KeyDistributor`](../packages/core/src/e2ee.ts) seam abstract enough to swap in
**MLS** later without touching the SFrame transform or the media path. This
ships per-room E2EE sooner, keeps the dependency surface small, and leaves a
clean upgrade path to MLS-grade group security when the threat model demands it.
The seam in this ticket is built around exactly that split:
`CallKeyEpochManager` + `KeyDistributor` (key agreement/distribution) are
independent of `SFrameTransform` (framing/encryption).

## Key-epoch lifecycle

An **epoch** is an immutable `(epochId, key)` bound to a **membership snapshot**.
`epochId` is a monotonic per-call counter; the `key` is the symmetric frame-key
material every current member shares for that epoch. The model is implemented by
[`CallKeyEpochManager`](../packages/core/src/e2ee.ts).

### Rotation triggers

The epoch rotates on **every membership change** — a participant joins or
leaves (observed from the existing `CallParticipant` records / `CallEventStream`,
FR-79). Rotation gives the two properties that motivate epochs:

- **Forward secrecy at epoch granularity.** A member who *left* held only the
  keys for epochs they were part of; after a leave triggers rotation, they can't
  decrypt future media.
- **Post-compromise / no-backfill.** A member who *joins* gets only the new
  epoch's key, so they can't decrypt media from before they were admitted.

### Distribution over the control plane

The participant that triggers a rotation mints the new epoch and **announces** it
to current members via the [`KeyDistributor`](../packages/core/src/e2ee.ts) seam.
This rides the **existing call control plane / signal relay** — concretely a new
`"keyEpoch"` kind on the `WebRTCSignalKind` union in
[`packages/protocol/src/calls.ts`](../packages/protocol/src/calls.ts), carried by
the same `SignalSend`/`SignalDeliver` relay that already moves SDP/ICE/`sfuToken`
opaquely. **No new transport.** Every other member `adopt`s the announced epoch
so the whole call converges on the same `(epochId, key)`. In production the key
is **wrapped per recipient** (to each device's public key) so the relay and SFU
only ever see opaque blobs; the in-memory reference distributor passes raw keys
because the test fabric has no untrusted middlebox.

### Which epoch a frame is under

Each encrypted frame carries a small **SFrame header** that includes its
`epochId` (and a per-epoch frame counter used as the nonce source). On receive,
the transform reads the header, looks up the key for that `epochId` via
`CallKeyEpochManager.keyFor`, and authenticates the header as AEAD associated
data — so a frame can't be tricked into decrypting under the wrong epoch.

### Transition window

Media frames are in flight when a rotation happens; a receiver can get an
epoch-N frame just after moving to epoch N+1. So the manager retains the
**immediately-previous epoch** for a short **transition window**
(`previousEpochWindowMs`, default 5 s) and accepts frames under either the
current or previous epoch during that window. After the window the previous
epoch's key is dropped — which is exactly what enforces forward secrecy for a
departed member. The manager keeps **at most one** prior epoch.

## Where it plugs into the media path (FR-83 / FR-155)

The seam defines the insertion points; **FR-156 does the wiring**. It does not
modify the media path today.

- **Outbound** — in the FR-155 web driver
  ([`packages/core/src/sfu.ts`](../packages/core/src/sfu.ts)), just before a
  local track's frames reach the mediasoup send transport's producer, run
  `SFrameTransform.encrypt` over each frame. The browser hook for this is an
  **Encoded Transform** (`RTCRtpScriptTransform`, or the insertable-streams
  `encodedInsertableStreams` fallback) attached to each `RTCRtpSender`. The
  producer then sends SFrame ciphertext; the SFU forwards it opaquely.
- **Inbound** — symmetrically, attach a receiver-side Encoded Transform to each
  `RTCRtpReceiver` (the consumed track from `recvTransport.consume`) and run
  `SFrameTransform.decrypt` just after the frame leaves the SFU consumer, before
  it is decoded for playback.
- **Key distribution** — drive `CallKeyEpochManager.rotate` from membership
  changes already surfaced by the call control plane, and announce/adopt epochs
  over the `KeyDistributor` (the `"keyEpoch"` signal kind).

Because SFrame ciphertext is opaque application payload, **the server SFU
(FR-83) needs no changes** — it already forwards encrypted RTP. The only server
touch is the additive `"keyEpoch"` signal kind on the relay, which the control
plane forwards byte-for-byte exactly as it does `sfuToken`.

### What FR-156 delivered

FR-156 implemented the production path on top of the FR-85 seam (all in
[`packages/core/src/e2ee.ts`](../packages/core/src/e2ee.ts) unless noted):

1. **Production SFrame cipher suite** — `SFrameCipherTransform` (alongside the
   retained reference `AeadSFrameTransform`). It runs a real **key schedule**:
   the epoch's shared secret is HKDF-expanded (`KeyDerivationProvider`, default
   `WebCryptoKeyDerivation` over HKDF-SHA-256) into a per-epoch AES-GCM **key**
   and a 12-byte nonce **salt** — the epoch secret is never used directly as an
   AEAD key. Each frame carries a **v2 header** (`encode/decodeSFrameV2Header`,
   17 bytes: version + epochId + **senderId** + 64-bit counter) authenticated as
   AEAD associated data. The per-frame **nonce** is `salt XOR (senderId ||
   counter)` (RFC 9605 construction), so every `(epoch, sender, counter)` triple
   is a distinct nonce — no `(key, nonce)` reuse even when all members share one
   epoch key. Real WebCrypto via the injectable `AeadCryptoProvider`/
   `KeyDerivationProvider`, so it stays deterministically testable with injected
   providers.
2. **Replay protection** — `ReplayWindow`, a sliding-window sequence-number
   guard tracked **per (epoch, sender)** on receive. A replayed or out-of-window
   counter is rejected; in-order and reordered-but-fresh counters inside the
   window are accepted. The counter is committed to the window **only after the
   AEAD authenticates**, so a forged frame can't poison the window and starve
   the genuine future frame.
3. **Key-epoch distribution wire path** — the additive `"keyEpoch"`
   `WebRTCSignalKind` (in [`packages/protocol/src/calls.ts`](../packages/protocol/src/calls.ts))
   plus `SignalKeyDistributor`, a `KeyDistributor` that rides the existing
   `sendSignal`/`signalChannel` relay (no new transport). It **wraps** the epoch
   key under a key HKDF-derived from a **symmetric per-room secret** (AES-GCM,
   the key bound to `callId:epochId` as AAD) and announces it as an opaque
   `"keyEpoch"` signal; `poll()` drains inbound announcements, unwraps them
   (skipping our own echoes / stale epochs / wrong-secret blobs — fail-closed),
   and surfaces the reconstructed `KeyEpoch` for the caller to `adopt`.
4. **SFU insertion** — `startSfuCall` ([`packages/core/src/sfu.ts`](../packages/core/src/sfu.ts))
   gained an opt-in `e2ee?: { transform, inserter }` option. When set, the
   driver attaches the transform to every local producer (**encrypt** before
   produce) and every remote consumer (**decrypt** after consume) via the
   injectable `FrameTransformInserter` seam — the browser binds an
   `RTCRtpScriptTransform`; tests inject `MemoryFrameTransformInserter` and pump
   frames through with no DOM. When `e2ee` is omitted the path is unchanged.
5. Codec/SFU constraints: the SFrame header stays **outside** the encrypted body
   (it is AAD, not ciphertext), so metadata the SFU needs remains readable; the
   encrypted body is the opaque frame payload, per the SFrame spec.

**Delivered next by FR-158:** per-recipient **asymmetric** key wrapping — see
[What FR-158 delivered](#what-fr-158-delivered). **Still deferred (genuine future
work):** **MLS** group key agreement. The `KeyDistributor` seam is pluggable, so
swapping the distributor for an MLS one needs no change to
`SFrameCipherTransform` or the media-path insertion. See [Follow-ups](#follow-ups).

### What FR-158 delivered

FR-156's `SignalKeyDistributor` wraps the epoch key under a **symmetric per-room
secret** every member holds. The security gap: a member who is removed but still
knows that room secret can keep unwrapping **future** epoch keys — there is no
per-recipient confidentiality and no forward-secrecy on membership change unless
the shared secret itself is re-established out of band.

FR-158 closes that gap with **per-recipient asymmetric (ECDH) wrapping**, an
**opt-in alternative** `KeyDistributor` (`AsymmetricKeyDistributor`) — the
symmetric `SignalKeyDistributor` is unchanged. All in
[`packages/core/src/e2ee.ts`](../packages/core/src/e2ee.ts):

1. **Asymmetric crypto seam** — `AsymmetricCryptoProvider` (`generateKeyPair` +
   `deriveSharedSecret`), default `WebCryptoAsymmetric` over **ECDH P-256**
   (portable across Node/browser; public keys exported `raw`, private `pkcs8`).
   Like the AEAD/KDF providers it is injectable, so tests use a deterministic
   fake with no WebCrypto and no real curve math. The curve is a provider choice,
   never hardcoded into the distributor.
2. **Member key directory seam** — `MemberKeyDirectory` (`publicKeyFor(memberId)`),
   default in-memory `MapMemberKeyDirectory`. It resolves the published ECDH
   public key for each recipient member id. **How public keys are published and
   authenticated app-side (key transparency, safety-number verification, …) is
   out of scope** — the directory is an *input*.
3. **The wrap construction.** `announce(epoch)` generates a per-announce
   **ephemeral** ECDH key pair and, for **each** current member: derives
   `shared = ECDH(ephemeralPriv, recipientPub)`, expands `KEK = HKDF(shared)`
   (label `fricken/sframe/v2 ecdh-kek`, 16-byte AES key), and AES-GCM-seals the
   epoch key under that KEK with **AAD bound to `keyEpoch:ecdh:callId:epochId:recipientId`**
   (so a blob cannot be replayed cross-recipient or cross-epoch). The `"keyEpoch"`
   signal (distinguished by `wrap: "ecdh"`) carries the ephemeral public key plus
   **one wrapped blob per recipient** — opaque to the relay/SFU.
4. **Receive + fail-closed.** `poll()` finds **our** blob by
   `recipientId === selfMemberId`, derives the same KEK via
   `ECDH(ourPriv, ephemeralPub)`, AES-GCM-opens it, and surfaces the `KeyEpoch`
   for the caller to `adopt`. Every failure mode is dropped silently (never
   thrown out of the poll loop): no blob for us, wrong private key, tampered
   blob, our own echo, or a stale/duplicate epoch id.
5. **Membership-removal forward secrecy (the crucial property).** An epoch
   announced to members `{A,B}` (not `C`) produces blobs **only** for A and B.
   C is not in the recipient set, so there is no blob C can find and no KEK C can
   derive → C cannot obtain that epoch's key, and therefore cannot decrypt any
   media sent under it — even though C may still hold an *old* epoch's key. This
   is enforced *cryptographically by the recipient set*, not by trusting C to
   forget a shared secret. The FR-158 tests prove this end-to-end: after C is
   dropped, C's `poll()` adopts nothing and `keyFor(newEpoch)` is `undefined`, so
   the FR-156 transform rejects post-removal frames with "no key for epoch N",
   while A and B decrypt them.

This is **not MLS**: re-keying is O(members) per epoch (no log-sized tree
ratchet), there is no post-compromise self-healing group ratchet, and the
directory's key authenticity is an app-side input. MLS (RFC 9420) remains the
further evolution and slots in behind the same `KeyDistributor` seam without
touching `SFrameCipherTransform` or the media path. See [Follow-ups](#follow-ups).

## Performance and UX

- **Per-frame transform cost.** Encrypt/decrypt run on every media frame
  (~50/s video, ~50/s audio per track). AES-GCM is hardware-accelerated and the
  marginal cost is small, but it must run **off the main thread** — Encoded
  Transforms run in a worker, which is why the seam is DOM-free and async.
- **Key-rotation glitch avoidance.** The transition window is precisely the
  glitch-avoidance mechanism: without it, every join/leave would drop a burst of
  in-flight frames (a visible freeze / audio gap). 5 s comfortably covers
  jitter-buffer + reorder depth while keeping the forward-secrecy window short.
- **Opt-in, per room.** E2EE is a per-room toggle. A room with E2EE off behaves
  exactly as today (no transform inserted, no epoch traffic). Turning it on is
  additive and backward-compatible; a client that doesn't understand the
  `"keyEpoch"` signal simply can't join an E2EE room's media (fail-closed),
  rather than silently downgrading.
- **UX.** Surface an explicit "encrypted" indicator only when *every* participant
  is in the current epoch; rotation is invisible to the user beyond the
  (avoided) glitch.

## The seam (this ticket)

[`packages/core/src/e2ee.ts`](../packages/core/src/e2ee.ts), exported from
`@fricken/core`, framework-agnostic and DOM-free:

- **`CallKeyEpochManager`** — current/previous epoch, `rotate(members)` on
  membership change, `adopt(epoch)` for peers, `keyFor(epochId)` on receive with
  the transition window.
- **`SFrameTransform`** interface + **`AeadSFrameTransform`** reference impl over
  an injectable **`AeadCryptoProvider`** (default `WebCryptoAeadProvider` lazily
  using `globalThis.crypto.subtle`; tests inject a deterministic fake). The
  header (`encodeSFrameHeader`/`decodeSFrameHeader`) carries the `epochId`.
- **`KeyDistributor`** interface + **`MemoryKeyDistributor`**/
  **`MemoryKeyDistributorFabric`** — the abstract announce/adopt seam, with an
  in-process fake mirroring FR-105's `MemoryRegionBus`/`MemoryRegionFabric`.

> ⚠️ The reference `AeadSFrameTransform` is retained for the FR-85 **seam and
> its tests** — a deterministic encrypt→decrypt path with no browser. It is
> **NOT a production cipher suite.** The production path shipped by FR-156 is
> **`SFrameCipherTransform`** (real key schedule, per-frame nonce, v2 header)
> with `ReplayWindow` replay protection, `SignalKeyDistributor` (symmetric
> sender-key wrapping over the `"keyEpoch"` signal), and the
> `FrameTransformInserter` SFU-insertion seam. FR-158 adds
> `AsymmetricKeyDistributor` (per-recipient ECDH wrapping) over the
> `AsymmetricCryptoProvider` + `MemberKeyDirectory` seams as an opt-in
> alternative distributor.

## Follow-ups

- **FR-156 — DONE.** Production SFrame cipher suite (`SFrameCipherTransform`),
  sliding-window replay protection (`ReplayWindow`), the additive `"keyEpoch"`
  signal kind + control-plane `SignalKeyDistributor` (symmetric sender-key
  wrapping under a per-room secret), and the per-room opt-in
  `FrameTransformInserter` insertion into the FR-155 SFU driver. See
  [What FR-156 delivered](#what-fr-156-delivered).
- **FR-158 — DONE.** Per-recipient **asymmetric (ECDH P-256)** key wrapping:
  `AsymmetricKeyDistributor` (opt-in alternative `KeyDistributor`) wraps the
  epoch key individually to each current member's public key (resolved via the
  injected `MemberKeyDirectory`) over the same `"keyEpoch"` relay, with **no
  shared room secret**. A removed member is not in the recipient set, so no blob
  is wrapped to its key → it cannot obtain future epoch keys (membership-change
  forward secrecy enforced cryptographically). See
  [What FR-158 delivered](#what-fr-158-delivered).
- **MLS group key agreement (remaining).** FR-158 gives per-recipient
  confidentiality and membership-removal forward secrecy, but re-keying is
  O(members) per epoch and there is no post-compromise self-healing group
  ratchet or built-in ghost-member resistance, and member-key authenticity is an
  app-side input (the directory). The genuine next step for log-sized re-keying +
  post-compromise security + ghost-member resistance is **MLS** (RFC 9420). The
  `KeyDistributor` seam is abstract enough to swap an MLS distributor in without
  touching `SFrameCipherTransform` or the media-path insertion.
