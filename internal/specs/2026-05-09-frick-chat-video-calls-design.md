# Frick Realtime Foundation For FrickenChat-Class Apps

Status: Draft foundation spec for implementation planning.

Goal: define the Frick framework foundation needed to eventually build FrickenChat: a serious realtime product with chat, presence, media attachments, and audio/video calls across web, iOS, Android, backend, and future peer-to-peer or edge transports.

This is not a product spec for building FrickenChat right now. It is the platform spec for the data, sync, storage, transport, schema, authorization, and media-control primitives that would make a FrickenChat-class product possible later.

Cutover posture: greenfield. This foundation replaces the current MVP data model and protocol directly. We do not need compatibility with existing local demo data, existing wire frames, or current generated artifacts. Destructive local resets are acceptable until the new foundation is stable. Schema identity and versioning still exist so clients and servers can agree on generated DTOs, but migration tooling is not part of the immediate cutover.

## 1. Core Thesis

Frick should be a schema-driven realtime data fabric, not a chat SDK. FrickenChat is the proving ground, but the framework should remain general enough to support any app with collaborative objects, ordered event streams, offline clients, presence, attachments, and realtime control messages.

Chat, presence, attachments, call control, WebRTC signaling, and app state should all be built from a small set of reusable primitives:

- Durable objects for current state.
- Append-only streams for ordered history.
- Ephemeral presence for live device state.
- Ephemeral signals for routed control messages.
- Blob storage for attachments and generated media.
- Jobs for async fanout, push notifications, indexing, moderation, and media-side effects.

The framework owns schema, DTO generation, local SQL persistence, sync, ordering, authorization, retries, and cross-platform client bindings. Media bytes for calls do not travel through Frick sync. Frick owns the call control plane and WebRTC/SFU signaling; the media plane is WebRTC over SRTP with TURN and an optional SFU adapter.

## 2. Scope

Frick must support these capabilities as first-class framework use cases. They are validation workloads for the foundation, not a requirement to build the full FrickenChat product in this phase:

- Conversations, rooms, direct messages, group chats, and memberships.
- Ordered messages with edits, deletes, redactions, reactions, threads, mentions, delivery receipts, and read receipts.
- Presence, typing indicators, online state, active device state, and last-seen state.
- Attachments with upload, download, resumability, thumbnails, metadata, and optional malware/moderation hooks.
- Push notifications for offline users with privacy-preserving payloads.
- Audio/video call creation, invitation, ringing, join, leave, mute, camera, screen share, participant status, reconnect, and call history.
- WebRTC signaling for SDP offers/answers, ICE candidates, renegotiation, and SFU room/participant tokens.
- Web, Swift, and Kotlin client packages with idiomatic hooks/observable APIs.
- Durable offline send and replay for chat mutations. Calls can be invited while offline through push, but live call media requires network.

Product boundary:

- Build reusable platform primitives first.
- Build thin reference/demo experiences only where needed to prove framework behavior across web, iOS, and Android.
- Avoid product-specific FrickenChat UX, branding, growth features, billing, admin console, or social graph work until the foundation is proven.

Initial non-goals:

- Do not build the FrickenChat product yet.
- Do not relay realtime media through the sync protocol.
- Do not require an in-house SFU on day one.
- Do not promise end-to-end encrypted group calling in the first implementation, but design so MLS/SFrame-style encryption can be added.

## 3. Core Primitives

| Primitive | Durable | Ordered | Purpose | Examples |
| --- | --- | --- | --- | --- |
| Object | Yes | By version | Current replicated state | `User`, `Conversation`, `RoomMember`, `CallRoom` |
| Stream | Yes | Yes | Append-only timeline | `MessageStream`, `RoomEventStream`, `CallEventStream` |
| Event | Yes | Yes | Immutable historical fact | `MessageSent`, `ReactionAdded`, `CallEnded` |
| Presence | No, optionally sampled | Latest per device | Live ephemeral state | typing, online, active call participant state |
| Signal | No by default | Best-effort routed | Short-lived control envelope | SDP offer, ICE candidate, SFU token refresh |
| Blob | Yes | No | Large binary payload storage | attachments, avatars, thumbnails, recordings |
| Job | Yes | By queue | Async side effects | push, thumbnailing, indexing, moderation |
| Projection | Rebuildable | Derived | Query-optimized views | inbox list, unread counts, member summaries |

The important split is this: streams are for truth, objects are for convenient current state, presence is for live UI, signals are for connection setup, and blobs are for bytes.

## 4. Canonical Schema Definition

The schema compiler should define every framework-visible data shape once and generate DTOs, codecs, validators, schema metadata, and client helpers for TypeScript, Swift, and Kotlin.

Requirements:

- Stable field ids, stable type ids, and schema hashes for efficient binary transport.
- Object schemas, stream event schemas, presence schemas, signal schemas, job payload schemas, and blob metadata schemas.
- A single canonical schema for the greenfield cutover, with no compatibility requirement for the current prototype schema.
- Generated native models that can preserve unknown fields later, but do not need rolling-upgrade compatibility for the initial cutover.
- Declarative indexes and projections for server and local SQL stores.
- Declarative authorization hints, with final enforcement performed server-side.
- Schema hash negotiation during client handshake, where mismatch is a hard reconnect/update failure during the greenfield phase.

Example shape:

```text
schema ChatV1 {
  object User(id) {
    1 displayName: string
    2 avatarBlobId: blob<AvatarImage>?
  }

  object Conversation(id) {
    1 title: string?
    2 kind: enum<dm, group, channel>
    3 createdBy: ref<User>
    4 lastMessageEventId: ref<MessageEvent>?
  }

  stream MessageStream(conversationId) {
    event MessageSent
    event MessageEdited
    event MessageRedacted
    event ReactionAdded
    event ReceiptAdvanced
  }

  presence TypingState(conversationId, userId, deviceId) {
    1 isTyping: bool
    2 expiresAt: instant
  }

  signal WebRTCSignal(callId, toDeviceId?) {
    1 senderDeviceId: string
    2 kind: enum<offer, answer, ice, renegotiate, sfuToken>
    3 payload: bytes
    4 expiresAt: instant
  }
}
```

## 5. Transport Protocol

Frick should use one protocol with multiple carriers:

- WebSocket for normal client/server realtime sync.
- HTTP for bootstrapping, uploads, and fallback reads.
- Server-sent events only as a fallback for constrained clients.
- WebRTC data channel or QUIC later for peer-to-peer sync between authorized replicas.

Frame families:

- `hello`: authenticate, declare device id, schema hash, client version, capabilities, and resume tokens.
- `subscribe`: open object, stream, presence, or signal subscriptions.
- `snapshot`: deliver current object/projection state with schema metadata.
- `streamPage`: deliver ordered events from a cursor.
- `append`: submit stream events or object mutations with an idempotency key.
- `ack` / `nack`: confirm persistence, rejection, conflict, or auth failure.
- `delta`: broadcast committed object changes and stream events.
- `presenceSet` / `presenceClear`: set ephemeral state with TTL.
- `signalSend`: route short-lived call/control messages to users, devices, or rooms.
- `cursorCommit`: persist that a client has applied state through a cursor.
- `ping` / `pong`: liveness, latency, and clock skew estimation.

Ordering and identity:

- Every client has a stable `replicaId` and every mutation has a `requestId`.
- Server idempotency is keyed by `(tenantId, replicaId, requestId)`.
- Streams receive monotonic server sequence numbers per stream.
- Events also receive globally sortable ids for pagination and cross-stream inboxes.
- Object versions are monotonically increasing logical versions, not wall-clock timestamps.
- The server is authoritative for committed order. Clients may render optimistic local state until acked.

Backpressure:

- The server advertises a max in-flight window.
- Clients stop appending when the window is full.
- Stream catch-up is paginated.
- Large blobs use resumable upload sessions outside the realtime socket.

## 6. Storage

Server storage must support local development on SQLite and production on Postgres-compatible databases.

Core tables:

- `schema_versions`: schema hash, generated manifest, schema metadata.
- `objects`: tenant, type, id, version, packed current state.
- `stream_events`: tenant, stream type, stream id, sequence, event id, event type, packed payload, author, created_at.
- `stream_cursors`: tenant, user/device, stream key, applied sequence.
- `idempotency_keys`: tenant, replica, request id, result pointer.
- `presence_leases`: tenant, subject, device, payload, expires_at.
- `signal_outbox`: short-lived routed envelopes for connected devices.
- `blob_metadata`: blob id, owner, content hash, size, mime type, storage key, scan state.
- `jobs`: durable async work queue.
- `memberships` / `acl_edges`: authorization graph.

Client storage must be SQL-first on every platform:

- `local_objects`: packed object snapshots by type/id/version.
- `local_stream_events`: durable cached event pages.
- `local_stream_cursors`: server cursor and applied cursor per subscription.
- `pending_mutations`: ordered durable outbox for offline sends.
- `blob_cache`: local file metadata, cache policy, content hash.
- `presence_cache`: optional ephemeral cache with TTL.

SQLite should use WAL mode, prepared statements, batched transactions, and compact binary payload columns. Native clients should never rely on `UserDefaults` or `SharedPreferences` for framework state.

## 7. Chat Semantics

Messages:

- Client generates a provisional message id before sending.
- Server commits a `MessageSent` event with stream sequence and canonical event id.
- Clients reconcile provisional ids to committed ids without duplicate UI rows.
- Message edits and redactions are new events, not destructive rewrites.
- Hard deletes are administrative retention operations and should leave tombstones.

Receipts:

- Delivery receipt means a device accepted the event.
- Read receipt means a user advanced a per-conversation read cursor.
- Read state should be modeled as compact cursor advancement, not per-message booleans.

Reactions:

- Reactions are events with deterministic uniqueness by `(messageId, userId, emoji)`.
- Removing a reaction appends a removal event.

Inbox:

- Conversation list is a projection from streams, memberships, unread cursors, and last-message state.
- The projection must be rebuildable from durable events.

Search:

- Message search is an async projection/index. It is not part of the hot sync path.

## 8. Calls Architecture

Frick owns call state and signaling. WebRTC owns media.

Call objects:

- `CallRoom`: conversation, call kind, created by, lifecycle state, started at, ended at.
- `CallParticipant`: user, device, joined at, left at, role, media state.
- `CallInvite`: target user/device, status, timeout, notification state.

Call streams:

- `CallCreated`
- `CallInviteSent`
- `CallInviteAccepted`
- `CallParticipantJoined`
- `CallParticipantMediaChanged`
- `CallParticipantLeft`
- `CallEnded`

Presence:

- Current microphone/camera/screen-share state.
- Network quality summary.
- Speaking indicator.
- Active device in call.

Signals:

- SDP offer/answer.
- ICE candidate.
- Renegotiation request.
- SFU join response.
- SFU token refresh.
- Media capability update.

Media-plane adapter:

```text
interface MediaPlaneAdapter {
  createRoom(callId, regionHint) -> MediaRoom
  createParticipantToken(callId, userId, deviceId) -> Token
  closeRoom(callId) -> void
  receiveWebhook(event) -> CallEvent[]
}
```

Initial adapters:

- `FakeMediaPlaneAdapter` for deterministic local tests.
- `P2PWebRTCAdapter` for one-to-one calls.
- `LiveKitAdapter` or `mediasoupAdapter` for group calls and production SFU behavior.

Call setup flow:

1. Client appends `CallCreated`.
2. Server creates `CallRoom`, validates membership, and allocates media-plane room if needed.
3. Server emits call events and sends push/ringing notifications to invitees.
4. Joining client requests participant authorization and receives WebRTC/SFU credentials.
5. Clients exchange SDP/ICE through `signalSend`.
6. Participant state is reflected through presence and durable call events.
7. Reconnect resumes call state by call id, participant id, and device id.

### Implementation status (FR-78 + FR-79)

The control/signaling plane described above is implemented in
`apps/server/src/calls/`:

- **FR-78 — `MediaPlaneAdapter`** (`media-plane.ts`): the realized boundary is
  intentionally slightly broader than the four-method sketch above so the same
  interface fits both P2P and SFU futures — `describe()` returns static
  `MediaPlaneCapabilities` (`transport`, `maxParticipants`,
  `supportsRegionHint`); `allocateSession(callId, opts)` (idempotent per call
  id, returns a `MediaSession`); `issueJoinToken(callId, participant, opts)`
  (per-participant short-lived `MediaJoinGrant`); `releaseSession(callId)`
  (idempotent). `receiveWebhook` is deferred to the real SFU adapter (FR-83).
  `FakeMediaPlaneAdapter` (`fake-media-plane.ts`) is the deterministic,
  no-networking implementation used by tests and local dev.
- **FR-79 — `CallControlPlane`** (`call-control-plane.ts`): the server-side
  state machine. It persists `CallRoom` / `CallInvite` / `CallParticipant` via
  the existing object store (no new tables / migration) and appends the durable
  call events to a `CallEventStream`, brokering the media plane on
  create/join/end. Transitions are validated, tenant-scoped, and authz-aware
  (only the creator invites + ends; only invitees join; no action on an ended
  call; participants change only their own media state; auto-end on last leave).
  The call object/stream/event/signal type definitions hosts must include in
  their schema are exported from `call-schema.ts` (`callObjectDefs` etc., plus
  `buildCallSchema()` for a call-only deployment).

## 9. Auth, Privacy, And Safety

Authentication:

- Sessions identify user, tenant, device, and client capabilities.
- Every connection has a server-issued connection id.
- Device identity is durable and revocable.

Authorization:

- Object reads, stream subscriptions, stream appends, presence writes, signal sends, and blob reads must all pass server authorization.
- Signals are never blindly routed; sender and recipient must share a valid call or conversation context.
- Push jobs must re-check authorization before dispatch.

Privacy and security:

- TLS everywhere outside local development.
- Encryption at rest for server secrets and blob storage.
- Short-lived TURN and SFU credentials.
- Optional E2EE roadmap for messages and calls using per-room key epochs.
- Audit log for admin actions, call lifecycle, membership changes, and moderation actions.
- Rate limits for sends, edits, reactions, invites, signals, and uploads.

## 10. Client SDKs

Core APIs should be small and composable.

TypeScript:

```ts
const conversation = useObject("Conversation", id)
const messages = useStream("MessageStream", { conversationId })
const append = useAppend("MessageStream", { conversationId })
const typing = usePresence("TypingState", { conversationId })
const signals = useSignalChannel("WebRTCSignal", { callId })
```

Reference chat-domain package:

- `useConversation(id)`
- `useMessages(conversationId)`
- `sendMessage(conversationId, body, attachments?)`
- `editMessage(messageId, body)`
- `redactMessage(messageId)`
- `addReaction(messageId, emoji)`
- `markRead(conversationId, sequence)`
- `setTyping(conversationId, isTyping)`

Reference calls-domain package:

- `createCall(conversationId, options)`
- `joinCall(callId)`
- `leaveCall(callId)`
- `useCallState(callId)`
- `useCallParticipants(callId)`
- `useMediaSession(callId, localMediaOptions)`
- `setMuted(callId, muted)`
- `setCameraEnabled(callId, enabled)`
- `startScreenShare(callId)`

Swift and Kotlin should expose the same concepts idiomatically:

- Swift: `AsyncSequence`, `Observable`, `@MainActor` view models, SwiftUI modifiers.
- Kotlin: `Flow`, `StateFlow`, suspending functions, Compose state adapters.

## 11. Backend Modules

The server core should be modular:

- `SchemaRegistry`: schema hash negotiation, validation, codegen metadata.
- `ObjectStore`: packed object snapshots and materialized projections.
- `StreamStore`: append-only ordered event storage.
- `SyncGateway`: connection lifecycle, subscriptions, flow control, snapshots, deltas.
- `PresenceHub`: TTL leases, fanout, cleanup.
- `SignalRouter`: authorized ephemeral delivery for calls and peer sync.
- `BlobStore`: upload sessions, content addressing, metadata, storage adapters.
- `AuthzEngine`: membership graph and capability checks.
- `ProjectionRunner`: rebuildable views like inboxes and unread counts.
- `JobRunner`: push, thumbnails, indexing, moderation, recording hooks.
- `MediaPlaneAdapter`: WebRTC/SFU integration boundary.
- `Observability`: metrics, traces, structured logs, replay tools.

## 12. Horizontal Scaling

Single-node local mode:

- SQLite WAL.
- In-process presence, signals, jobs, and WebSocket fanout.
- Great developer experience through Tilt.

Production mode:

- Postgres or CockroachDB for durable state.
- Redis, NATS, or Postgres logical notifications for cross-node fanout.
- Object storage for blobs.
- Workers for jobs and projections.
- Optional sticky WebSocket routing, but correctness must not depend on stickiness.
- Region-aware media room allocation.
- Backfill tools for projection rebuilds.

Required operational metrics:

- Connected clients by platform/version/schema.
- Sync lag by stream and device.
- Mutation ack latency.
- Signal delivery latency.
- Presence lease count and expiry churn.
- Push delivery attempts and failures.
- Call join latency, ICE failure rate, reconnect rate, and SFU errors.

## 13. Testing Strategy

Framework tests:

- Binary codec compatibility across TypeScript, Swift, and Kotlin.
- Schema hash and generated artifact golden tests.
- Deterministic sync simulator with duplicate, reordered, delayed, and dropped frames.
- Idempotency and retry tests.
- Offline outbox replay tests.
- Authorization matrix tests.
- Projection rebuild tests.

Chat tests:

- Multi-device message send and reconcile.
- Edit, redaction, reaction, receipt, and unread behavior.
- Offline send followed by reconnect.
- Attachment upload interruption and resume.

Call tests:

- Fake media-plane call lifecycle.
- SDP/ICE signal routing between web/iOS/Android.
- Invite/ringing timeout behavior.
- Reconnect during active call.
- Group call participant state.
- Permission denial and revoked membership during call.

End-to-end targets:

- Web browser.
- iOS simulator.
- Android emulator.
- At least one test where all three clients observe the same chat and call state.

## 14. Implementation Milestones

1. Canonical schema cutover: replace the prototype Task/Project model with object, stream, presence, signal, blob, job, and projection definitions.
2. Canonical transport cutover: replace the prototype frames with typed frame families, hard schema-hash negotiation, cursors, and flow control.
3. Server stream store: durable event log, object projections, idempotency, and subscription fanout.
4. Client SQL runtime: object cache, stream cache, cursors, pending mutation outbox, and generated DTO codecs.
5. Reference chat foundation: conversations, memberships, ordered messages, optimistic append, reconnect, and cross-platform conformance demos.
6. Realtime collaboration completeness: edits, redactions, reactions, read cursors, typing, presence, attachments, and push jobs as reusable primitives.
7. Signal primitive: authorized ephemeral signal routing with TTL and connected-device targeting.
8. Reference media-control foundation: fake media-plane adapter, call room lifecycle, participant state, and thin web/iOS/Android call harnesses.
9. P2P WebRTC validation: one-to-one audio/video calls using Frick signaling.
10. SFU adapter boundary: group audio/video calls with region allocation, TURN credentials, reconnect, and media state sync.
11. Production hardening: authz audits, rate limits, metrics, chaos tests, and projection rebuild tooling.

## 15. Acceptance Criteria

The foundation is ready to support a real FrickenChat-class app when:

- A single schema generates usable TypeScript, Swift, and Kotlin DTOs.
- Web, iOS, and Android clients can load the same conversations from local SQL-backed caches.
- Messages sent on one client appear on the others in committed order without duplication.
- Offline chat mutations persist locally and replay safely after reconnect.
- Typing, presence, read receipts, and reactions propagate live.
- Attachments upload out-of-band and sync as typed metadata.
- A user can start a call from one client and join from another.
- WebRTC signals route only to authorized devices.
- P2P one-to-one calls work locally.
- Group call state works through the SFU adapter boundary.
- Reconnect restores chat and active call control state.
- The server can run in local SQLite mode and production Postgres-compatible mode.
- The sync simulator proves correctness under reconnects, duplicate sends, reordered frames, and dropped connections.

## 16. Open Design Decisions

- Start with Postgres production mode first, or evolve from SQLite while preserving the storage interface.
- Pick the first SFU adapter: LiveKit for speed, mediasoup for control, or both behind the same interface.
- Decide whether message E2EE is part of the initial foundation or a later security milestone.
- Decide whether P2P sync is an early differentiator or a later transport once client/server sync is excellent.
- Decide the first projection language: declarative schema annotations, TypeScript projectors, SQL projectors, or all three in stages.

## 17. Next Artifact

The next artifact should be an implementation plan that breaks this spec into isolated workstreams:

- Protocol/schema.
- Server storage and sync.
- Client runtime and native SQL.
- Chat package and demo.
- Presence/signals.
- Calls/WebRTC.
- SFU integration.
- Verification and production hardening.
