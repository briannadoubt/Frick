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
- Operators can proactively revoke sessions through
  `POST /_frick/admin/sessions/revoke`, either by single bearer token or by
  `(userId, tenantId?)`. Matching live WebSockets are closed with policy code
  `1008`, and the action is audit-logged.
- The framework assumes transport is secure (TLS) and does not enforce it —
  the demo `http.createServer` listens on plain HTTP. Operators are expected
  to terminate TLS at a reverse proxy.

**Known gaps.**

- No device-binding (e.g. token bound to a specific deviceId / replicaId at
  the server side). The session row carries deviceId/replicaId but those
  values came from the client at login.
- No refresh-token / short-access-token split. Token lifetime is one knob.
- No per-principal throughput limiter on token-using HTTP endpoints, so an
  attacker who has the token is bounded by deployment-level controls rather
  than a framework request-rate quota.

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

## Cross-user object sharing

**Threat.** A user gains access to another user's object record without an
explicit share, or a valid share accidentally grants broader access than the
owner intended.

**Today.**

- Sharing is represented by framework-managed invitation and grant tables,
  scoped by tenant id. Invitation tokens are opaque, single-use, expire after a
  bounded lifetime, and can only be accepted inside the issuing tenant by a
  different user.
- A redeemed invitation creates a durable grant for one `(recordType,
  recordId)` with `"read"` or `"write"` permission. `"write"` satisfies both
  `object.write` and `object.read`; `"read"` satisfies only `object.read`.
- Grant lookup runs after baseline policy checks and app policy hooks. It only
  relaxes denials for `object.read` / `object.write` with
  `notAuthorizedForResource` or `ownerMismatch`; it does not override
  unauthenticated, not-member, tenant-mismatch, or schema compatibility
  failures.
- The same grant lookup runs per record on object subscription snapshots and
  deltas (FR-116), so a grant relaxes live read visibility for the grantee, not
  just individual HTTP-style reads.
- The owner who issued the grant revokes it via `DELETE /share/grants/:id`,
  and the grantee can self-revoke ("leave") their own grant via
  `POST /share/grants/:id/leave`. Each verb is scoped to one role: the leave
  route only honours the grantee, and DELETE only honours the owner; any other
  caller gets a tenant-isolated `404`. Revoked grants stay in storage for
  audit/listing but no longer participate in authorization.
- A grant cascades **read** access to the primitives derived from the shared
  object (FR-70). Because streams and projections are keyed by an id rather than
  by object type, the cascade matches by **record id**: a grant on object
  record `(recordType, recordId)` authorizes the grantee to read
    - the stream whose `streamId === recordId`, and
    - the projection rows whose subscribe/read `key === recordId`,
  within the same tenant. The cascade runs after baseline policy and app policy
  hooks and only relaxes `notAuthorizedForResource` / `ownerMismatch` /
  `notMember` denials (the same fail-open-only contract as object reads). It is
  strictly read-only:
  `stream.append` and every write verb are never relaxed, and a `"read"` grant
  is sufficient (a `"write"` grant also satisfies it because `"write"`
  satisfies `"read"`). When a surface has no resolvable row id — e.g. a
  whole-projection subscribe with no `key` — the cascade is skipped and the
  original deny stands (fail closed: deny rather than over-share).

**Known gaps.**

- Share creation currently trusts an authenticated tenant principal to issue an
  invitation for the named record; apps that need stricter owner/admin checks
  should gate the calling workflow with policy or product logic.
- The grant cascade is intentionally narrow. It covers the shared object's
  associated stream (by `streamId`) and projection rows (by `key`) only. Grants
  still do not cascade to blobs, jobs, search results, or custom app routes;
  those derived surfaces remain object-record/owner scoped (search-result
  cascade is tracked separately under FR-71). The cascade keys purely on id
  equality — an app that reuses one id across an object type and an *unrelated*
  stream/projection would share both; apps with such id collisions should
  namespace ids or tighten access with a policy hook.

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
- Idempotency has a bounded replay window (`FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS`,
  default 24h). A retry outside the window is treated as a fresh request and
  rewrites the idempotency key to the new event.
- Idempotency rows live alongside the event row in the stream store. Lookup is
  bounded by the replay window, but durable pruning/retention of old rows is
  still a production-hardening follow-up.

**Known gaps.**

- No rate limit on appends, so the second attack vector (distinct
  requestIds) is unmitigated.
- No durable pruning of old idempotency rows yet.

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

- The framework supports OPTIONAL detached signing of generated schema
  artefacts. `signSchemaArtifact` / `verifySchemaArtifact` (`@fricken/protocol`)
  use Ed25519 (`node:crypto`) to sign a canonical representation of the schema
  identity — `schemaId` + `schemaHash` + `schemaRevision` + a manifest of the
  emitted artifact files and their SHA-256 digests. When
  `FRICK_SCHEMA_SIGNING_KEY` (a PEM or base64-DER private key) is set,
  `pnpm schema:generate` emits a detached signature at
  `packages/protocol/generated/schema-signature.json` (gitignored — published
  as a release-pipeline artifact, never committed). A client that ships the
  matching trusted public key can call `verifySchemaArtifact` (or
  `verifySchemaArtifactForSchema`, which additionally pins the expected schema
  identity) to reject a poisoned bundle. The example verifier
  `packages/protocol/scripts/verify-schema-signature.ts` shows the client
  flow.

**Known gaps.**

- Signing is opt-in and the framework does not yet ship a default trusted key
  or key-rotation tooling. Without `FRICK_SCHEMA_SIGNING_KEY` set, generation
  emits no signature and clients perform no artefact verification, so a
  build-pipeline compromise is only mitigated for deployments that have
  adopted signing and distributed a public key to clients out of band.

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
  entries may be the allow-all wildcard `*`, an exact origin, or a single
  subdomain wildcard of the form `<scheme>://*.<host>` (e.g.
  `https://*.example.com`). A subdomain wildcard matches any non-empty
  subdomain prefix over the same scheme and port — `https://app.example.com`
  and `https://a.b.example.com` match `https://*.example.com`, but the apex
  `https://example.com` does **not** unless it is also listed exactly. Mid-host
  wildcards, bare-host wildcards (`https://*`), and multiple wildcards per
  entry are rejected at config load with `FrickConfigError`. When a request
  origin matches via wildcard, the server reflects the concrete request origin
  (with `Vary: Origin`) rather than the pattern string. Session tokens still
  travel via `Authorization: Bearer …` rather than cookies, so the browser
  will not silently attach credentials cross-origin even before CORS rules
  apply.

**Known gaps.**

- The browser remains the authority on whether a non-preflight response is
  delivered to JavaScript. A non-browser client (curl, a malicious server)
  can still reach the body of a disallowed-origin request — this is
  intentional and matches industry-standard CORS semantics. Operators that
  want hard server-side refusal can apply it at a reverse proxy.
- Wildcard matching is limited to a single leading-label subdomain wildcard
  per entry (`<scheme>://*.<host>`). Path-, scheme-, or port-level patterns,
  regex entries, and multi-segment wildcards are intentionally unsupported.

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
- `pnpm --filter @fricken/web build` emits the same strict preview header set
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
- Concurrent WebSocket connections are capped per authenticated principal
  (`maxConnectionsPerPrincipal`, keyed by `(tenantId, userId)`) in addition to
  the global `maxWebSocketConnections` cap. The per-principal counter is
  in-process (consistent with the single-node model) and resets on restart;
  over-cap connections receive a `rateLimit.exceeded` Nack and a `1013` close
  without affecting other principals.
- Idempotency cache (see Replay above) and stream-store rows grow without
  pruning.

**Known gap.** Operators should still enforce request-rate, connection-count,
and bandwidth limits at a reverse proxy / WAF. The per-principal connection cap
is in-process only — multi-node deployments do not share the counter — and
durable retention policies remain production-hardening follow-ups.

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

## Self-service account data export

**Threat.** The authenticated `GET /account/export` route returns a principal's
own data. A naive implementation could leak another principal's records, cross
a tenant boundary, or hand the requester secret material (credentials, tokens)
that happens to be co-located on a record they own.

**Today.**

- The route is gated by the standard protected-path authentication; an
  unauthenticated request returns `401`. The principal — including its tenant —
  is derived from the session token and cannot be overridden by the body or
  path.
- Object reads go through the tenant-scoped store, so the export only ever sees
  the session's tenant. A cross-tenant record whose owner field matches the
  caller's `userId` is still invisible (verified by test).
- Within the tenant, records are filtered to those the principal owns: a record
  is included only when one of its `ownerId` / `userId` / `createdBy` fields
  equals the principal's `userId`.
- Sensitivity: the export is the user's own data, so `pii`, `private`, and
  `content` fields are returned in full. `secret`-classified fields are masked
  with `<redacted>` (via the FR-65 `redactRecord` helper) so the export cannot
  become a credential-exfiltration channel.
- The response sets `cache-control: no-store`.
- App-specific data is added only through the explicit `onAccountExport` hook,
  which the host wires deliberately and which is responsible for scoping its own
  reads to the principal's tenant and user id.

**Known gaps.**

- The framework default scopes ownership to the conventional owner-field names;
  a schema that stores ownership under a different field, or that models shared
  records, must override the owner-field set (or supplement via the hook) to
  export those records.
- Account *retention* policies (soft-delete windows, legal-hold) are out of
  scope for this route (tracked separately); account *deletion* is the
  self-service surface described next.

---

## Self-service account deletion

**Threat.** The authenticated `DELETE /account` route (alias `POST /account`)
erases a principal's own account, sessions, and owned object rows. Deletion is
destructive and irreversible, so the risks are (a) a scoping bug that deletes
*another* principal's or another tenant's data, and (b) an unauthenticated or
cross-principal actor triggering a deletion.

**Today.**

- The route is gated by the standard protected-path authentication; an
  unauthenticated request returns `401` before the handler runs. The principal —
  including its tenant — is derived from the session token and cannot be
  overridden by the body or path, so there is no way for one principal to name
  another as the deletion target.
- The framework default (`deleteAccountData`) reuses the export's scoping:
  object deletes go through the tenant-scoped store, owner matching uses the
  same `ownerId` / `userId` / `createdBy` convention (`DEFAULT_OWNER_FIELDS`),
  and session/account deletes are scoped to `(userId, tenantId)`. A cross-tenant
  record whose owner field collides with the caller's `userId` is therefore
  never reached (verified by test).
- App-specific cascades run only through the explicit `onAccountDelete` hook,
  which the host wires deliberately and which owns its own tenant/owner scoping.
  It runs after the framework default has committed, so a hook failure is
  fail-forward (framework-managed data stays deleted) rather than a silent
  partial rollback.
- Every deletion appends an `account.delete` entry to the tamper-evident admin
  audit hash chain, so a forced or fraudulent deletion is detectable after the
  fact. The response sets `cache-control: no-store`.

**Known gaps.**

- The framework default scopes ownership to the conventional owner-field names;
  a schema that stores ownership under a different field, or that models shared
  records, must override the owner-field set (or supplement via the hook) to
  delete those records.
- Retention/soft-delete and legal-hold are out of scope (tracked separately) —
  a deletion is immediate and hard.

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
routes for Apple, Google, generic OpenID Connect issuers, and email/password
accounts. The framework verifies Apple identity and notification JWTs with
`jose`, Apple's published JWKS, issuer `https://appleid.apple.com`, and the
app-configured audience. It verifies Google ID tokens with Google's published
JWKS, accepted Google issuer values, and the app-configured OAuth client id.
Generic OIDC providers (`identityProviders.oidc`) are verified with `jose`
against the provider's JWKS — resolved either from a configured `jwksUri` or by
fetching the issuer's `<issuer>/.well-known/openid-configuration` discovery
document and reading its `jwks_uri` — and checked against the configured
`issuer`, the configured audience (defaulting to the OAuth `clientId`), and
expiry, plus the request `nonce` when one is supplied. When discovery is used,
the discovery document's own `issuer` must match the configured issuer, so a
hijacked well-known endpoint cannot silently repoint key resolution at another
IdP. Apple, Google, and OIDC all use the verified `sub` claim as the stable
provider subject, never a client-supplied user id; OIDC subjects are stored as
a per-provider composite `"<providerId>:<sub>"` so two issuers cannot alias onto
the same account.

The app owns the User schema object. Frick writes and reads that row through
the configured field mapping, calls `onFirstSignIn` so the app can choose the
tenant and optional user id, and mints a normal bearer session. Email/password
signup stores password credentials through the server account store and
normalizes email handles to lowercase. Password reset requests always return a
generic success response, call the app-owned `onPasswordResetRequested` hook
only for known accounts, store reset tokens only as SHA-256 hashes, expire them
after 60 minutes, and consume them on first successful use. A completed reset
updates the stored password hash and deletes active sessions for that user.
Apple `consent-revoked` and `account-delete` notifications set the mapped
`revokedAt` field and delete active sessions for the user before calling the
optional `onRevoke` hook.

Provider sessions are minted with the single configured
`FRICK_SESSION_TTL_SECONDS` lifetime — the same TTL as built-in
password/dev-login sessions, not a separate fixed 30-day value — and the
provider verify routes plus the email password-reset routes share the same
per-(route, identity/IP) auth-attempt limiter the password-login routes use
(FR-29), so an attacker cannot sidestep the password-login ceiling by hammering
a provider or reset route. Verify routes bucket by client IP; `forgot-password`
buckets by email; `reset-password` by token. Tripping the limit returns `429`
with a `Retry-After` header.

**Known gaps.**

- SAML and arbitrary non-OIDC OAuth provider routing are not implemented
  (generic OIDC issuers are now supported via `identityProviders.oidc`).

---

## Out-of-scope (deliberate)

The following are recognised threats the framework does not address and is
not yet planning to:

- Federated identity beyond the built-in Apple, Google, generic OIDC, and
  email/password provider routes (SAML or arbitrary non-OIDC OAuth providers).
- Side-channel attacks on the SQLite file (encryption at rest).
- Hardware attestation for native clients.
- End-to-end encryption of message payloads. The framework sees plaintext
  message bodies for indexing/projection today.
