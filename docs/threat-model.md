# Frick framework threat model (baseline)

This document describes the threats the Frick fullstack framework considers
today and where the gaps are. It is descriptive, not prescriptive — language
like "today" reflects current behaviour, and "known gap" flags places where
the framework deliberately defers a mitigation to a later hardening slice.

Scope: the framework code under `apps/server` and the cross-platform client
contract documented in `docs/cross-platform-client-contract.md`. App-level
business logic and operator deployment choices are out of scope except where
the framework forces a choice.

---

## Token theft

**Threat.** An attacker obtains a `sessionToken` (via XSS, device theft, log
exfil, or man-in-the-middle on a non-TLS link) and replays it against the
server.

**Today.**

- Session tokens are random 256-bit values (`randomBytes(32).toString("base64url")`),
  stored server-side in `auth_sessions` with `expiresAt`. The token itself
  carries no claims — every request hits the DB to validate.
- Sessions are time-bounded by `sessionTtlSeconds` (default 7 days, configurable
  per environment). Expired sessions return the `auth.sessionExpired` envelope
  on the next protected request, prompting clients to prompt re-login.
- The session row records `lastSeenAt`, which an operator could mine for
  anomalous reuse, but the framework does not raise alerts on its own.
- The framework assumes transport is secure (TLS) and does not enforce it —
  the demo `http.createServer` listens on plain HTTP. Operators are expected
  to terminate TLS at a reverse proxy.

**Known gaps.**

- No proactive session revocation API; an operator can only delete the row
  directly in SQL.
- No device-binding (e.g. token bound to a specific deviceId / replicaId at
  the server side). The session row carries deviceId/replicaId but those
  values came from the client at login.
- No refresh-token / short-access-token split. Token lifetime is one knob.
- No rate limiting on token-using endpoints, so an attacker who has the token
  has unbounded throughput. This is flagged as a slice-10 gap.

---

## Spoofed user, device, or replica ids in request bodies

**Threat.** A client (or attacker controlling a session) submits a request
whose body claims to be from a different user — e.g. a `MessageSent` payload
with `senderId: "user-grace"` posted from Ada's session.

**Today.**

- The HTTP and WebSocket layers derive `Principal` exclusively from the
  validated session row (`session.userId`, `session.deviceId`,
  `session.replicaId`). Request bodies cannot override these values; the
  WebSocket hello frame's `replicaId`/`deviceId` are accepted as cosmetic
  metadata but are not used for authorization once a session is bound.
- `assertCanAppend` checks `payload.senderId === principal.userId` for
  `MessageSent` and `payload.userId === principal.userId` for
  `ReceiptAdvanced`, producing `ownerMismatch` denials.
- `assertBlobOwnership` requires the upload's `ownerId` to match the
  principal's `userId`, denying with `ownerMismatch`.

**Known gaps.**

- Custom stream/event types beyond `MessageStream` get no payload-binding
  check. App authors must add their own checks until the policy hook system
  ships.
- No tenant boundary — `Principal` has no `tenantId`. Multi-tenant isolation
  is a future refactor.

---

## Unauthorized subscriptions

**Threat.** A subscriber asks for a stream, signal, or object collection
they are not permitted to read (e.g. a non-member subscribing to a private
conversation's `MessageStream`).

**Today.**

- Every HTTP read path that depends on membership calls
  `assertCanSubscribe` / `assertCanAppend` / `assertCanReadInbox`, which now
  produce typed `FrickDecision` denials surfaced as `auth.forbidden`
  envelopes with `details.reason ∈ { notMember, notAuthorizedForResource,
  ownerMismatch, unauthenticated }`.
- The SyncGateway uses the same primitives for WebSocket subscribe/append
  frames before opening a delta channel.

**Known gaps.**

- Signal subscriptions go through `assertCanSignal`, which is a no-op today.
  Any authenticated principal can subscribe to any signal name/key.
- The framework's authz primitives only recognise `MessageStream` membership.
  App-specific streams currently bypass membership checks; this is
  documented as the policy-hook extension point in `authz.ts`.

---

## Replay and idempotency abuse

**Threat.** An attacker resubmits a captured append (`requestId` known) to
cause duplicate side effects, or floods the server with distinct
`requestId`s to amplify writes.

**Today.**

- The append path is idempotent on `(requestId, replicaId)`: a duplicate
  submission returns the original `event` without re-emitting deltas. This
  is verified by the `does not fan out idempotent HTTP append retries` test.
- Idempotency rows live alongside the event row in the stream store; they
  are never garbage-collected today, so the table grows unbounded.

**Known gaps.**

- No rate limit on appends, so the second attack vector (distinct
  requestIds) is unmitigated.
- No replay-window bound — `requestId` is honoured indefinitely.

---

## Blob ownership confusion

**Threat.** Ada uploads bytes that claim `ownerId: "user-grace"`, either to
masquerade as Grace, fill Grace's quota, or insert content into Grace's
listing.

**Today.**

- `assertBlobOwnership` denies the upload with the typed `ownerMismatch`
  reason both for PUT-content and POST-metadata flows.
- Content-hash validation (`sha256-…`) prevents an attacker from binding new
  bytes to an existing `(blobId, contentHash)` pair without recomputing the
  hash; the server cross-checks `byteLength` and `contentHash` on PUT.

**Known gaps.**

- Blob reads (`GET /blobs/:id/content`) currently do not assert the reader
  is allowed to see the blob — any authenticated principal can fetch any
  blob by id. A future slice will add a `blob.read` action with membership
  semantics.
- No per-user quota.

---

## Schema downgrade or incompatible generated clients

**Threat.** A client built against an older schema connects and sends frames
the server can no longer interpret, or vice versa.

**Today.**

- The hello handshake exchanges `clientCapabilities` carrying
  `schemaId / schemaRevision / schemaHash`. The server runs
  `schemaCompatibility` and either accepts (matching revision, even if
  hashes differ) or returns a `FrickErrorEnvelope` with
  `code: "schema.incompatible"` and the server's expected schema fields.
- All HTTP error envelopes include `schemaHash` and `schemaRevision` so a
  drifting client can detect the mismatch from any failed request, not just
  the handshake.

**Known gaps.**

- The framework does not yet sign schema artefacts. A malicious actor that
  controls the build pipeline could publish a poisoned schema bundle to
  native apps. Signing is deferred.

---

## Cross-origin browser access

**Threat.** A browser visiting `evil.example` issues credentialed requests
against a Frick server hosted at `frick.example`.

**Today.**

- The server enforces an explicit allowlist for both HTTP and WebSocket
  origins via `config.allowedOrigins` (env var `FRICK_ALLOWED_ORIGINS`).
  Development defaults to `*`; production defaults to `[]` and requires
  explicit values. Disallowed preflight (`OPTIONS`) requests are refused
  with HTTP 403 and a `FrickErrorEnvelope` carrying
  `code: "auth.forbidden"`, `details.reason: "originNotAllowed"`. Disallowed
  non-preflight requests are served without `Access-Control-Allow-*`
  headers — the browser blocks the response from JavaScript, matching
  typical Express/Node CORS-middleware semantics. WebSocket upgrades from
  disallowed origins are refused at the `verifyClient` callback with HTTP
  403. Same-origin / server-to-server requests (no `Origin` header) bypass
  CORS by design — this is correct browser semantics, not a gap. Allowlist
  matching is exact-string only: pattern matching (regex, suffix, subdomain
  wildcards) is a known limitation. Session tokens still travel via
  `Authorization: Bearer …` rather than cookies, so the browser will not
  silently attach credentials cross-origin even before CORS rules apply.

**Known gaps.**

- The browser remains the authority on whether a non-preflight response is
  delivered to JavaScript. A non-browser client (curl, a malicious server)
  can still reach the body of a disallowed-origin request — this is
  intentional and matches industry-standard CORS semantics. Operators that
  want hard server-side refusal can apply it at a reverse proxy.
- No subdomain or pattern matching; large deployments that need many
  per-tenant origins must list each exact value.

---

## DoS via large payloads, rapid reconnects, or unbounded subscriptions

**Threat.** An attacker submits multi-gigabyte blob uploads, opens thousands
of WebSocket connections, or subscribes to an unbounded number of streams
to exhaust server memory.

**Today.**

- No body size limits — `readJsonBody` and `readRawBody` buffer everything.
- No connection cap on the WebSocket server.
- No per-principal subscription cap.
- Idempotency cache (see Replay above) and stream-store rows grow without
  pruning.

**Known gap.** All of the above are flagged for a dedicated production-
hardening slice (slice 10). Operators must enforce limits at a reverse
proxy / WAF for now.

WebSocket inbound frames are capped at `FrickLimits.maxWebSocketFrameBytes` (default 512KB). Oversized frames are rejected with `rateLimit.exceeded` before msgpack decode, and the connection is closed.

---

## Password storage (current state)

The framework hashes account passwords with Node's `crypto.scrypt` using a
per-user salt. This is intentional and acceptable for the framework's
current threat model (low-volume demo accounts), but it is not the
production target — a future slice will introduce a configurable hash
function and parameter set. This document captures the current algorithm
so a deployment audit can flag it.

---

## Out-of-scope (deliberate)

The following are recognised threats the framework does not address and is
not yet planning to:

- Federated identity (OIDC, SAML, OAuth) — deferred indefinitely.
- Side-channel attacks on the SQLite file (encryption at rest).
- Hardware attestation for native clients.
- End-to-end encryption of message payloads. The framework sees plaintext
  message bodies for indexing/projection today.
