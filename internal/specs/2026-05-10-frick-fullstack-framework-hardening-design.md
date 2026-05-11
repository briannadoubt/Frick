# Frick Fullstack Framework Hardening Design

Status: Draft umbrella spec for implementation planning.

Goal: define the missing framework contracts Frick needs before it can become a drop-in fullstack solution across server, web, Swift, and Android.

This is not a starter-template spec. Frick should not hide unfinished system boundaries behind a generator yet. This spec names the pieces that must become coherent first: migration/versioning, auth/security, deployment, observability, integration coverage, and public API boundaries.

## 1. Core Thesis

Frick should become a schema-driven fullstack application framework: one canonical data contract, one realtime sync model, one durable storage model, and idiomatic client runtimes for every supported platform.

The framework must first make its internal contracts explicit. After those contracts are stable, a starter app, CLI, package release, or hosted deployment story can wrap them without baking in accidental demo assumptions.

The current chat/foundation apps remain proving harnesses. They should exercise real framework behavior, but they should not define the framework boundary by accident.

## 2. Framework Boundary

Frick owns:

- Canonical schema metadata, generated DTOs, codecs, and compatibility checks.
- Server persistence for objects, streams, presence leases, signals, blobs, jobs, sessions, and projections.
- Realtime sync transport over WebSocket, HTTP fallback/bootstrap routes, and SSE fallback where supported.
- Local client cache/runtime behavior, including offline queues and pending append replay.
- Capability negotiation, sync limits, conflict policy, and cross-platform protocol compatibility.
- Extension points for app schema modules, authorization policies, projections, jobs, blob processors, search, and notification delivery.
- Public TypeScript, React, Swift, and Kotlin APIs for framework primitives.
- Cross-platform design tokens and reusable primitive components where they are framework-level building blocks.
- Operational contracts for configuration, health, logging, metrics, inspection, CLI tooling, and graceful shutdown.
- Release, package distribution, CI, provenance, compatibility support, and artifact verification.
- Backup/restore expectations, privacy lifecycle primitives, security operations, performance benchmarks, developer diagnostics, accessibility, localization, and documentation structure.
- Secure default presets, config guardrails, credential provider boundaries, app manifests, typed operation helpers, policy test harnesses, local test runtimes, seed/fixture workflows, trace replay, schema diffs, upgrade checks, and focused module examples.
- Schema linting, app module composition, multi-app server boundaries, feature flags, environment promotion, import/export, local cache lifecycle, maintenance workflows, support bundles, compliance evidence hooks, dependency governance, and internationalization readiness.

Applications own:

- Product-specific schema extensions beyond the Frick foundation schema.
- Product screens, flows, copy, branding, and navigation choices outside reusable shell primitives.
- Product auth providers, identity policy, billing, moderation policy, analytics policy, and app-specific business rules.
- Product-specific projections, jobs, notification templates, search indexes, blob processing policies, and conflict handlers.
- Deployment topology choices beyond the supported Frick server/runtime contracts.
- Product privacy policy choices, retention windows, legal workflows, and user-facing account/data management UX.
- Product-specific app manifests, seed data, fixtures, tutorials, localized copy, UX behavior for framework errors, and external service credentials.
- Product module packaging choices, feature rollout strategy, environment promotion approvals, import/export mapping, support workflows, compliance claims, dependency risk acceptance, region/data-residency policy, and user-facing admin tools.

Demo apps own:

- Example product flows that prove the framework works end-to-end.
- Thin sample usage of framework APIs.
- Fixture accounts, demo copy, and local-only shortcuts.
- Example docs and smoke flows that prove public APIs without becoming product requirements.

Demo apps must not own:

- Auth/session semantics used by reusable clients.
- Protocol or storage behavior.
- Schema compatibility policy.
- Shared UI primitives that belong in design packages.
- Helpers that a real app would need to copy into production.

## 3. Schema, Versioning, And Migrations

Frick needs a formal compatibility model that replaces the current greenfield reset posture.

### Schema Identity

Every schema must expose:

- `schemaId`: stable product/framework schema name, such as `frick-foundation`.
- `schemaVersion`: human-readable semantic version, such as `0.2.0`.
- `schemaRevision`: monotonically increasing integer for migrations and generated artifacts.
- `schemaHash`: content hash of the canonical schema definition.
- `minimumClientRevision`: lowest generated client revision the server can accept.
- `minimumServerRevision`: lowest server revision a generated client can talk to.

The hash remains the strongest exact-match check. Revisions provide a controlled path for compatible rolling upgrades.

### Compatibility Rules

Initial rules should be conservative:

- Removing a type, event, field, enum value, or required index is breaking.
- Renaming a field without preserving its stable field id is breaking.
- Adding an optional field is compatible.
- Adding a new object type, stream event type, presence type, signal type, or job payload is compatible when older clients can ignore it.
- Adding a required field is breaking unless the migration backfills it for all persisted records before clients observe it.
- Changing field type, requiredness, or semantic meaning is breaking.
- Generated native artifacts must include schema identity metadata and fail loudly when server compatibility is outside supported bounds.

### Server Migrations

The server must own a migration runner, even while SQLite is the only implemented database.

Requirements:

- Maintain a `frick_migrations` table with migration id, schema revision, applied timestamp, checksum, and execution duration.
- Apply migrations exactly once inside transactions where the database supports it.
- Refuse to boot if a migration checksum changes after it has been applied.
- Refuse to boot if the database revision is newer than the server supports.
- Provide a dev-only reset command or documented reset path that is explicit and never runs in production mode.
- Keep framework storage migrations separate from app schema migrations.

### Client Cache Migrations

Each client cache must store schema identity metadata locally.

Requirements:

- Web memory/local cache, Swift SQLite cache, and Android SQLite cache record schema id, revision, and hash.
- If the server is exactly compatible, the cache remains available.
- If the cache is older but migratable, client migration steps run before sync resumes.
- If the cache is incompatible and the app opts into destructive dev reset, the client clears framework cache tables and reconnects.
- If the cache is incompatible in production mode, the client surfaces a typed migration error and stops sync.
- Pending appends must either migrate safely or fail with a typed error that preserves enough information for app-level recovery.

### Authoring Workflow

Schema changes should follow one path:

1. Change canonical schema.
2. Add compatibility metadata.
3. Add server migration when persisted data changes.
4. Add client cache migration when local data changes.
5. Regenerate TypeScript/Swift/Kotlin artifacts.
6. Run compatibility tests across old and new fixtures.

### Implementation Instructions

First implementation pass:

- Extend `packages/protocol/src/schema.ts` and `packages/protocol/src/foundation.ts` with `schemaId`, `schemaVersion`, `schemaRevision`, `minimumClientRevision`, and `minimumServerRevision`.
- Add compatibility helpers in `packages/protocol/src/compatibility.ts` that return a typed result such as `compatible`, `clientTooOld`, `serverTooOld`, or `hashMismatch`.
- Generate schema metadata into Swift and Kotlin artifacts from `packages/protocol/scripts/generate-native-artifacts.ts`.
- Add `apps/server/src/storage/migration-store.ts` and a migration runner owned by `apps/server/src/storage/schema.ts` or a new `apps/server/src/storage/migrations.ts`.
- Add metadata tables to Swift and Android client storage, then add tests that prove incompatible caches fail closed.
- Update handshake handling in `apps/server/src/sync/gateway.ts`, `packages/core/src/runtime.ts`, `packages/swift/Sources/FrickSwift/FrickClient.swift`, and `apps/android/frick/src/main/java/dev/frick/client/FrickClient.kt`.
- Verify with `pnpm test`, `pnpm typecheck`, `pnpm swift:test`, and the Android SDK unit tests before declaring the slice complete.

## 4. Auth, Identity, And Authorization

Frick needs a production security posture while keeping demo auth clearly labeled as demo-only.

### Identity Model

Framework identity should distinguish:

- `Account`: login identity and credentials or external identity provider mapping.
- `User`: application-visible actor.
- `Device`: installed client instance.
- `Session`: authenticated device/user authorization token.
- `Principal`: request-time security context derived from a session or service credential.
- `Tenant`: optional isolation boundary for future multi-tenant deployments.

The current local account/password flow can remain as a built-in development provider, but production deployments must be able to replace or disable it.

### Session Contract

Sessions must define:

- Token format and storage expectations.
- Expiration time, refresh policy, and revocation behavior.
- Device binding expectations.
- Transport rules for HTTP authorization headers and WebSocket authentication.
- Secure logging rule: never log raw session tokens, password hashes, or credential material.

Short-term implementation can use opaque bearer tokens stored server-side. The spec should not require JWTs until a concrete deployment need exists.

### Password And Credential Policy

The built-in password provider must be treated as framework code if it remains available outside demos.

Requirements:

- Password hashes use a production password hashing algorithm when available in the runtime environment.
- Login and signup responses use generic auth failure messages.
- Handles and display names are normalized consistently.
- Rate-limit hooks exist for login, signup, token refresh, blob upload, and append routes.
- Password reset and email verification are explicitly out of scope until an app/product layer owns email delivery.

### Authorization Model

Authorization must be server-authoritative.

Requirements:

- All object reads, stream reads, appends, presence writes, signal sends, blob reads/writes, inbox reads, and job effects pass authorization checks.
- Authz checks operate on a typed principal and framework primitive metadata.
- Apps can register policy hooks for product-specific authorization.
- Framework default policies handle foundation objects such as users, conversations, room members, blobs, and inbox projections.
- Denials produce typed errors with safe public messages and private diagnostic codes.
- Tests must prove non-members cannot read, append, signal, upload as another owner, or inspect private inbox state.

### Permission And Policy Model

Frick should expose a small, inspectable policy model without turning authorization into a stringly typed DSL.

Policy concepts:

- `Action`: operation being attempted, such as `object.read`, `stream.append`, `blob.write`, or `signal.send`.
- `Resource`: typed framework primitive plus ids, such as `Conversation:conversation-1` or `MessageStream:conversation-1`.
- `Relationship`: durable edge such as owner, member, participant, blocked, admin, or service.
- `Grant`: rule that permits an action for a principal/resource relationship.
- `Decision`: allow or deny with a stable reason code and safe public message.

Implementation requirements:

- Keep policy enforcement in TypeScript code so it can use real types and storage access.
- Define policy input/output types in `apps/server/src/authz.ts` or a new `apps/server/src/policy.ts`.
- Give apps a registration point for policy hooks that can augment or override framework defaults.
- Ensure every denial path returns the shared error envelope once that envelope exists.
- Add tests that assert the reason code, not only the HTTP status.

### Tenant Boundary

Frick should support an optional tenant boundary from the beginning of production hardening, even if single-tenant remains the default.

Requirements:

- `Principal` can carry `tenantId`.
- Server storage APIs accept tenant context for every durable primitive.
- New tables and indexes introduced by future migrations include tenant columns when the primitive is tenant-scoped.
- Demo data can use a default tenant.
- Cross-tenant access is denied by default.

The first implementation may store all current records in a default tenant, but new public APIs should not make tenant support impossible.

### Threat Model

Frick needs a short threat model document covering:

- Token theft.
- Spoofed user ids or device ids.
- Unauthorized subscriptions.
- Replay/idempotency key abuse.
- Blob ownership confusion.
- Schema downgrade or incompatible generated clients.
- Cross-origin browser access.
- Denial of service through huge payloads, rapid reconnects, or unbounded subscriptions.

### Implementation Instructions

First implementation pass:

- Split demo-only auth behavior from reusable auth behavior in `apps/server/src/server.ts` and `apps/server/src/authz.ts`.
- Introduce typed policy input/output objects and reason codes before adding new checks.
- Add production-mode config that disables `/auth/dev-login` unless explicitly enabled.
- Add session expiry tests for HTTP and WebSocket paths.
- Add denial tests for object reads, stream reads, appends, blob writes, signals, and inbox reads.
- Add a short threat model document under `docs/` or a security section in the operations guide.
- Do not introduce JWTs or third-party identity providers until the opaque session and policy boundaries are stable.

## 5. Storage And Deployment

Frick needs a deployment contract before it needs a deployment abstraction.

### Runtime Modes

Supported modes:

- `development`: local SQLite, permissive CORS, demo auth allowed, destructive reset allowed.
- `test`: isolated database paths or in-memory SQLite, deterministic ports, short timeouts, stable fixtures.
- `production`: explicit database path/URL, restrictive CORS, demo auth disabled unless deliberately enabled, destructive reset disabled.

The server must fail fast when production mode lacks required configuration.

### Configuration

Server configuration should be explicit and documented:

- `FRICK_ENV`
- `FRICK_HOST`
- `FRICK_PORT`
- `FRICK_DB_DRIVER`
- `FRICK_DB_PATH`
- `FRICK_PUBLIC_URL`
- `FRICK_ALLOWED_ORIGINS`
- `FRICK_SESSION_TTL_SECONDS`
- `FRICK_BLOB_STORAGE_DRIVER`
- `FRICK_BLOB_STORAGE_PATH`
- `FRICK_LOG_LEVEL`
- `FRICK_DEMO_AUTH_ENABLED`

The first implementation can still support only SQLite and local blob storage, but the configuration names should not block future Postgres or object storage adapters.

### Storage Interfaces

Storage should be split by responsibility:

- Object store.
- Stream/event store.
- Presence store.
- Signal store.
- Blob metadata store.
- Blob content store.
- Job store.
- Account/session store.
- Migration store.
- Projection/inbox store.

Each store should expose framework-level behavior, not raw SQL details. SQLite remains the concrete implementation until Postgres work is planned.

### Health And Lifecycle

Server operations require:

- `GET /health` for process liveness.
- `GET /ready` for database/migration readiness.
- Graceful shutdown that closes HTTP, WebSocket, database, and timers.
- Startup logs that include framework version, schema id/revision, database driver, runtime mode, and public URL.
- No startup log should include secrets.

### Operational Docs

Docs should cover:

- Local development.
- Test execution.
- Production configuration.
- Database backup expectations.
- Migration workflow.
- Blob storage layout.
- Rolling upgrade constraints.
- Troubleshooting common schema/auth/sync failures.

### Admin And Inspection Surface

Frick needs a framework inspection surface before it needs a product admin UI.

Minimum inspectable state:

- Server version, schema id, schema revision, and schema hash.
- Applied migrations and pending migrations.
- Runtime mode and enabled feature flags, excluding secrets.
- Active WebSocket connection count.
- Recent structured errors by code.
- Job queue counts by status.
- Blob metadata counts and local storage path health.
- Storage readiness and database revision.

Initial delivery should be a small set of authenticated server endpoints and CLI commands. A visual admin console is outside this spec.

### Operations CLI

Frick should eventually expose operational commands that call framework libraries directly:

- `frick schema check`
- `frick schema generate`
- `frick migrate status`
- `frick migrate up`
- `frick doctor`
- `frick reset --dev`
- `frick inspect server`
- `frick inspect db`
- `frick verify artifacts`

The CLI is not a starter generator. It is maintenance tooling for the framework and its apps.

Implementation requirements:

- Start with package scripts that call stable TypeScript modules.
- Extract a CLI package only after the module boundaries are clear.
- Refuse destructive commands unless `FRICK_ENV=development` or an explicit dev flag is present.
- Print machine-readable JSON first; human-readable summaries can be added after the JSON shape is stable.
- Reuse the same schema compatibility, migration, and artifact verification code used by tests.

### Implementation Instructions

First implementation pass:

- Create a server configuration module, likely `apps/server/src/config.ts`, that parses env vars into typed runtime config.
- Add `GET /ready` beside `GET /health`.
- Add a graceful shutdown method on the object returned by `createFrickServer`.
- Move local blob content behavior behind a storage adapter interface before adding additional drivers.
- Add inspection routes under a clearly framework-owned prefix such as `/_frick/inspect/*`; require authentication or disable them outside development until production auth policy exists.
- Add package scripts for `frick:doctor`, `frick:migrate:status`, and `frick:verify` once the underlying modules exist.
- Document every supported env var in `README.md` or a new operations guide.

## 6. Transport, Errors, And Observability

Frick needs one error and diagnostics language across HTTP, WebSocket, TypeScript, Swift, and Kotlin.

### Error Envelope

All framework-visible errors should share:

- `code`: stable machine-readable code.
- `message`: safe human-readable summary.
- `requestId`: per-request or per-frame correlation id.
- `retryable`: boolean.
- `details`: optional safe structured metadata.
- `schemaHash` or `schemaRevision` when relevant.

HTTP errors should serialize this envelope as JSON. WebSocket nacks should carry the same envelope. Client SDKs should expose typed error objects rather than raw strings.

Initial error code families:

- `auth.unauthenticated`
- `auth.forbidden`
- `auth.sessionExpired`
- `schema.incompatible`
- `schema.migrationRequired`
- `storage.conflict`
- `storage.notFound`
- `stream.appendRejected`
- `sync.protocolError`
- `sync.reconnectExhausted`
- `blob.tooLarge`
- `blob.unsupportedContentType`
- `rateLimit.exceeded`
- `server.internal`

### Request And Frame Correlation

Requirements:

- HTTP requests get a request id if the client does not provide one.
- WebSocket append/subscribe/signal frames preserve request ids.
- Server logs include request id, principal user id when available, route/frame kind, status code/error code, and duration.
- Client SDKs expose request id on errors for support/debugging.

### Structured Logging

Server logs should be structured objects, even if initially written to stdout.

Log events should cover:

- Startup and shutdown.
- Migration start/success/failure.
- Auth success/failure without secrets.
- HTTP request completion.
- WebSocket connection, authentication, subscribe, append ack/nack, disconnect.
- Blob upload/download metadata.
- Background job enqueue/complete/fail.

### Metrics And Diagnostics Hooks

The framework should define hooks before choosing a metrics backend:

- Counter: HTTP requests by route/status.
- Counter: WebSocket frames by kind/result.
- Gauge: active WebSocket connections.
- Gauge: pending appends per client where locally available.
- Histogram: append persistence latency.
- Histogram: sync catch-up duration.
- Counter: migration success/failure.
- Counter: auth failures by reason.

Client runtimes should expose lightweight sync diagnostics:

- Current connection state.
- Last successful sync time.
- Last error code/request id.
- Pending mutation count.
- Known stream cursors.
- Schema compatibility status.

### Implementation Instructions

First implementation pass:

- Add shared error code/types in `packages/protocol/src/errors.ts`.
- Change HTTP error handling in `apps/server/src/server.ts` to emit the shared envelope for all framework-visible failures.
- Change WebSocket nack frames in `apps/server/src/sync/gateway.ts` and protocol frame types to carry the same envelope.
- Add request id creation and propagation for HTTP requests and WebSocket frames.
- Add a small structured logger module in `apps/server/src/logger.ts` with redaction rules.
- Add typed error wrappers in TypeScript core first, then mirror the generated-safe shape in Swift and Kotlin.
- Add tests that assert error code, `retryable`, and `requestId` for at least one HTTP auth error, one WebSocket append rejection, and one schema mismatch.

## 7. Capability Negotiation And Extension Model

Frick needs explicit negotiation so platforms can evolve at different speeds without pretending every client supports every feature.

### Capability Negotiation

During handshake, clients should announce:

- Schema id, revision, hash, and generated artifact version.
- Client platform: web, node, iOS, macOS, Android, test, or service.
- Client SDK version.
- Supported transports: WebSocket, SSE, HTTP polling fallback.
- Supported protocol encodings and compression.
- Supported primitives: objects, streams, presence, signals, blobs, jobs, projections.
- Offline cache support and pending append replay support.
- Blob upload modes: direct, resumable, signed URL, local-only.
- Push notification support and token type when available.
- Experimental feature flags.

The server should reply with:

- Accepted schema compatibility result.
- Enabled server capabilities.
- Required client behavior changes, such as disabling resumable upload or push registration.
- Limits that the client must obey, such as frame size, page size, subscription count, and heartbeat interval.

Negotiation must be explicit and logged. If the server cannot safely support the client, the connection fails with `schema.incompatible` or `sync.protocolError`.

### Extension Model

Frick should define how applications add behavior without editing framework internals.

Extension points:

- Schema modules: app-owned object, stream, event, presence, signal, job, and blob metadata definitions.
- Authorization policies: app-owned policy hooks that run after framework default checks or at documented extension points.
- Projections: app-owned derived views fed by framework object/stream changes.
- Jobs: app-owned background task handlers.
- Blob processors: app-owned validation, thumbnailing, metadata extraction, and moderation hooks.
- Search indexers: app-owned indexing and query adapters.
- Notification intents: app-owned semantic notification definitions.
- Observability hooks: app-owned metrics/log sinks.

Extension rules:

- Framework defaults must work without app extensions.
- Extensions are registered at server creation time, not discovered through global mutable state.
- Extension hooks receive typed context objects with principal, tenant, request id, schema metadata, and logger.
- Extension hooks return typed decisions or outputs, not thrown strings.
- A failing extension must produce a structured framework error.
- Tests must be able to install isolated fake extensions.

### Implementation Instructions

First implementation pass:

- Extend the protocol `Hello` frame shape to include `clientCapabilities` and server `HelloAck` or equivalent accepted capability metadata.
- Add compatibility tests that prove an unsupported required capability causes a typed rejection.
- Add server-side `FrickExtensionRegistry` types in `apps/server/src/extensions.ts`.
- Change `createFrickServer(options)` to accept extension registrations without forcing app code into global imports.
- Keep the first registry empty except for policy hooks and projection hooks; add jobs/blob/search adapters when those slices start.
- Add SDK-side capability builders in TypeScript, Swift, and Kotlin that produce conservative defaults.
- Document the negotiated capability names so clients do not invent incompatible strings.

## 8. Projections, Querying, And Search

Objects and streams are not enough for real apps. Frick also needs rebuildable derived views and a query surface that can scale from SQLite to future production stores.

### Projection System

Projection requirements:

- Projections are derived from object changes, stream events, jobs, or other projections.
- Projection state is rebuildable from durable source data.
- Projection handlers are idempotent.
- Projection updates can be emitted to subscribers like object updates.
- Projection definitions declare their source primitives, output shape, version, and rebuild strategy.
- Projection storage is separated from raw object/stream storage.
- Projection failures are observable and do not corrupt source-of-truth records.

Initial framework projections:

- Inbox rows.
- Unread counts.
- Conversation member summaries.
- Blob attachment summaries.

### Query Contract

The first query API should be intentionally small:

- List objects by type with authorization.
- Read object by type/id with authorization.
- Read stream page by stream/key/cursor.
- Read projection rows by projection name and key.
- Search through registered search indexes when enabled.

Avoid a full general-purpose query language until storage adapters and authorization rules are mature.

### Search And Indexing

Search should be pluggable:

- SQLite FTS can be the first local/server implementation.
- External engines such as Meilisearch, Typesense, OpenSearch, or hosted search belong behind future adapters.
- Indexers consume projection/object/stream changes.
- Search results must pass authorization before leaving the server.
- Search index rebuilds are jobs with observable status.

### Implementation Instructions

First implementation pass:

- Add projection definition types in `packages/protocol/src/projections.ts` or the server extension registry if they are server-only at first.
- Extract existing inbox update behavior into an explicit projection module under `apps/server/src/projections/`.
- Add a projection store boundary in `apps/server/src/storage/`.
- Add tests that rebuild inbox state from durable conversation/member/message data.
- Add a read endpoint for projection rows only after the storage and authz tests exist.
- Add a small search adapter interface but do not implement external search yet.
- Add one SQLite FTS-backed proof only if a current app flow needs search; otherwise keep search as an adapter contract and tests around registration.

## 9. Jobs, Push, And Side Effects

Framework side effects need a durable lifecycle so apps can add push notifications, indexing, thumbnails, moderation, and webhooks without coupling them to HTTP request handling.

### Job Lifecycle

Jobs must support:

- Enqueue with idempotency key.
- Claim by worker.
- Complete.
- Fail with retryable/non-retryable error.
- Retry with backoff.
- Dead-letter after max attempts.
- Inspect by job id and status.
- Emit structured logs and metrics.

Job records should include:

- Job id.
- Job type.
- Tenant id when applicable.
- Payload.
- Status.
- Attempt count.
- Max attempts.
- Available-at timestamp.
- Created/updated timestamps.
- Last error code and message.

### Side Effect Policy

Side effects must be separated from source-of-truth writes:

- Stream append persistence succeeds or fails independently from notification delivery.
- Jobs are enqueued transactionally when they are required consequences of source writes.
- Job handlers must be idempotent because they may run more than once.
- Job handlers must re-check authorization or membership before externally visible effects.

### Push Notification Abstraction

Push should be a framework side effect with platform adapters.

Concepts:

- `PushDeviceRegistration`: user id, device id, platform, token, environment, and last-seen time.
- `NotificationIntent`: semantic event such as `message.new`, `call.ringing`, or `job.completed`.
- `NotificationPolicy`: app hook that decides whether a principal/user should receive an intent.
- `PushAdapter`: APNs, FCM, Web Push, or test sink.
- `PushReceipt`: delivery attempt result.

Requirements:

- Notification payloads are privacy-safe by default.
- Push fanout re-checks membership/authorization.
- Tokens can be revoked.
- Push failures are logged and observable without failing the original app action.

### Implementation Instructions

First implementation pass:

- Expand `apps/server/src/storage/job-store.ts` to support claim, retry, dead-letter, and status queries.
- Add `apps/server/src/jobs/queue.ts` and `apps/server/src/jobs/worker.ts` with deterministic test controls.
- Add a test job handler and integration tests for enqueue, claim, retry, complete, and dead-letter.
- Define push registration and notification intent types, but use a test push adapter first.
- Add server endpoints for push registration only after session/device identity is stable.
- Wire one framework event, such as new message append, to enqueue a notification intent in development/test mode.
- Keep APNs/FCM/Web Push concrete adapters out of the first pass unless credentials and deployment needs exist.

## 10. Files, Blob Pipeline, And Lifecycle

Blob storage should become a pipeline, not just raw byte storage.

### Blob Capabilities

Frick should support:

- Metadata creation.
- Direct content upload.
- Resumable upload sessions.
- Content hashing.
- MIME type validation.
- Byte size limits.
- Owner/tenant authorization.
- Content read/download.
- Local file storage adapter.
- Future object storage adapter.
- Thumbnail or derivative creation.
- Metadata extraction.
- Moderation or antivirus hooks.
- Lifecycle cleanup for orphaned blobs.

### Blob Processing Model

Blob processors are extension hooks:

- `validateMetadata`
- `validateContent`
- `extractMetadata`
- `generateDerivatives`
- `moderateContent`
- `onBlobDeleted`

Processors run as jobs when they are slow or side-effectful.

### Implementation Instructions

First implementation pass:

- Split blob metadata storage from blob content storage with a `BlobContentStore` interface.
- Add config for local blob storage path and max blob bytes.
- Add size and MIME validation before accepting content.
- Add tests for owner mismatch, too-large uploads, unsupported MIME types, content hash mismatch, and successful readback.
- Add a no-op processor registry so apps can register validation and derivative hooks without changing core blob code.
- Add a cleanup command or job for metadata without content and content without metadata.
- Defer resumable upload sessions until direct upload limits and content adapters are stable.

## 11. Conflict Resolution, Sync Limits, And Backpressure

Offline clients and realtime sync need explicit conflict and pressure behavior.

### Conflict Resolution

Primitive-level policy:

- Streams are ordered by the authoritative server sequence.
- Stream appends use idempotency keys to prevent duplicate events.
- Object writes must declare a version or precondition when direct mutation is supported.
- Presence is last-write-wins within TTL bounds.
- Signals are best-effort and expire quickly.
- Blob writes are content-addressed or idempotent by blob id.
- Projection conflicts are resolved by rebuild from source data.

Client behavior:

- Optimistic stream appends can render pending state.
- Rejected appends transition to a typed failed state.
- Failed pending appends remain inspectable until app code clears or retries them.
- Clients expose enough error metadata for app-level conflict UI.

Schema support:

- Object types can declare merge policy: server-only, last-write-wins, version-precondition, or app-resolved.
- Stream event types can declare idempotency scope.
- The first implementation should keep direct object mutation conservative and focus on stream append conflicts.

### Limits And Backpressure

Frick must define limits before production:

- Max HTTP body bytes.
- Max WebSocket frame bytes.
- Max stream append payload bytes.
- Max blob bytes per upload.
- Max active subscriptions per connection.
- Max stream page size.
- Max reconnect rate.
- Heartbeat interval and timeout.
- Presence TTL min/max.
- Signal TTL min/max.
- Pending append queue max per client.
- Job retry max and queue claim batch size.

When limits are exceeded, the server returns typed retryable or non-retryable errors. Clients must surface those errors instead of reconnecting forever.

### Implementation Instructions

First implementation pass:

- Add a central limits config object in server config.
- Validate request body size and WebSocket frame size before decoding large payloads.
- Enforce subscription count, stream page size, presence TTL, signal TTL, and append payload size.
- Add client-side pending append queue limits in TypeScript first, then mirror in Swift and Kotlin.
- Add tests for each enforced server limit with shared error codes.
- Add reconnect backoff tests so repeated protocol failures do not create tight reconnect loops.
- Document default limits and how production deployments should tune them.

## 12. Platform Lifecycle And Offline Policy

Cross-platform scale depends on predictable lifecycle behavior.

### Lifecycle Scenarios

The client contract must define behavior for:

- App foreground.
- App background.
- Network loss.
- Network regain.
- Device sleep/wake.
- Process death and relaunch.
- Token expiry while offline.
- Token expiry while connected.
- Schema mismatch after app update.
- Server migration while client is offline.
- Manual sign out.

### Platform Expectations

Web:

- Disconnect when explicitly requested.
- Reconnect while the page is active.
- Pause noisy diagnostics when the document is hidden if needed.
- Persist session only through app-provided storage.

iOS:

- Make foreground connect explicit.
- Treat background sync as app-owned unless a future background mode is added.
- Persist pending appends safely before suspension.
- Surface token expiry and migration errors on next foreground sync.

Android:

- Make lifecycle owner guidance explicit.
- Treat foreground service/background work as app-owned unless a future adapter is added.
- Persist pending appends safely before process death.
- Surface token expiry and migration errors on next active sync.

### Implementation Instructions

First implementation pass:

- Add a lifecycle contract doc for web, Swift, and Android clients.
- Add explicit `connect`, `disconnect`, `setSession`, and `clearSession` behavior tests in TypeScript.
- Add native tests for session persistence and pending append persistence across client re-creation.
- Add sync status fields for `lastConnectedAt`, `lastSyncAt`, `lastError`, and `schemaCompatibility`.
- Add app demo code only when needed to prove lifecycle behavior; keep lifecycle policy in SDK docs and tests.

## 13. Cross-Platform Fixture Suite

Frick needs canonical fixtures so TypeScript, Swift, and Kotlin agree about schema metadata, frames, codecs, and errors.

### Fixture Types

Required fixtures:

- Schema metadata fixture.
- Object record fixture.
- Stream event fixture.
- Presence record fixture.
- Signal envelope fixture.
- Blob metadata fixture.
- Job payload fixture.
- Error envelope fixture.
- WebSocket frame fixture.
- Incompatible schema fixture.
- Unknown optional field fixture.
- Rejected breaking-change fixture.

Fixtures should include both JSON and encoded binary/messagepack forms where the protocol uses binary frames.

### Implementation Instructions

First implementation pass:

- Create `packages/protocol/fixtures/`.
- Add a fixture generator script that derives fixtures from the canonical schema.
- Add TypeScript tests that decode every fixture.
- Add Swift tests that decode fixture files from the package test bundle.
- Add Android tests that decode fixture files from test resources.
- Require fixture updates in the schema authoring workflow whenever schema metadata or wire formats change.

## 14. Client Runtime Contracts

Client runtimes need consistent behavior before API polish.

### Shared Runtime Semantics

All clients should agree on:

- Session setting/clearing behavior.
- Schema compatibility failure behavior.
- Connect, disconnect, reconnect, and manual disconnect semantics.
- Subscription lifecycle and initial snapshot behavior.
- Offline append queueing and replay.
- Idempotency key behavior.
- Cursor tracking.
- Presence TTL behavior.
- Signal delivery expectations.
- Blob upload/download API shape.

### TypeScript Core And React

TypeScript core owns platform-independent runtime behavior. React owns React integration only.

Requirements:

- Core APIs should be usable without React.
- React hooks should not hide unrecoverable framework errors.
- Endpoint resolution and authorized fetch helpers should be public only if apps are expected to use them.
- Demo-specific chat helpers should live in demo code or a clearly named example package.

### Swift SDK

Swift APIs should be idiomatic:

- Async/await for network operations.
- Observable or stream-friendly state surfaces for sync status and subscriptions.
- Typed generated DTOs.
- Typed framework errors.
- SQLite cache migration metadata.
- Explicit session persistence strategy.

### Android SDK

Kotlin APIs should be idiomatic:

- Coroutines and Flow for async state.
- Typed generated DTOs.
- Typed framework errors.
- SQLite cache migration metadata.
- Explicit session persistence strategy.
- Clear Android lifecycle guidance for connect/disconnect.

### Public API Review

Each package/module needs an API boundary audit:

- Public: documented, semver-protected exports.
- Internal: not exported or explicitly marked internal.
- Demo: app-local only.
- Generated: produced by schema/design generators and not hand-edited.

### Implementation Instructions

First implementation pass:

- Add a client contract document that describes shared runtime behavior before changing SDK APIs.
- Add TypeScript tests for `connect`, `disconnect`, reconnect, session set/clear, pending append count, and typed error propagation.
- Mirror schema compatibility and error envelope types into Swift and Kotlin generated or handwritten SDK code.
- Add Swift tests for session persistence, cache metadata, pending append replay, and typed failure decoding.
- Add Android tests for session persistence, cache metadata, pending append replay, and typed failure decoding.
- Move any demo-only helpers out of reusable packages or mark them clearly as demo APIs.
- Update package exports so apps import stable public APIs through package entry points rather than deep internal paths.

## 15. Cross-Platform Design System Boundary

The design system should remain part of the framework only where it provides reusable primitives.

Framework design owns:

- Tokens.
- Theme/environment providers.
- Primitive components such as buttons, fields, badges, text, stacks, avatar/presence indicators.
- Semantic data components used across many app types.
- Workspace shell/navigation primitives.
- Generated token artifacts for web, Swift, and Kotlin.

Demo design owns:

- Product composition.
- Chat-specific visual polish unless promoted intentionally.
- Placeholder destinations and demo-only layout copy.

Design packages must not depend on app demo state, auth flows, or server assumptions.

### Implementation Instructions

First implementation pass:

- Audit `packages/design`, `packages/design-web`, `packages/design-swift`, and `apps/android/design` for demo-coupled components.
- Keep tokens, primitives, workspace shell, and broadly reusable data display components as framework API.
- Move chat-demo-only composition into `apps/web`, `apps/ios`, and `apps/android/app` unless it is intentionally promoted as a reusable communication primitive.
- Ensure generated token artifacts remain generated-only and are not hand-edited.
- Add tests around public design component exports and workspace shell semantics.
- Keep platform rendering idiomatic instead of forcing identical layouts across web, SwiftUI, and Compose.

## 16. Integration And E2E Test Matrix

Frick needs tests that prove the framework works as a system, not only as packages.

### Server Integration

Required coverage:

- Auth signup/login/dev-login behavior.
- Session expiration and unauthorized access.
- Object read authorization.
- Stream read/append authorization.
- WebSocket auth, subscribe, append ack/nack, reconnect, and cursor behavior.
- Capability negotiation accept/reject behavior.
- SSE fallback where supported.
- Blob metadata and content authorization.
- Blob validation and configured limits.
- Job enqueue, claim, retry, complete, and dead-letter behavior.
- Inbox/projection updates.
- Projection rebuild behavior.
- Migration boot behavior.
- Error envelope shape for HTTP and WebSocket failures.
- Server limits and backpressure errors.

### Protocol And Artifact Compatibility

Required coverage:

- Schema metadata is generated into TypeScript, Swift, Kotlin, and design artifacts where relevant.
- Swift/Kotlin generated DTOs match protocol fixtures.
- TypeScript, Swift, and Kotlin decode the same object, stream, presence, signal, blob, job, error, and frame fixtures.
- Old fixture decoding behavior is explicitly accepted or rejected according to compatibility rules.
- Schema mismatch errors are typed and deterministic.

### Web

Required coverage:

- Core runtime offline append replay.
- React provider/hooks with authenticated session.
- Capability negotiation defaults.
- Typed framework errors.
- Web app smoke flow against local server: login, list conversations, create conversation, append message, observe realtime update.
- Workspace shell remains accessible and responsive.

### Swift

Required coverage:

- Package tests for generated DTOs, event parsing, local SQLite cache, session persistence, and migration metadata.
- Package tests for fixture decoding and typed error decoding.
- iOS build test for the demo harness.
- Simulator smoke flow when practical: login, list/create conversation, append message.

### Android

Required coverage:

- Unit tests for generated DTOs, event parsing, local SQLite cache, session persistence, and migration metadata.
- Unit tests for fixture decoding and typed error decoding.
- Android design tests.
- Android build/lint with warnings as errors.
- Emulator smoke flow when practical: login, list/create conversation, append message.

### System Test Harness

A system test harness should orchestrate:

- Start server on an ephemeral port.
- Start web app or runtime tests against that server.
- Run protocol fixture checks.
- Run native package tests.
- Run migration status checks.
- Verify capability negotiation and error envelopes.
- Optionally launch simulator/emulator smoke tests.

This harness should be a validation tool, not the first abstraction shipped to users.

### Implementation Instructions

First implementation pass:

- Keep package tests fast and deterministic.
- Add integration tests beside the server while server APIs are still evolving.
- Add protocol fixtures before widening native compatibility behavior.
- Add smoke scripts only after the lower-level tests can identify failures clearly.
- Make native simulator/emulator tests optional until local and CI environments can run them reliably.
- Document the canonical verification command list for each slice.

## 17. Release, Distribution, And Compatibility Support

Frick needs a support policy and distribution model before it can be treated as a reusable framework by other projects.

### Package Distribution

Distribution targets:

- npm packages for TypeScript protocol, core runtime, React bindings, design packages, and server packages when split.
- Swift Package Manager tags for Swift SDK and Swift design package.
- Maven-style Android artifacts for Kotlin/Android SDK and Android design package.
- Generated artifact bundles for protocol fixtures and native DTO verification.
- Optional source-only development mode for monorepo consumers.

Requirements:

- Package entry points expose only documented public APIs.
- Generated artifacts are reproducible from the canonical schema.
- Release builds fail if generated files are stale.
- Package manifests declare peer/runtime dependencies deliberately.
- Native packages include minimum platform versions.
- Package names and module names are stable before the first real release.
- Release notes list breaking changes, migration requirements, and minimum supported client/server revisions.

### Versioning Policy

Versioning must distinguish:

- Framework package version.
- Schema version and revision.
- Protocol/wire compatibility revision.
- Generated artifact revision.
- Server storage migration revision.
- Client cache migration revision.

Support policy:

- Each server release declares the oldest supported client schema revision.
- Each client release declares the oldest supported server schema revision.
- Forced-upgrade behavior is explicit and uses typed `schema.incompatible` or `schema.migrationRequired` errors.
- Deprecation windows are documented before removing public APIs.
- Experimental APIs are explicitly named and excluded from semver guarantees.

### Provenance And Signing

Initial requirements:

- Release artifacts include checksums.
- Generated artifacts include source schema hash and generator version.
- CI records the exact commands used to generate artifacts.
- Published package versions correspond to git tags.

Future requirements can include package signing, SLSA provenance, notarized native artifacts, and SBOM generation once distribution is real.

### Implementation Instructions

First implementation pass:

- Add a release policy document that names every package, current public entry point, version source, and generated artifact.
- Add stale-generated-artifact checks to the verification command list.
- Add schema/protocol/package version metadata to generated TypeScript, Swift, and Kotlin outputs.
- Add package manifest audits for `exports`, peer dependencies, and minimum supported platform versions.
- Add a changelog template that requires migration notes, compatibility notes, and verification commands.
- Do not publish packages until public/internal boundaries and generated artifact checks are stable.

## 18. CI, Build Matrix, And Artifact Verification

Frick needs one canonical verification matrix that proves all platforms still agree.

### Build Matrix

Required jobs:

- Install and lockfile validation.
- Schema generation.
- Design token generation.
- TypeScript typecheck.
- TypeScript package tests.
- Server integration tests.
- Web app build and smoke test.
- Swift package tests.
- iOS project generation and simulator build.
- Android SDK tests.
- Android design tests.
- Android app lint/build with warnings as errors.
- Protocol fixture verification across TypeScript, Swift, and Kotlin.
- Generated artifact drift check.
- Documentation link/lint check where practical.

### CI Principles

- Fast package tests should run first.
- Native builds can run after protocol and TypeScript checks pass.
- Simulator/emulator smoke tests can be optional or nightly until reliable.
- Every CI job should print the exact command developers can run locally.
- CI should upload useful failure artifacts: test logs, server logs, screenshots, protocol fixtures, and generated diffs.
- CI should never require secrets for normal pull request verification.

### Implementation Instructions

First implementation pass:

- Create a documented `pnpm verify` or equivalent script that runs the stable local subset.
- Add scripts for `verify:schema`, `verify:types`, `verify:test`, `verify:swift`, `verify:android`, and `verify:fixtures`.
- Add generated artifact drift checks that fail when `pnpm schema:generate` or `pnpm design:generate` changes tracked files.
- Add CI workflow documentation even before remote CI config is added.
- Once CI config exists, keep workflow names aligned with local script names.

## 19. Backup, Restore, Privacy, And Data Lifecycle

Frick stores durable app data, so it needs explicit backup, restore, and privacy lifecycle contracts.

### Backup And Restore

Requirements:

- Document SQLite backup strategy for local/small deployments.
- Document blob backup strategy and how blob metadata remains consistent with blob content.
- Define restore order: database first, blob content second, derived projections rebuilt after restore.
- Provide a restore verification command that checks schema revision, migrations, blob metadata/content consistency, and projection rebuildability.
- Treat backup encryption and key management as deployment responsibilities, but document the requirement.
- Define migration rollback posture: rollback is restore-from-backup unless a specific migration includes an explicit down path.

### Disaster Recovery

Operational docs should define:

- Recovery point objective assumptions.
- Recovery time objective assumptions.
- What must be backed up.
- What can be rebuilt.
- How to recover from failed migrations.
- How to recover from partial blob writes.
- How to recover from corrupted local client cache.

### Data Privacy Lifecycle

Framework primitives:

- User/account export hooks.
- Account deletion hooks.
- Object/blob retention policy hooks.
- PII classification metadata for framework-owned fields.
- Audit events for auth, data export, deletion, and admin/service access.
- Privacy-safe logging rules.

Requirements:

- Framework logs never include message bodies, raw blob bytes, session tokens, password material, or push tokens by default.
- Deletion policy distinguishes hard delete, soft delete, redaction, and tombstone.
- Streams must define how redaction works without rewriting historical ordering.
- Blob deletion must remove or tombstone metadata and schedule content cleanup.
- Data export operates through authorized queries and respects tenant boundaries.

### Implementation Instructions

First implementation pass:

- Add a backup/restore operations doc with concrete SQLite and local blob store commands.
- Add an inspection or doctor check for blob metadata/content consistency.
- Add privacy classification fields to framework-owned schema metadata where useful.
- Add audit event types for login, logout, token revocation, export request, deletion request, and service-principal access.
- Add tests that confirm logs and errors do not expose session tokens or password hashes.
- Keep legal/product workflows out of framework code; provide hooks and docs for apps to implement them.

## 20. Performance, Load, And Benchmarking

Frick needs repeatable performance signals before scaling claims mean anything.

### Benchmark Targets

Measure:

- HTTP request latency for object reads, stream reads, appends, auth, blob metadata, and blob content.
- WebSocket handshake and subscribe latency.
- Append persistence latency.
- Realtime fanout latency.
- Catch-up sync time from empty cache.
- Reconnect time after network loss.
- Server memory growth with many subscriptions.
- SQLite database size growth with objects, stream events, jobs, blobs, and projections.
- Client cache size growth.
- TypeScript encode/decode throughput.
- Swift encode/decode throughput.
- Kotlin encode/decode throughput.
- Projection rebuild time.
- Job throughput and retry overhead.

### Load Harness

The load harness should support:

- Deterministic synthetic data generation.
- Configurable users, devices, conversations, subscriptions, append rate, blob size, and reconnect rate.
- Local SQLite mode first.
- JSON output for trend comparison.
- Clear separation from correctness tests.

### Performance Budgets

Each release should document current baseline numbers and target budgets. Early budgets can be generous, but they should be explicit enough to catch regressions.

Initial example budgets:

- WebSocket handshake under 250 ms locally.
- Stream append round trip under 150 ms locally for small payloads.
- Catch-up of 1,000 stream events under 2 seconds locally.
- Protocol fixture decode tests complete under package test time budgets.

These are starting points, not permanent promises.

### Implementation Instructions

First implementation pass:

- Add benchmark scripts under a dedicated path such as `benchmarks/` or `scripts/bench/`.
- Keep benchmarks out of normal unit test runs.
- Add one server append/catch-up benchmark and one protocol codec benchmark first.
- Store benchmark output as JSON with scenario name, git sha when available, machine notes, and command.
- Document how to run benchmarks locally and how to interpret noisy results.

## 21. Developer Diagnostics And DevTools

Frick should be easy to debug before it is easy to scaffold.

### Diagnostics Surfaces

Framework diagnostics should expose:

- Current schema metadata and compatibility status.
- Active subscriptions.
- Known stream cursors.
- Pending appends and their states.
- Last ack/nack per request id.
- Recent error envelopes.
- WebSocket connection state and reconnect attempts.
- Local cache metadata and size.
- Last successful sync time.
- Negotiated capabilities.
- Server limits.

### DevTools Shape

Initial delivery can be non-visual:

- `frick doctor`
- `frick inspect server`
- `frick inspect client-cache`
- `frick inspect fixtures`
- Verbose sync diagnostics in SDKs.
- Development-only inspection endpoints.

A browser/native visual devtools panel should wait until the diagnostics data model is stable.

### Implementation Instructions

First implementation pass:

- Add a shared diagnostics snapshot type in TypeScript core.
- Add server diagnostics snapshot output under inspection endpoints.
- Add client diagnostics snapshot output for TypeScript first.
- Add tests that diagnostics redact secrets.
- Add documentation showing how to debug schema mismatch, auth failure, stuck pending append, and reconnect loops.

## 22. Security Operations And Service Principals

Frick needs operational security practices in addition to app-level auth.

### Security Operations

Requirements:

- Dependency vulnerability scanning policy.
- Secret redaction tests.
- CORS configuration tests.
- TLS/proxy deployment guidance.
- Secure headers guidance for HTTP deployments.
- Payload fuzzing for protocol/frame decoding.
- Rate-limit and abuse-event logging.
- Audit events for privileged operations.
- No secrets in generated artifacts, logs, fixtures, screenshots, or CI output.

### Service Principals

Framework operations need machine identities distinct from users.

Use cases:

- Migration tooling.
- Job workers.
- Inspection endpoints.
- Backup/restore checks.
- Search index rebuilds.
- Projection rebuilds.
- Internal maintenance commands.

Requirements:

- `Principal` supports `kind: "user" | "service"`.
- Service principals have explicit scopes.
- Service tokens are never accepted for normal user impersonation unless a specific audited operation permits it.
- All service-principal access creates audit events.
- CLI and worker code should use service principals instead of bypassing authz entirely.

### Implementation Instructions

First implementation pass:

- Add service-principal types and scope checks to the auth/policy model.
- Add tests that service principals can run permitted maintenance actions and cannot read arbitrary user data without scope.
- Add CORS and redaction tests.
- Add a protocol decoder fuzz test with bounded generated inputs.
- Add security operations docs covering secrets, TLS/proxy expectations, CORS, and dependency scanning.

## 23. Accessibility, Localization, And Documentation Architecture

Cross-platform framework quality includes accessibility, localization, and docs people can actually navigate.

### Accessibility Contract

Design and app shell components should define:

- Accessible names for icon-only buttons.
- Keyboard navigation expectations on web.
- Focus management for modals, drawers, inspectors, and navigation shells.
- Dynamic type/text scaling expectations on iOS and Android.
- Color contrast requirements for design tokens.
- Reduced motion behavior for animated components.
- Screen reader labels for presence, unread counts, loading states, and error states.

Accessibility tests should start with web component semantics and expand to native where practical.

### Localization Contract

Framework packages should avoid hardcoded user-facing English where reusable components need labels.

Requirements:

- Reusable components accept labels or localization hooks for visible strings and accessibility strings.
- Error codes are stable and separate from localized messages.
- Dates/times/numbers are formatted by app code or platform localization utilities.
- Demo copy can remain in demo apps.
- Generated DTOs and protocol fields remain language-neutral.

### Documentation Architecture

Docs should be organized around how people adopt and operate the framework:

- Concepts: primitives, schema, sync, storage, auth, extensions.
- Getting around the repo: package map and public/internal boundaries.
- Schema authoring and generated artifacts.
- Server operations.
- Migrations.
- Client SDK guides for TypeScript, React, Swift, and Android.
- Design system guide.
- Extension authoring.
- Security and privacy.
- Backup/restore.
- Diagnostics and troubleshooting.
- Testing and CI.
- Release and compatibility policy.

### Implementation Instructions

First implementation pass:

- Add a docs index that links existing specs, plans, package docs, and operations docs.
- Add accessibility requirements to design-system tests and component docs.
- Add localization guidelines for reusable components and error messages.
- Ensure public docs distinguish framework code, app code, demo code, generated code, and operational tooling.
- Add a docs lint/check command only after the docs structure has settled.

## 24. Secure Defaults And Guardrails

Frick should make the secure path the easiest path. Unsafe choices should require explicit development-mode opt-ins and should fail loudly in production.

### Runtime Presets

Framework runtime presets:

- `development`: permissive local defaults, demo auth allowed, inspection endpoints enabled, destructive reset allowed, verbose diagnostics allowed.
- `test`: deterministic defaults, in-memory or isolated stores, short TTLs, fake adapters, stable seed data, no external secrets.
- `staging`: production-like defaults, restrictive CORS, demo auth disabled, inspection protected, real migration behavior, safe diagnostics.
- `production`: restrictive CORS, demo auth disabled, destructive reset disabled, protected inspection, secure logging, explicit limits, required secrets.

Preset requirements:

- Every preset has documented defaults.
- Production mode refuses to boot with unsafe defaults.
- Development-only APIs include a development guard in code and tests.
- Tests prove production rejects demo auth, wildcard origins, missing session secrets, exposed inspection endpoints, and destructive reset flags.

### Config Validation With Fix Suggestions

Configuration validation should return actionable errors:

- Missing `FRICK_ALLOWED_ORIGINS` in production explains why it matters and shows an example.
- `FRICK_DEMO_AUTH_ENABLED=true` in production explains how to disable it.
- Missing blob path or database path in production explains required storage config.
- Token TTL outside accepted bounds explains the allowed range.
- Inspection endpoints exposed without auth explain the risk and required setting.

Validation errors should be structured so CLI and server startup can render them consistently.

### Credential And Secret Provider Boundary

The first implementation can read secrets from environment variables, but the framework should define a provider boundary.

Secret use cases:

- Session token signing or token encryption if added.
- Password hashing pepper if configured.
- Service-principal tokens.
- Webhook signing secrets.
- Push provider credentials.
- Blob/object storage credentials.
- External auth provider secrets.

Requirements:

- Secret values never enter logs, diagnostics, fixtures, generated artifacts, or error envelopes.
- Secret provider APIs return opaque values or scoped accessors where practical.
- Tests include representative redaction cases.
- Future providers such as local files, macOS Keychain, cloud KMS, Vault, or platform secret stores can plug in without rewriting server code.

### Field-Level Sensitivity Metadata

Schema fields and framework payloads should support sensitivity metadata:

- `public`: safe for normal app reads and logs when otherwise authorized.
- `private`: authorized app reads only, never broad inspection.
- `pii`: personal data that participates in export/deletion/privacy workflows.
- `secret`: credentials or tokens; never logged, exported casually, or shown in diagnostics.
- `content`: user-generated message/file content; privacy-safe logs must avoid raw values.

This metadata should inform logs, diagnostics, audit events, data export, deletion, admin inspection, and fixture generation.

### Abuse Controls

Framework guardrails should cover:

- Login throttles.
- Signup throttles.
- Token refresh throttles.
- Append rate limits.
- Blob upload quotas.
- Device/session quotas.
- Active subscription quotas.
- Signal send quotas.
- Job enqueue quotas.
- Per-tenant quotas where tenant support is enabled.

Every exceeded quota should produce a shared `rateLimit.exceeded` or more specific typed error with retry guidance when safe.

### CSRF, Cookies, And Browser Security

Bearer tokens can remain the initial auth mode, but Frick should document and guard cookie-based auth if apps add it.

Requirements for cookie auth support:

- SameSite guidance.
- Secure/HttpOnly cookie requirements.
- CSRF token or double-submit strategy.
- Origin and referer checks where applicable.
- Clear separation from bearer-token WebSocket auth.

Cookie auth should not be enabled implicitly.

### Signed Webhooks And Event Delivery

If apps emit outbound webhooks, Frick should own the safe delivery pattern:

- Signature headers.
- Timestamped payloads.
- Replay protection.
- Retry with backoff.
- Dead-letter behavior.
- Delivery audit events.
- Secret rotation path.

Concrete webhook delivery can wait, but the job/side-effect model should leave room for it.

### Implementation Instructions

First implementation pass:

- Add a config validation module that returns typed validation errors with fix suggestions.
- Add runtime preset tests for development, test, staging, and production.
- Add explicit production boot rejection tests for demo auth, wildcard origins, missing database/blob paths, destructive reset, and exposed inspection endpoints.
- Add sensitivity metadata types to the protocol/schema model before using them broadly.
- Add redaction tests for `secret`, `pii`, and `content` fields in logs, diagnostics, and error details.
- Add rate-limit/abuse-control interfaces without requiring a distributed limiter in the first pass.
- Add cookie-auth and webhook security posture to security docs, keeping implementation disabled until needed.

## 25. App Authoring Model

Frick should make app-specific framework usage explicit, testable, and discoverable without hiding it behind a starter template.

### Application Manifest

Apps should have one typed registration surface, such as `frick.app.ts`, once the server extension model is stable.

Manifest responsibilities:

- App metadata: name, id, version, supported schema modules.
- Schema modules.
- Auth providers or auth provider hooks.
- Authorization policy hooks.
- Projections.
- Jobs and workers.
- Blob processors.
- Search indexes.
- Notification intents.
- Push adapters or push adapter factories.
- Limits and runtime preset overrides.
- Seed data and fixtures.
- Observability hooks.
- Documentation metadata for generated docs.

Rules:

- The manifest is explicit code, not magical file discovery at first.
- The manifest should be validatable without starting the full server.
- Tests can load a manifest with fake adapters.
- Production startup logs manifest id/version without secrets.

### Typed Operation Helpers

Generated helpers should reduce app boilerplate while preserving protocol transparency.

Examples:

- `client.objects.User.get(id)`
- `client.objects.Conversation.list()`
- `client.streams.MessageStream.page(conversationId, cursor)`
- `client.streams.MessageStream.append.MessageSent(conversationId, payload)`
- `client.projections.Inbox.list(userId)`
- `server.policy.can(principal, action, resource)`

Requirements:

- Helpers are generated from schema metadata.
- Raw protocol APIs remain available for framework-level tests and advanced use.
- Helpers preserve typed errors and request ids.
- Helpers expose idempotency key behavior instead of hiding it.
- Native helpers should feel idiomatic in Swift and Kotlin, not copied TypeScript shapes.

### Policy Test Harness

Authorization should be easy to test.

Test harness capabilities:

- Build principals: user, service, anonymous, tenant-scoped.
- Build resources: object, stream, blob, signal, projection, job.
- Assert allow/deny decisions with reason codes.
- Install fake app policy hooks.
- Seed membership/relationship graph.
- Snapshot policy decisions for regression tests.

### Local Fake Server And Test Runtime

App tests need a low-friction runtime:

- In-process test server for Node/TypeScript tests.
- Fake storage adapters.
- Fake auth provider.
- Fake push adapter.
- Fake blob content store.
- Fake search adapter.
- Deterministic job worker.
- Deterministic clock/id generator.

This should support app integration tests without manually starting the full dev server.

### Seed And Fixture System

Frick should support app-owned seed data:

- Users/accounts.
- Devices/sessions.
- Objects.
- Stream events.
- Blob metadata/content references.
- Jobs.
- Projection rebuild expectations.
- Authorization relationships.

Commands:

- `frick seed apply`
- `frick seed reset --dev`
- `frick fixtures verify`
- `frick fixtures generate`

Seeds must be development/test tools and must not bypass production safeguards.

### Mock Adapters

Framework packages should provide test adapters for:

- Auth provider.
- Blob content store.
- Push adapter.
- Search adapter.
- Job handler.
- Metrics/log sink.
- Secret provider.
- Clock/id generation.

Mocks should live in test-support entry points so production apps do not accidentally depend on them.

### Error-To-UX Guidance

Framework errors should map to app behavior:

- `auth.unauthenticated`: show sign-in flow.
- `auth.sessionExpired`: refresh or sign in again.
- `auth.forbidden`: hide or explain denied action.
- `schema.incompatible`: require app update or server update.
- `schema.migrationRequired`: run migration, clear dev cache, or stop sync.
- `rateLimit.exceeded`: show retry timing when safe.
- `blob.tooLarge`: show configured file limit.
- `sync.reconnectExhausted`: show offline/retry state.
- `server.internal`: show support path with request id.

This guidance belongs in docs and SDK examples, not hardcoded product UI.

### Implementation Instructions

First implementation pass:

- Define app manifest types after the extension registry exists.
- Add a manifest validation function with typed errors.
- Add a small example manifest under docs or test fixtures, not a full starter template.
- Add generated helper design to the schema/codegen plan before implementing broad helper APIs.
- Add a policy test harness package or server test helper module.
- Add a test runtime helper that starts an in-process server with fake adapters and deterministic IDs.
- Add seed/fixture commands only after migration and fixture systems exist.
- Keep mock adapters under explicit test-support paths.
- Add error-to-UX guidance to SDK docs.

## 26. Developer Experience Tooling

Frick should help developers understand, upgrade, and reproduce behavior without teaching them internal implementation details first.

### Interactive Doctor Output

Doctor commands should explain:

- What was checked.
- Whether it passed.
- Why the check matters.
- How to fix failures.
- Which docs link explains the issue.
- Whether the issue is blocking production, blocking local development, or informational.

Doctor categories:

- `frick doctor config`
- `frick doctor security`
- `frick doctor schema`
- `frick doctor migrations`
- `frick doctor artifacts`
- `frick doctor storage`
- `frick doctor clients`

Machine-readable JSON remains the base format; human-friendly output can be rendered from the same data.

### Trace Capture And Replay

Frick should be able to capture a safe sync trace:

- Handshake metadata without secrets.
- Negotiated capabilities.
- Subscriptions.
- Request ids.
- Ack/nack envelopes.
- Error envelopes.
- Cursor changes.
- Pending append transitions.
- Timing metadata.

Trace rules:

- Redact sensitive field values.
- Never include raw session tokens, passwords, push tokens, raw blob bytes, or message content unless an explicit development-only flag allows content capture.
- Replays run against a test runtime.
- Replays can become regression tests.

### Schema Diff And Upgrade Assistant

Commands:

- `frick schema diff`
- `frick schema check`
- `frick upgrade check`

Schema diff should classify changes:

- Compatible.
- Migration required.
- Generated artifact update required.
- Breaking.
- Unsupported or unknown.

Upgrade check should inspect:

- Package versions.
- Schema metadata.
- Generated artifact versions.
- Migration status.
- Client/server compatibility windows.
- Deprecated APIs.
- Required manual steps from release notes.

### Policy Explorer

A non-visual policy explorer should answer:

- Which principal was checked?
- Which action was requested?
- Which resource was targeted?
- Which relationships were considered?
- Which policy hook allowed or denied?
- What reason code was returned?

It should never expose unrelated private data while explaining authorization decisions.

### Focused Module Examples

Examples should be small and surgical, not starter apps:

- Add a custom object.
- Add a stream event.
- Add a projection.
- Add an authorization policy.
- Add a blob processor.
- Add a job handler.
- Add a notification intent.
- Add a search index adapter.
- Add a custom auth provider.
- Add a seed fixture.
- Add a migration.

Each example should include test expectations and the smallest relevant file set.

### Golden-Path Tutorials

Tutorials should cover common app-building tasks:

- Add a new schema type.
- Add a new stream event.
- Add a projection and query it.
- Add an authz rule and test it.
- Add a blob upload flow.
- Add a background job.
- Add a push notification intent.
- Handle framework errors in UI.
- Upgrade schema safely.
- Debug sync with diagnostics and traces.

### Implementation Instructions

First implementation pass:

- Extend doctor output to include severity, explanation, fix suggestion, and docs link.
- Add trace snapshot types that reuse diagnostics, error envelopes, and sensitivity redaction.
- Add `schema diff` classification to the schema compatibility module before building a CLI command around it.
- Add `upgrade check` as a read-only command after package/schema/artifact metadata exists.
- Add policy explorer output to the policy test harness before adding a public CLI.
- Add focused examples as docs tied to tests or fixtures so they cannot silently drift.
- Keep full starter templates out of this phase.

## 27. Data Modeling Ergonomics

Frick should make good schema design easy and risky schema design visible before it ships.

### Schema Lint Rules

The schema toolchain should lint:

- Type naming consistency.
- Field naming consistency.
- Stable field id uniqueness.
- Suspicious field id gaps.
- Required fields added without migrations.
- Unbounded strings or bytes.
- Missing indexes for declared query/projection access patterns.
- Missing sensitivity metadata on likely PII/content fields.
- Enum values without evolution notes.
- Object references without deletion behavior.
- Stream events without idempotency scope.
- Blob references without ownership or lifecycle policy.
- Tenant-scoped types missing tenant strategy.

Lint results should have severity, explanation, fix suggestion, and docs link.

### Schema Cookbook

The docs should include common modeling patterns:

- Membership and roles.
- Ownership and creator fields.
- Soft delete, hard delete, redaction, and tombstones.
- Audit log events.
- Attachments and blob references.
- Ordered lists and stream-backed ordering.
- Unread state and receipts.
- Derived projections.
- Searchable text.
- App settings and preferences.
- Multi-tenant scoping.

### Reference And Enum Evolution

Reference semantics:

- `restrict`: prevent deletion while referenced.
- `cascade`: delete dependent records where safe.
- `tombstone`: keep historical reference with redacted target.
- `nullable`: clear reference on target removal.
- `historical`: preserve immutable display snapshot.

Enum evolution rules:

- Adding values is compatible only if older clients can ignore or treat unknown values safely.
- Removing values is breaking.
- Renaming values is breaking unless an alias/migration path exists.
- Generated clients must expose unknown enum behavior intentionally.

### Implementation Instructions

First implementation pass:

- Add schema lint result types to protocol tooling.
- Implement a small first lint set: duplicate field ids, missing schema metadata, unbounded content-like fields, required-field migration warning, and missing sensitivity metadata.
- Add `frick schema lint` or a package script that runs lint checks.
- Add lint fixtures for pass, warning, and error cases.
- Add cookbook docs for membership, soft delete/redaction, attachments, and projections first.
- Add reference semantics to schema metadata before enforcing runtime behavior broadly.

## 28. App Modules, Multi-App Servers, Feature Flags, And Promotion

Frick should support more than one app and more than one reusable app module without turning schema composition into a knot.

### App Modules

An app module packages:

- Schema module.
- Public API helpers.
- Policy hooks.
- Projections.
- Jobs.
- Blob processors.
- Search indexes.
- Notification intents.
- Seeds and fixtures.
- Module migrations.
- Module tests.
- Optional design primitives or UI examples.

Requirements:

- Modules declare dependencies.
- Cycles are rejected.
- Module ids and versions are stable.
- Module migrations are ordered after dependency migrations.
- Module compatibility is checked against framework and app schema revisions.
- Tests can load one module or a composed module graph.

### Multi-App Server Boundary

A Frick server may eventually host multiple apps.

Requirements:

- App id appears in sessions, schema negotiation, audit logs, limits, jobs, metrics, and diagnostics.
- Per-app CORS/origin policy.
- Per-app feature flags and capabilities.
- Per-app public/private schema surfaces.
- Per-app storage or tenant strategy.
- App-scoped service principals.
- App-specific inspection and support bundles.

The first implementation can remain single-app, but public server APIs should not make multi-app support impossible.

### Feature Flags And Experiments

Feature flag requirements:

- Server-controlled flags exposed through capability negotiation.
- Per-user, per-device, per-tenant, and per-app rollout.
- Kill switches for risky features.
- Migration-aware feature gates.
- Audit trail for flag changes.
- SDK access that is read-only for normal clients.
- Test fixtures for flag states.

Flags should gate behavior, not replace schema compatibility.

### Environment Promotion

Promotion workflow should cover:

- Development to staging to production checks.
- Migration dry runs.
- Generated artifact drift checks.
- Seed data rules per environment.
- Artifact promotion: the generated artifacts tested in staging are the artifacts used in production.
- Config/security doctor checks.
- Backup check before production migrations.
- Roll-forward and restore plan for migration failure.

Command shape:

- `frick deploy check`
- `frick migrate dry-run`
- `frick artifacts verify`
- `frick promote check`

### Implementation Instructions

First implementation pass:

- Add module metadata types and dependency graph validation before implementing package distribution for modules.
- Keep initial runtime single-app but add explicit app id metadata to app manifest, diagnostics, audit events, and capability negotiation.
- Add feature flag types and read-only negotiated flag delivery in the protocol model before adding rollout storage.
- Add environment promotion docs that tie together config validation, migration status, artifact drift, backup check, and security doctor output.
- Add tests for module cycle detection, app id propagation in diagnostics/audit fixtures, and feature flag negotiation shape.

## 29. Import, Export, Interop, And Local Client Data Lifecycle

Frick should have clear ways to move data in and out, and clear local cache behavior on user devices.

### Bulk Import

Bulk import should support:

- Schema-tagged import manifests.
- Validation-only dry run.
- Streaming import for large datasets.
- Idempotency keys.
- Partial failure reports.
- Relationship resolution.
- Blob metadata/content mapping.
- Projection rebuild after import.
- Audit event creation.

Imports must pass authorization or service-principal scope checks.

### Export Format

Exports should include:

- Schema id/version/revision/hash.
- Export created timestamp.
- App id and tenant id where applicable.
- Object records.
- Stream events.
- Blob metadata and content references.
- Job/projection state only when explicitly requested.
- Redaction/sensitivity handling.
- Checksums for large files.

Export format should be deterministic enough for tests and support bundles.

### Interop

Frick should define adapter points for:

- Importing from JSON/CSV where app mapping is explicit.
- Exporting framework records as JSON.
- Mapping external ids to Frick ids.
- Validating imported data without committing it.
- Recording import provenance.

### Local Client Data Lifecycle

Client caches need policy:

- Local cache compaction.
- Local cache encryption hooks.
- Per-user cache separation on shared devices.
- Logout data-clearing policy.
- Background cleanup of old stream pages.
- Background cleanup of cached blob content.
- Client disk quota behavior.
- Pending append retention and retry policy.
- Cache corruption recovery.

Requirements:

- Production clients fail safely when cache encryption is required but unavailable.
- Logout behavior is explicit: clear all local data, clear only secrets, or preserve cache for fast re-login.
- Shared-device behavior avoids cross-user data leaks.

### Implementation Instructions

First implementation pass:

- Add import/export manifest types under protocol or operations tooling.
- Add validation-only import tests using in-memory/test storage.
- Add deterministic JSON export fixtures for a small object/stream/blob graph.
- Add local cache lifecycle docs for web, Swift, and Android.
- Add per-user cache namespace metadata to native clients before adding encryption hooks.
- Add logout cache-clearing behavior tests for TypeScript, Swift, and Android.
- Add cache compaction and disk quota policy docs before implementing background cleanup.

## 30. Maintenance Workflows And Supportability

Frick should make common operational repairs explicit, auditable, and safe.

### Maintenance Workflows

Maintenance commands should support:

- Rebuild projections.
- Reindex search.
- Requeue dead-letter jobs.
- Cancel stuck jobs.
- Revoke sessions.
- Revoke devices.
- Rotate service credentials.
- Inspect tenant/app health.
- Run migration status checks.
- Run migration dry runs.
- Verify blob metadata/content consistency.
- Compact local/server storage where supported.

Requirements:

- Maintenance operations use service principals.
- Dangerous operations require explicit environment and scope.
- Every maintenance operation emits audit events.
- Dry-run mode exists where practical.
- Commands return structured output.

### Support Bundles

Support bundles should include redacted:

- Runtime config summary.
- Schema metadata.
- Capability negotiation summary.
- Recent error envelopes.
- Diagnostics snapshot.
- Migration state.
- Job queue counts.
- Blob consistency summary.
- Feature flag state.
- Relevant request ids.
- Recent audit events, where safe.

Support bundles must exclude secrets, raw user content, raw blob bytes, passwords, session tokens, push tokens, and unrelated private data.

### Support Queries

Support workflows should answer:

- What happened to this append?
- Why can this user not see this resource?
- Why is this client stale?
- Why did this job fail?
- Why did this blob upload fail?
- Which migration changed this state?
- Which feature flag affected this behavior?

These queries should build on trace, policy, job, migration, and diagnostics data rather than bespoke debug paths.

### Implementation Instructions

First implementation pass:

- Add maintenance operation types with service-principal scope requirements.
- Add dry-run output shape for projection rebuild and blob consistency checks.
- Add support bundle snapshot type and redaction tests.
- Add support query docs that map questions to existing diagnostics, traces, audit events, and request ids.
- Keep destructive repair commands disabled until authz, audit, and dry-run behavior are tested.

## 31. Compliance Evidence, Dependency Governance, And International Readiness

Frick should not claim compliance, but it can produce evidence and avoid choices that block international apps.

### Compliance Evidence Hooks

Evidence primitives:

- Audit log export.
- Access log retention metadata.
- Data processing inventory.
- Deletion report.
- Export report.
- Security config report.
- Dependency/license report.
- Migration history report.
- Service-principal access report.

Requirements:

- Evidence reports are machine-readable.
- Reports use sensitivity metadata and redaction rules.
- Reports include schema/app/framework versions.
- Reports distinguish framework facts from app-declared policy.

### Licensing And Dependency Governance

Governance should define:

- Allowed dependency licenses.
- Denied dependency licenses.
- Native dependency review expectations.
- Runtime versus dev dependency risk.
- Dependency update cadence.
- Vulnerability triage expectations.
- SBOM generation as a future release requirement.

The framework should avoid introducing dependencies that make mobile packaging, server deployment, or commercial use awkward without explicit review.

### International Production Reality

International readiness requirements:

- Time zone policy: store instants in UTC, format at the edge.
- Unicode normalization policy for handles, search, and identifiers.
- Locale-aware sorting/search strategy.
- Right-to-left layout expectations for design components.
- Region-aware data residency hooks.
- Tenant/app region metadata where data residency matters.
- Configurable retention/export/delete behavior by app or tenant.

The first implementation can document hooks and metadata without implementing regional storage routing.

### Implementation Instructions

First implementation pass:

- Add evidence report type sketches and docs for audit export, deletion report, security config report, dependency report, and migration history report.
- Add dependency license policy docs and a future SBOM requirement.
- Add time zone and Unicode normalization guidelines to schema and app-authoring docs.
- Add RTL and locale expectations to design-system docs.
- Add region/data-residency metadata as an open design point before changing storage layout.

## 32. Release Readiness Criteria

Frick is ready to be wrapped as a drop-in fullstack solution when these are true:

- Schema identity and migration policy are implemented and documented.
- Capability negotiation is implemented across server, TypeScript, Swift, and Kotlin clients.
- Extension registry boundaries exist for policy, projections, jobs, blobs, search, notification intents, and observability hooks.
- Server refuses unsafe production configuration.
- Demo auth is clearly disabled or explicitly opted into for production.
- All framework-visible errors use stable envelopes and typed SDK errors.
- Structured logs include request ids and no secrets.
- Server health/readiness endpoints reflect migration/database state.
- Inspection endpoints and maintenance commands expose safe operational state.
- Public package exports are audited and documented.
- Demo-only helpers are not required to build a real app.
- Web, Swift, and Android clients expose consistent runtime semantics.
- Projection/query behavior is explicit, rebuildable, and authorized.
- Job lifecycle behavior is durable, observable, and tested.
- Blob metadata/content behavior is adapter-backed, authorized, limited, and tested.
- Conflict behavior, sync limits, and backpressure errors are documented and enforced.
- Cross-platform fixtures prove generated artifacts and wire formats agree.
- Integration tests cover auth, sync, storage, errors, generated artifacts, projections, jobs, blobs, limits, and lifecycle behavior.
- Operational docs explain local development, production configuration, migrations, troubleshooting, inspection, and maintenance commands.
- Package distribution policy covers npm, SwiftPM, Android artifacts, generated artifact drift, changelogs, and compatibility notes.
- CI/build matrix verifies TypeScript, server, web, Swift, iOS, Android, generated artifacts, fixtures, and documentation.
- Backup/restore and disaster recovery docs cover database, blobs, projections, migration failure, and verification commands.
- Privacy lifecycle hooks and audit events exist for export, deletion, retention, redaction, and service access.
- Performance benchmarks and load harnesses produce repeatable JSON results for core sync, codec, storage, projection, and job scenarios.
- Developer diagnostics expose schema, capabilities, subscriptions, cursors, pending appends, errors, cache status, and server limits without secrets.
- Security operations cover dependency scanning policy, CORS, TLS/proxy guidance, fuzzing, secret redaction, audit events, and service principals.
- Secure runtime presets and config validation make unsafe production settings fail with actionable fix suggestions.
- Field-level sensitivity metadata drives redaction, diagnostics, export, deletion, audit, and fixture behavior.
- Abuse controls cover auth, append, blob, device/session, subscription, signal, job, and tenant-scoped quotas.
- App manifests make schema modules, policies, projections, jobs, blobs, notifications, adapters, limits, seeds, fixtures, and observability hooks explicit.
- Generated typed operation helpers exist for common object, stream, projection, and policy operations without hiding raw protocol access.
- App test tooling includes policy harnesses, fake server/runtime helpers, mock adapters, deterministic clocks/ids, seed data, and fixture verification.
- Developer tooling includes doctor categories, schema diff, upgrade checks, trace capture/replay, policy explorer output, focused examples, and golden-path tutorials.
- Schema linting and cookbook guidance catch risky modeling choices before generated artifacts or migrations ship.
- App module metadata, dependency validation, module migrations, and module tests support reusable framework/app capabilities.
- Multi-app server metadata keeps app id visible in sessions, schema negotiation, audit logs, limits, jobs, metrics, diagnostics, and feature flags.
- Feature flags and environment promotion checks support safe rollout, kill switches, migration dry runs, artifact verification, and production readiness checks.
- Import/export manifests, deterministic exports, validation-only imports, and local client cache lifecycle policies are documented and tested.
- Maintenance workflows and support bundles expose safe, redacted operational repair and debugging paths.
- Compliance evidence hooks, dependency governance, and international readiness docs exist without claiming legal compliance.
- Design/system components document accessibility and localization contracts across web, SwiftUI, and Android.
- Documentation has an information architecture that separates concepts, operations, SDK usage, extension authoring, security/privacy, diagnostics, testing, and release policy.
- The repo has a clear release checklist and versioning policy.

## 33. Implementation Sequence

The hardening work should happen in focused slices.

### Slice 1: Public/Internal Boundary Audit

Outcome: a clear map of framework APIs, internal modules, generated files, and demo-only code.

Deliverables:

- Package/module export audit.
- README update describing current package responsibilities.
- Demo helper relocation plan if needed.
- Tests ensuring packages only export intended entry points where practical.

### Slice 2: Schema Versioning And Migration Contract

Outcome: Frick can detect, accept, migrate, or reject schema/database/cache versions intentionally.

Deliverables:

- Schema metadata fields.
- Server migration table and runner.
- SQLite framework migration baseline.
- Client cache schema metadata for TypeScript, Swift, and Android.
- Compatibility tests and docs.

### Slice 3: Error Envelope And Observability Contract

Outcome: HTTP, WebSocket, and client SDK failures speak the same language.

Deliverables:

- Shared error types/codes.
- HTTP error envelope.
- WebSocket nack error envelope.
- Request id propagation.
- Structured server logging.
- Client typed errors in TypeScript, Swift, and Kotlin.

### Slice 4: Capability Negotiation And Extension Registry

Outcome: clients and server explicitly agree on supported capabilities, and apps can register behavior without editing framework internals.

Deliverables:

- Client capability model in protocol.
- Server accepted-capability response.
- Rejection behavior for unsupported required capabilities.
- Extension registry types.
- Server creation options for extensions.
- SDK default capability builders.
- Capability naming docs and tests.

### Slice 5: Auth, Security, Policy, And Tenant Boundary

Outcome: demo auth is separated from production auth posture, and all framework primitives enforce server-side authorization.

Deliverables:

- Identity/session/principal docs.
- Production mode restrictions.
- Policy action/resource/decision types.
- Optional tenant context on principals and storage APIs.
- Session expiration/revocation behavior.
- Rate-limit hook interfaces.
- Threat model.
- Expanded authz tests.

### Slice 6: Storage, Deployment, Inspection, And Operations CLI

Outcome: the server can be configured, started, checked, inspected, and shut down predictably in development, test, and production modes.

Deliverables:

- Runtime mode config.
- Required env validation.
- Readiness endpoint.
- Graceful shutdown.
- Blob storage content adapter boundary.
- Inspection endpoints.
- Maintenance script entry points for doctor, migration status, and artifact verification.
- Deployment and operations docs.

### Slice 7: Projections, Querying, And Search Adapter Boundary

Outcome: derived views are explicit, rebuildable, authorized, and ready for future query/search adapters.

Deliverables:

- Projection definition types.
- Inbox projection extraction.
- Projection storage boundary.
- Projection rebuild tests.
- Authorized projection read endpoint.
- Search adapter interface and registration tests.

### Slice 8: Jobs, Push Intents, And Side Effects

Outcome: side effects have a durable, observable lifecycle and push notifications have a safe adapter contract.

Deliverables:

- Job claim/retry/dead-letter storage behavior.
- Worker loop with deterministic tests.
- Job handler registry.
- Test push adapter.
- Notification intent and push registration types.
- Integration tests for job lifecycle and notification enqueue behavior.

### Slice 9: Blob Pipeline And Lifecycle

Outcome: blobs have a real content adapter, validation pipeline, authorization checks, and cleanup path.

Deliverables:

- Blob content store interface.
- Local blob content adapter.
- Size/MIME/content-hash validation.
- Blob processor registry.
- Cleanup command or job.
- Blob authorization and validation tests.

### Slice 10: Conflict Resolution, Limits, And Backpressure

Outcome: offline/realtime edge cases fail predictably instead of becoming silent corruption or reconnect storms.

Deliverables:

- Conflict policy documentation.
- Shared server limits config.
- HTTP and WebSocket size enforcement.
- Subscription/page/presence/signal/append limits.
- Client pending append queue limits.
- Reconnect backoff tests.
- Shared error codes for limit violations.

### Slice 11: Client Runtime Contract Alignment And Platform Lifecycle

Outcome: TypeScript, React, Swift, and Android clients expose consistent behavior for sessions, sync, offline appends, errors, schema compatibility, and app lifecycle.

Deliverables:

- Cross-platform client contract doc.
- TypeScript core API cleanup.
- React hook boundary cleanup.
- Swift SDK typed errors/cache migration metadata.
- Android SDK typed errors/cache migration metadata.
- Platform lifecycle docs for web, iOS, and Android.
- Sync diagnostics fields for last sync/error/schema compatibility.
- Runtime tests on each platform.

### Slice 12: Cross-Platform Fixture Suite

Outcome: TypeScript, Swift, and Kotlin prove they understand the same schema metadata, wire frames, records, and errors.

Deliverables:

- Protocol fixture directory.
- Fixture generator script.
- TypeScript fixture decoding tests.
- Swift fixture decoding tests.
- Android fixture decoding tests.
- Fixture update workflow docs.

### Slice 13: Integration And E2E Matrix

Outcome: Frick has system-level confidence across server, web, Swift, and Android.

Deliverables:

- Server integration test expansion.
- Web runtime smoke test against local server.
- Swift package/build verification path.
- Android unit/build verification path.
- Migration/capability/error/limits verification.
- Optional simulator/emulator smoke scripts.
- CI-oriented test command documentation.

### Slice 14: CI, Build Matrix, And Artifact Verification

Outcome: Frick has one canonical local and CI verification matrix across all platform packages and generated artifacts.

Deliverables:

- `verify:*` package scripts.
- Generated artifact drift checks.
- Protocol fixture verification command.
- Native build/test command documentation.
- CI workflow documentation aligned with local commands.
- Failure artifact expectations.

### Slice 15: Backup, Restore, Privacy, And Data Lifecycle

Outcome: durable framework data has documented recovery behavior, privacy hooks, retention semantics, and audit events.

Deliverables:

- Backup/restore operations guide.
- Restore verification command or doctor check.
- Blob metadata/content consistency check.
- PII classification metadata where useful.
- Data export/deletion/retention hook contracts.
- Audit event types for auth, export, deletion, service access, and privileged operations.
- Redaction tests for logs and error envelopes.

### Slice 16: Performance, Load, And Benchmarking

Outcome: Frick can measure local performance and catch regressions before making scale claims.

Deliverables:

- Benchmark directory and command structure.
- Server append/catch-up benchmark.
- Protocol codec benchmark.
- JSON benchmark output format.
- Synthetic load scenario definitions.
- Initial local performance budgets and interpretation docs.

### Slice 17: Developer Diagnostics And DevTools Data Model

Outcome: developers can inspect framework state and debug sync/auth/schema/cache issues without reaching into internals.

Deliverables:

- Shared diagnostics snapshot type.
- Server diagnostics snapshot.
- TypeScript client diagnostics snapshot.
- Secret-redaction tests for diagnostics.
- Troubleshooting docs for schema mismatch, auth failures, pending appends, and reconnect loops.
- CLI/inspection command shape for server, cache, fixtures, and doctor output.

### Slice 18: Security Operations And Service Principals

Outcome: operational tooling uses scoped machine identities, and framework security behavior is testable.

Deliverables:

- Service-principal model with scopes.
- Policy checks for service-principal actions.
- Audit events for maintenance operations.
- CORS tests.
- Secret redaction tests.
- Protocol decoder fuzz test.
- TLS/proxy/secure-header/dependency-scanning guidance.

### Slice 19: Secure Defaults And Guardrails

Outcome: production-unsafe configuration fails loudly, sensitive data is redacted by schema metadata, and abuse controls are explicit.

Deliverables:

- Runtime presets for development, test, staging, and production.
- Typed config validation errors with fix suggestions.
- Production boot rejection tests for unsafe defaults.
- Secret provider boundary.
- Field-level sensitivity metadata.
- Redaction tests for `secret`, `pii`, and `content` fields.
- Abuse-control interfaces and quota error behavior.
- Cookie-auth and webhook security posture docs.

### Slice 20: App Authoring Model

Outcome: apps have one explicit way to register framework behavior and enough test support to build custom app modules safely.

Deliverables:

- Typed app manifest model.
- Manifest validation with typed errors.
- Small example manifest tied to tests or fixtures.
- Generated operation helper design.
- Policy test harness.
- In-process fake server/test runtime.
- Mock adapters under test-support entry points.
- Seed/fixture command design.
- Error-to-UX SDK guidance.

### Slice 21: Developer Experience Tooling

Outcome: developers can diagnose, upgrade, reproduce, and learn framework behavior without relying on internal code spelunking.

Deliverables:

- Doctor output with severity, explanation, fix suggestion, and docs link.
- Trace snapshot types and redacted capture/replay rules.
- Schema diff classification.
- Upgrade check design.
- Policy explorer output.
- Focused module examples tied to tests or fixtures.
- Golden-path tutorials for common app-building tasks.

### Slice 22: Data Modeling Ergonomics

Outcome: schema authors get linting, cookbook guidance, and explicit reference/enum evolution semantics before risky data models ship.

Deliverables:

- Schema lint result types.
- Initial schema lint rule set.
- `frick schema lint` command shape or package script.
- Lint fixtures for pass, warning, and error cases.
- Cookbook docs for membership, redaction, attachments, and projections.
- Reference semantics metadata.
- Enum evolution docs and generated-client expectations.

### Slice 23: App Modules, Multi-App Servers, Feature Flags, And Promotion

Outcome: Frick can grow toward reusable modules, multiple apps per server, controlled rollouts, and environment promotion without retrofitting core ids.

Deliverables:

- Module metadata types.
- Module dependency graph validation.
- App id propagation in manifest, diagnostics, audit events, and capability negotiation.
- Feature flag types and negotiated flag delivery.
- Environment promotion docs.
- Migration dry-run and artifact-promotion command shapes.
- Tests for module cycles, app id propagation, and feature flag negotiation shape.

### Slice 24: Import, Export, Interop, And Local Client Data Lifecycle

Outcome: app data can move in and out safely, and local client caches have explicit lifecycle behavior.

Deliverables:

- Import/export manifest types.
- Validation-only import tests.
- Deterministic JSON export fixtures.
- Local cache lifecycle docs for web, Swift, and Android.
- Per-user native cache namespace metadata.
- Logout cache-clearing behavior tests.
- Cache compaction and disk quota policy docs.

### Slice 25: Maintenance Workflows And Supportability

Outcome: operational repair and support workflows are explicit, scoped, auditable, and redacted.

Deliverables:

- Maintenance operation types with service-principal scopes.
- Dry-run output shape for projection rebuild and blob consistency checks.
- Support bundle snapshot type.
- Support bundle redaction tests.
- Support query docs for append, policy, stale client, job, blob, migration, and feature flag investigations.
- Destructive repair command guardrail policy.

### Slice 26: Compliance Evidence, Dependency Governance, And International Readiness

Outcome: Frick can produce useful operational evidence, govern dependencies, and avoid blocking international apps without making compliance promises.

Deliverables:

- Evidence report type sketches.
- Audit export, deletion report, security config report, dependency report, and migration history docs.
- Dependency license policy docs.
- Future SBOM requirement.
- Time zone and Unicode normalization guidelines.
- RTL and locale expectations for design docs.
- Region/data-residency metadata design point.

### Slice 27: Accessibility, Localization, And Documentation Architecture

Outcome: reusable UI and docs scale across teams, languages, and platforms without burying framework concepts.

Deliverables:

- Docs index and information architecture.
- Accessibility requirements for design primitives and workspace shell.
- Localization guidelines for component labels, accessibility strings, and error messages.
- Public docs separating framework, app, demo, generated, and operational code.
- Initial docs check command when the structure is stable.

### Slice 28: Release Distribution And Packaging Pass

Outcome: only after the system contracts are stable, Frick can be packaged as a drop-in framework.

Deliverables:

- Package distribution policy for npm, SwiftPM, and Android artifacts.
- Public package manifest audit.
- Generated artifact provenance metadata.
- Changelog/release note template.
- Public API reference.
- Operational guide.
- Migration guide.
- Security and threat model guide.
- Extension authoring guide.
- Client lifecycle guide.
- Versioning/release policy.
- Starter/template requirements derived from real framework contracts.

## 34. Non-Goals For This Spec

- Do not create `create-frick-app` yet.
- Do not design a hosted Frick cloud service.
- Do not require Postgres implementation in the first hardening slice.
- Do not build a full FrickenChat product.
- Do not add billing, analytics, product admin UI, email delivery, or concrete APNs/FCM/Web Push providers yet.
- Do not add external search engine adapters until the search boundary and authorization model are stable.
- Do not add a visual browser/native devtools panel until diagnostics snapshots are stable.
- Do not promise SOC 2, HIPAA, GDPR, or other compliance posture from this spec alone.
- Do not require package publishing, signing, or provenance tooling before public/internal API boundaries are stable.
- Do not require external observability, security scanning, or load-testing services to run local verification.
- Do not add cookie-based auth, webhook delivery, vault/KMS integrations, visual policy explorers, or full starter templates until their guardrail contracts are tested.
- Do not make generated typed helpers the only way to access framework primitives; raw protocol/runtime APIs must remain available for advanced and test use.
- Do not implement multi-app hosting, region-aware storage routing, dependency SBOM generation, or compliance report automation before the metadata and evidence contracts are stable.
- Do not make feature flags a substitute for schema compatibility, authorization, or migration safety.
- Do not add destructive maintenance commands without dry-run, service-principal scope checks, audit events, and explicit environment guards.
- Do not promise rolling upgrades until schema compatibility tests exist.

## 35. Open Decisions To Resolve Per Slice

- Whether schema versions use strict semver, revision integers, or both in generated native code.
- Whether client cache migrations should preserve pending appends across all incompatible changes or fail closed.
- Which password hashing dependency is acceptable for the Node server runtime.
- Whether production auth should support only external provider hooks or keep a built-in account provider.
- Which structured log format to standardize on.
- Whether tenant id becomes mandatory in storage tables before the first production release.
- Which capability names are stable enough for public SDKs.
- Whether projections live in protocol metadata or server-only extension metadata.
- Whether search starts as SQLite FTS or remains adapter-only until a product flow needs it.
- Which job worker execution model should ship first: in-process only or separate worker process.
- Which blob upload modes ship before release: direct only or direct plus resumable sessions.
- Which limits are framework defaults versus deployment-required configuration.
- Which packages should be published independently and which should remain source-only until release.
- Whether Android artifacts should publish through Maven Local first, GitHub Packages, Maven Central, or another registry.
- Whether Swift packages remain tag-based only or need binary artifact support.
- Which CI jobs are required for every change versus nightly/manual verification.
- What backup/restore command surface belongs in Frick versus deployment documentation.
- How much privacy lifecycle support belongs in framework hooks versus app-owned workflows.
- Which performance budgets are meaningful before Postgres/object storage adapters exist.
- Whether diagnostics snapshots should be part of public SDK API or development-only API.
- Which dependency scanning and fuzzing tools fit the repo without adding brittle workflows.
- Which production preset values should be strict defaults versus deployer-required configuration.
- Which schema sensitivity labels are stable enough for public app schemas.
- Which secret provider API should ship before non-env secret stores exist.
- Which abuse controls need in-memory defaults and which require external/distributed adapters.
- Whether app manifests live in TypeScript only at first or need Swift/Kotlin-visible metadata.
- How much generated helper API should be emitted before schema extension/module boundaries are stable.
- Where test-support adapters should live so production packages do not accidentally depend on them.
- Which trace fields are safe by default and which require explicit development-only content capture.
- Whether schema diff and upgrade checks should be standalone CLI commands or subcommands under `frick doctor`.
- Which schema lint warnings should be blocking errors before the first release.
- How module ids, module versions, and module migrations compose with app schema revisions.
- Whether multi-app support should mean shared database with app ids, separate databases, or deployment-level separation.
- Which feature flag storage and rollout model is enough before external flag providers exist.
- What environment promotion checks are mandatory versus advisory.
- Which import/export formats should be stable enough for public use.
- Whether local cache encryption hooks are framework-owned or app-provided per platform.
- Which maintenance commands are safe enough for early implementation.
- What support bundle contents are useful without risking privacy leaks.
- Which compliance evidence reports are framework-owned versus app-owned.
- Which dependency licenses should be blocked by policy.
- How region/data-residency metadata should shape future storage adapters.
- Which accessibility checks can be automated across web, SwiftUI, and Android.
- Which documentation checks provide value without creating noisy busywork.
- Which native smoke tests are worth automating before CI infrastructure exists.
- How much of the design system is framework API versus optional package.

These decisions should be resolved inside the relevant implementation slice, where the code and tests can force concrete choices.
