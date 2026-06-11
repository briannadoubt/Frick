# FR-276 — Realtime calls: Rust server port (delivery plan)

Status: planning. Author: claude. Date: 2026-06-11.

The realtime calls control plane is the one remaining large feature not yet
ported to the Rust server. This plan decomposes it into independent,
individually-shippable stories. It is grounded in three fixed constraints — the
already-shipped native clients, the already-defined wire contract, and the
deleted TS implementation — so the port is a faithful re-implementation, not a
redesign.

## 1. What is already fixed (the port must match these)

**The wire contract already exists in `crates/frick-protocol`.** Calls do NOT
need a new frame: `CallCommand` (frame kind 21) and `CallCommandResult` (kind
22) are defined (`frame.rs`, `calls.rs` — `CallCommandPayload` /
`CallCommandResultPayload`), call state rides the normal **object** store
(`CallRoom` / `CallInvite` / `CallParticipant`) and **stream** events
(`CallCreated`, `CallInviteSent`, `CallParticipantJoined`, …), and SDP/ICE ride
the existing **`WebRTCSignal`** signal type. `packages/protocol/src/calls.ts`
pins the shapes: `CallKind` (audio|video), `CallRoomState`
(ringing|active|ended), `CallInviteState`, `CallParticipantState`,
`WebRTCSignalKind` (offer|answer|ice|…), `CallMediaGrant`, and the command
shapes `CreateCall` / `JoinCall` / `AcceptCall` / `LeaveCall` / `EndCall` /
set-media-state.

**The native + web clients already ship and define the API surface.** They must
work unchanged against the Rust server:
`packages/swift/.../FrickCallSession.swift` + `FrickCalls.swift`,
`apps/android/.../FrickCallManager.kt` (`create` / `join` / `accept` / `leave` /
`end` / `setMediaState` issued as `CallCommand`s; decode CallRoom/Invite/
Participant/MediaGrant), and `packages/core/src/calls.ts`.

**Current Rust state.** The gateway does NOT handle `CallCommand` (calls are
deferred); a `CallCommand` frame is currently unhandled. `WebRTCSignal` is
accepted as a generic signal but is **not** gated on call membership (the
cross-impl conformance suite documents this: the TS server returns `403
notMember`, the Rust server currently accepts). No call object/stream/event
schema, no control plane, no media-plane seam exist yet.

**The deleted TS implementation is the reference** (recover via
`git show 763e5d2~1:apps/server/src/calls/<file>`):
`call-schema.ts` (the call type defs + `buildCallSchema()`), `call-control-plane.ts`
(FR-79, the state machine), `media-plane.ts` (FR-78, `MediaPlaneAdapter`),
`fake-media-plane.ts`, `p2p-media-plane.ts`, `sfu-media-plane.ts` +
`sfu-backend.ts` + `fake-sfu-backend.ts` + `mediasoup-sfu-backend.ts`,
`media-placement.ts` + `cluster-media-placement.ts`. The design spec is
`internal/specs/2026-05-09-frick-chat-video-calls-design.md` §8 + the FR-78/FR-79
implementation-status notes; E2EE is `docs/e2ee-calls.md`. Carry over the
calls/native audit fixes FR-204 (in-flight callCommand continuation), FR-207,
FR-210 (E2EE senderId truncation), FR-211 (#finalizeEnd cast).

## 2. Architecture (unchanged from the TS design)

> Frick owns call **state + signaling**; WebRTC owns **media**.

The control plane persists `CallRoom`/`CallInvite`/`CallParticipant` as ordinary
objects (no new tables), appends durable `Call*` stream events, relays SDP/ICE
over authorized `WebRTCSignal`s, and brokers a pluggable `MediaPlaneAdapter`
(fake → P2P → SFU) for room allocation + per-participant join grants. The
determinism seam holds: the control plane is the time/id boundary; the media
plane is a trait so tests run with a deterministic fake.

## 3. Phased decomposition (each ≈ one PR)

Ordered by dependency. Acceptance is the bar for "shippable."

### Phase A — `MediaPlaneAdapter` seam + `FakeMediaPlaneAdapter` (port FR-78)
The trait (`describe() -> MediaPlaneCapabilities`, `allocate_session(call_id,
opts) -> MediaSession` (idempotent per call), `issue_join_token(call_id,
participant, opts) -> MediaJoinGrant`, `release_session(call_id)`) + the
deterministic, no-network fake. **Acceptance:** unit-tested fake; the trait
compiles as the seam the control plane consumes. No clock/RNG inside the
adapter. *Deps: none.*

### Phase B — Call schema + `CallCommand` frame routing
Port `call-schema.ts` (the CallRoom/CallInvite/CallParticipant object defs, the
`Call*` events/streams, the WebRTCSignal signal, and `build_call_schema()` for a
call-only deployment), and route the `CallCommand` frame (21) through the
gateway to a control-plane handler that replies with `CallCommandResult` (22).
**Acceptance:** a `CallCommand` reaches the handler and returns a typed
`CallCommandResult`; an app schema can include the call types. *Deps: A.*

### Phase C — `CallControlPlane` state machine (port FR-79)
The server-side lifecycle over the object/stream stores using the fake media
plane: `create` / `invite` / `accept` / `decline` / `join` / `leave` / `end` /
`set-media-state`, with validated transitions, tenant scoping, and authz (only
the creator invites + ends; only invitees join; no action on an ended call;
participants change only their own media state; auto-end on last leave). Appends
the durable `Call*` events; brokers `allocate_session` on create/join and
`release_session` on end. **Acceptance:** the full lifecycle works end-to-end
against the fake media plane; the Swift/Kotlin/web `create/join/accept/leave/end/
setMediaState` calls resolve with the right records + events; conformance-style
tests cover the authz denials. *Deps: A, B.*

### Phase D — `WebRTCSignal` call-membership gating
Gate the `WebRTCSignal` relay on call membership: only current participants of
the call may exchange SDP/ICE (the TS `403 notMember`), replacing the current
ungated accept. **Acceptance:** a non-member's `WebRTCSignal` is rejected
(`auth.forbidden` / `notMember`); members' signals relay at-most-once; update
the cross-impl conformance scenario that currently tolerates both outcomes to
assert the gate. *Deps: C.*

### Phase E — Push-on-incoming-call (ringing)
Wire the invite flow to enqueue a ringing **push** to invitees via the
now-wired push subsystem (FR-265) + the `CallInvite` notification state.
**Acceptance:** creating a call with invitees enqueues a `push.deliver` job per
invitee with the call payload; cancelling/accepting updates invite notification
state. *Deps: C, push (done).*

### Phase F — `P2PMediaPlaneAdapter`
Port `p2p-media-plane.ts` — one-to-one calls with no SFU (the grant carries
ICE/TURN config; media is peer-to-peer over the signal relay). **Acceptance:** a
1:1 call allocates a P2P session and the two clients exchange SDP/ICE via the
gated relay; selectable via config (`FRICK_CALLS_MEDIA_PLANE=fake|p2p|sfu`).
*Deps: A, D.*

### Phase G — SFU adapter boundary + media placement
Port `sfu-media-plane.ts` + `sfu-backend.ts` (the `SfuBackend` trait + a
real backend — LiveKit or mediasoup; **decision required**, see risks) +
`media-placement.ts` / `cluster-media-placement.ts` (region/cluster room
allocation + the media-placement sentinel tenant already present in the cluster
bus). **Acceptance:** group calls allocate an SFU room + per-participant join
tokens; region hint honored; the fake-SFU backend gives deterministic tests.
*Likely split into G1 (adapter + fake-SFU backend) and G2 (a real backend +
placement). Deps: A, F.*

### Phase H — Call E2EE key exchange
Port the call E2EE per `docs/e2ee-calls.md` (per-call key distribution + the
sender-key relay), carrying the FR-210 senderId fix. **Acceptance:** per the
e2ee doc's key-rotation + membership-change tests, with a pure-Rust crypto
stack. *Deps: D.*

### Phase I — Calls conformance + SDK acceptance
Add the calls scenarios to the `frick-conformance` black-box suite and run the
Swift/Kotlin/web call clients against the Rust server end-to-end. **Acceptance:**
the call conformance scenarios pass; a user starts a call on one client and
joins from another (the spec's headline acceptance criterion). *Deps: C–H.*

## 4. Risks + open decisions

- **SFU backend choice (G).** LiveKit (Go server + a Rust SDK / REST token
  minting) vs mediasoup (Node) vs adapter-only-with-a-fake. The control plane
  only needs the `MediaPlaneAdapter` boundary, so A–F ship without choosing;
  G forces the call. Recommend: ship the adapter seam + fake-SFU first, defer
  the production backend choice to a deployment decision (token-minting via REST
  keeps it pure-Rust).
- **TURN/STUN.** P2P/SFU both need ICE servers; the grant carries the config, so
  this is deployment config, not server code — but document it.
- **E2EE crypto staying pure-Rust (H).** Sender-key E2EE wants X25519 + an AEAD;
  confirm pure-Rust crates (`x25519-dalek`, `chacha20poly1305`) before starting,
  consistent with the no-OpenSSL posture held through the auth work.
- **Media is not CI-testable.** Real WebRTC/SFU media can't run in CI; the
  `FakeMediaPlaneAdapter` + fake-SFU backend make the **control plane** fully
  deterministic-testable. Live media is validated manually + in the demo apps.
- **Audit fixes to carry:** FR-204, FR-207, FR-210, FR-211 (calls/native).

## 5. Proposed stories (ready to file under FR-276)

1. **Calls A — MediaPlaneAdapter seam + FakeMediaPlaneAdapter** (port FR-78). *high.*
2. **Calls B — call schema + CallCommand/CallCommandResult gateway routing.** *high.*
3. **Calls C — CallControlPlane state machine** (port FR-79, fake media plane). *high.*
4. **Calls D — WebRTCSignal call-membership gating** (403 notMember + conformance). *high.*
5. **Calls E — ringing push on incoming-call invite** (via FR-265 push). *medium.*
6. **Calls F — P2P media-plane adapter** (1:1 calls). *medium.*
7. **Calls G1 — SFU adapter boundary + fake-SFU backend + media placement.** *medium.*
8. **Calls G2 — production SFU backend** (LiveKit/mediasoup — needs the backend decision). *medium.*
9. **Calls H — call E2EE key exchange** (pure-Rust, carry FR-210). *medium.*
10. **Calls I — calls conformance + native SDK acceptance against the Rust server.** *high.*
