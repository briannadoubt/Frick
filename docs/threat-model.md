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

- Session tokens are random 256-bit values (`randomBytes(32).toString("base64url")`).
  The server stores only a SHA-256 token digest in `auth_sessions` with
  `expiresAt`; the raw bearer is returned once at session creation and then
  used only as lookup input. The token itself carries no claims — every
  request hits the DB to validate.
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
- `assertCanAppend` authenticates the writer and runs app-provided
  `policyHooks`; payload ownership checks are app/domain policy.
- `assertBlobOwnership` requires the upload's `ownerId` to match the
  principal's `userId`, denying with `ownerMismatch`.

**Known gaps.**

- Stream/event payload binding is not inferred by default. App authors must
  register `policyHooks` on `createFrickServer` to tighten app-specific stream
  rules.

---

## Unauthorized subscriptions

**Threat.** A subscriber asks for a stream, signal, or object collection
they are not permitted to read.

**Today.**

- Every HTTP read path that depends on membership calls
  `assertCanSubscribe` / `assertCanAppend` / `assertCanReadInbox`, which now
  produce typed `FrickDecision` denials surfaced as `auth.forbidden`
  envelopes with `details.reason ∈ { notMember, notAuthorizedForResource,
  ownerMismatch, unauthenticated }`.
- The SyncGateway uses the same primitives for WebSocket subscribe/append,
  signal, and presence frames before opening a delta channel or accepting a
  write.

**Known gaps.**

- App-specific visibility semantics are owned by policy hooks; without hooks,
  authenticated tenant users can use declared objects, streams, signals, and
  presence types inside their tenant.

---

## Search index exposure

**Threat.** A tenant user queries a custom app-provided full-text index whose
source object, stream, or projection has app-specific visibility semantics the
framework cannot prove.

**Today.**

- `POST /search` requires authentication, resolves the index before querying,
  and scopes adapter calls to `principal.tenantId`.
- App-provided indexes are denied to tenant users by default. Apps must
  register a `policyHooks` handler that returns an explicit allow for the
  `search.query` action and target index. Deny hooks still win.
- Admin principals can query custom search indexes for inspection and
  operational workflows.

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

- Blob reads (`GET /blobs/:id/content`) assert `blob.read` ownership before
  returning bytes, and blob listing defaults to the caller's own rows. The
  framework still has no per-user quota.

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

## Browser demo shell and stored browser state

**Threat.** A browser-facing demo page is embedded by another origin, runs
unexpected script/style, keeps a stale bearer token after expiry, or carries
one user's local push-registration state into the next login.

**Today.**

- `apps/web` ships a Vite config that serves CSP plus browser hardening
  headers (`X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`, COOP/CORP, and `Service-Worker-Allowed`) for the
  demo app. Preview builds use a no-`unsafe-inline` / no-`unsafe-eval`
  policy; the dev server keeps the `script-src`, `style-src`, and local
  `connect-src` allowances Vite needs for React refresh and HMR.
- `pnpm --filter @frick/web build` emits the same strict preview header set
  to `dist/_headers` for static hosts that honor root `_headers` files.
- The demo keeps live auth sessions in memory only. Startup and sign-in purge
  any legacy `sessionStorage` / `localStorage` bearer tokens instead of
  restoring or migrating them, so reloading the demo requires re-auth.
- Logout clears browser-held user state before the best-effort server
  logout request, including the stored session and web push-registration
  marker.
- The demo Service Worker normalizes notification deep links to same-origin
  app routes before posting `frick:navigate` to a tab or opening a window.

**Known gaps.**

- Hosts that do not honor `dist/_headers` must carry equivalent headers in
  that server or CDN config.
- The dev-server CSP is intentionally weaker than preview so HMR keeps
  working. Use preview or a production host to audit the stricter policy.
- Bearer tokens are still readable by same-origin JavaScript while a session
  is active in memory; CSP reduces XSS blast radius but does not make bearer
  tokens HttpOnly.

---

## DoS via large payloads, rapid reconnects, or unbounded subscriptions

**Threat.** An attacker submits multi-gigabyte blob uploads, opens thousands
of WebSocket connections, or subscribes to an unbounded number of streams
to exhaust server memory.

**Today.**

- HTTP JSON bodies, blob uploads, stream append payloads, WebSocket frames,
  subscription counts, pending append queues, search queries, search filters,
  forward stream pages, WebSocket connections, and SSE connections are bounded
  by `FrickLimits`.
- WebSocket inbound frames are capped by `maxWebSocketFrameBytes` before
  MessagePack decode; oversized frames are closed by the WebSocket parser.
- Forward stream backlogs for HTTP reads, SSE initial pages, and WebSocket
  subscriptions are page-limited and return `cursor` / `hasMore`.
- No per-principal connection cap.
- Idempotency cache (see Replay above) and stream-store rows grow without
  pruning.

**Known gap.** Operators should still enforce request-rate, connection-count,
and bandwidth limits at a reverse proxy / WAF. Per-principal connection caps
and durable retention policies remain production-hardening follow-ups.

---

## Tenant boundary

Frick threads an opaque `tenant_id` column through every framework-managed
storage table (objects, stream events, presence leases, signal outbox, blob
metadata + content, jobs, auth sessions, auth accounts,
idempotency keys) and a `tenantId` field on every `Principal`. The principal's
tenant is derived from the session token at the start of each request and
cannot be overridden by the body or path. Storage reads are tenant-scoped, so
cross-tenant resource lookups return "not found" rather than leaking
existence; an explicit `decide()` check denies remaining cross-tenant access
with the typed reason `tenantMismatch`. Account handles are unique
per-tenant, not globally — `dorothy` in `tenant-a` and `dorothy` in
`tenant-b` are distinct accounts. Legacy single-tenant deployments use
`_default` as the implicit tenant for all rows, and migration `0003` backfills
existing rows accordingly without changing the wire protocol.

**Known gap**: tenant assignment is per-session and per-account; there is no
admin route for moving an account between tenants. The framework does have a
tenants ledger and admin bearer principals for cross-tenant operations, but
account re-homing still needs an explicit migration workflow.

---

## Password storage (current state)

The framework hashes account passwords with Node's `crypto.scrypt` using a
per-user salt. This is intentional and acceptable for the framework's
current threat model (low-volume demo accounts), but it is not the
production target — a future slice will introduce a configurable hash
function and parameter set. This document captures the current algorithm
so a deployment audit can flag it.

---

## Identity providers (current state)

Apps may configure `createFrickServer({ identityProviders })` to mount provider
routes for Apple, Google, and email/password accounts. The framework verifies
Apple identity and notification JWTs with `jose`, Apple's published JWKS,
issuer `https://appleid.apple.com`, and the app-configured audience. It
verifies Google ID tokens with Google's published JWKS, accepted Google issuer
values, and the app-configured OAuth client id. Apple and Google use the
verified `sub` claim as the stable provider subject, never a client-supplied
user id.

The app owns the User schema object. Frick writes and reads that row through
the configured field mapping, calls `onFirstSignIn` so the app can choose the
tenant and optional user id, and mints a normal bearer session. Email/password
signup stores password credentials through the server account store and
normalizes email handles to lowercase. Apple `consent-revoked` and
`account-delete` notifications set the mapped `revokedAt` field and delete
active sessions for the user before calling the optional `onRevoke` hook.

**Known gaps.**

- Provider sessions currently use a fixed 30-day lifetime instead of the
  `FRICK_SESSION_TTL_SECONDS` knob used by built-in password/dev-login
  sessions.
- The provider routes do not yet share the built-in auth attempt limiter.
- Generic OIDC, SAML, and arbitrary OAuth provider routing are not implemented.

---

## Out-of-scope (deliberate)

The following are recognised threats the framework does not address and is
not yet planning to:

- Generic federated identity beyond the built-in Apple, Google, and
  email/password provider routes (OIDC, SAML, or arbitrary OAuth providers).
- Side-channel attacks on the SQLite file (encryption at rest).
- Hardware attestation for native clients.
- End-to-end encryption of message payloads. The framework sees plaintext
  message bodies for indexing/projection today.
