# Changelog

All notable changes to Frick framework packages are recorded here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/) and the versioning policy lives in [`docs/versioning.md`](docs/versioning.md).

Each package version is independent — a release header documents which packages moved and by how much.

## Unreleased

### Cohesive SDK Refactor (Phases 1–6)

A multi-commit rollout that lifts the client SDKs from "you can hand-write it" to "the SDK does the obvious thing":

#### Phase 1 — Codegen foundation + chat helpers graduated

- New TypeScript schema generator (`generateTypeScriptBindings`) emits typed DTOs, tagged-union stream-event types, a `FrickBindings` interface, and field-id lookup tables. Output written to `packages/core/src/generated/bindings.ts` so consumers get `frick.Conversation.useAll()` with full autocomplete.
- New typed error-code generators emit Swift `FrickErrorCode: String` enums, Kotlin `enum class FrickErrorCode(val wireValue: String)` with `fromWire(...)` round-tripping, and a TS const-union + membership predicate — all derived from a single `FRICK_ERROR_CODES` source-of-truth array.
- `bindSchema(client, schema)` runtime factory in `@frick/core` flattens schema entries into name-keyed bindings that reuse the existing `Signal<T>` cache.
- New backwards-paginated read primitive: `StreamStore.readBefore(...)` + `?before=N&limit=M` on the `/streams/:name/:key` route + `FrickClient.loadOlder(stream, key, count, before?)`.
- `apps/web/src/chat-foundation.ts` graduated into `@frick/core/chat`: auth (devLogin/signUp/login), blob (upload/hash/derivatives), search, push registration, conversation create, inbox/read-receipt derivation. The shim was retired in Phase 3b.

#### Phase 2 — Optimistic mutations + persistent web cache + devtools

- `OptimisticOverlay` in `@frick/core` synthesizes display-only events / object upserts into the runtime's `stream()` / `objects()` signals before server Ack. `client.append(..., { optimistic })` and `client.upsertObject(..., undefined, { optimistic: true })` opt in; the new Promise rejects with `OptimisticConflictError` on `storage.conflict` nacks so the UI can roll back.
- `openIndexedDBFrickCache({ dbName, indexedDB? })` factory in `@frick/core` mirrors every write through to IndexedDB so a page reload preserves objects, stream events, cursors, and the pending-append queue. Closes the web client's parity gap with iOS/Android SQLite caches.
- New `@frick/devtools` workspace publishes a `<FrickDevtools enabled />` React component — floating panel polls `/_frick/inspect/devtools/events`, surfaces connection status + frame log + push deliveries + filter-by-kind input. Dependency-free inline styles; gate behind `import.meta.env.DEV` in production.

#### Phase 3 — Auth/blob/search hooks + breaking `useStream` shape

- `useStream(...)` now returns `{ events, loadOlder, hasMore, loading }` instead of a bare array. **Breaking change** — pre-1.0 with `greenfield-cutover` compatibility makes this safe. `useAppend` / `useUpsertObject` gain optional `{ optimistic }` options threading into the Phase 2 overlay.
- `packages/react/src/auth.tsx` — `useSession`, `useSignIn`, `useSignUp`, `useDevSignIn`, `useSignOut`, `<RequireAuth fallback>`. Sets the session on the surrounding `<FrickProvider>` so the WebSocket reconnects with the new bearer token automatically.
- `packages/react/src/blob.tsx` — `useUploadBlob`, `<FileDropzone>`, `usePasteImageUpload`. Optional client-side image compression via `createImageBitmap` + `OffscreenCanvas`.
- `packages/react/src/search.tsx` — `useSearch(query, opts)` with debounced fetch, race protection, tagged `{ response, isLoading, error }` state.

#### Phase 4 — Realtime UX wrappers + media memos

- `packages/react/src/realtime.tsx` collapses chat-app primitives: `useReactions`, `useTyping` (debounced presence with auto-stop tail), `useReadReceipts` (over the inbox projection), `useMessageActions` (`edit` / `redact` with optimism), `useLiveCursor`.
- `packages/react/src/media.tsx` — `useVoiceMemo()` / `useVideoMemo()` wrap `MediaRecorder` + `getUserMedia` into start/stop/cancel with auto-stop at `maxDurationMs`. Pipe captures through `useUploadBlob`.

#### Phase 5 — Native parity

- Kotlin: `FrickSyncSocket.subscribePresence` / `setPresence` / `clearPresence` (closes the gap with Swift + TypeScript). New `FrickInboundEvent.PresenceDelta(name, records, cleared)` case + `PRESENCE_DELTA` frame handler. `FrickClient.search(index, q, filter, limit)` mirrors the Swift+TS search call with typed `FrickSearchResponse`.
- Swift: `FrickClient.search(...)` + `FrickSearchHit` / `FrickSearchResponse` Codable structs. New `Sources/FrickSwift/SwiftUI/FrickStream.swift` adds `@FrickStream("MessageStream", key:)` and `@FrickPresence("TypingState", key:)` property wrappers driven by an `@Environment(\.frickSyncSocket)` key.
- Swift: `FrickDraftStore` syncs per-user/per-conversation `MessageDraft` rows over `FrickSyncSocket.subscribeObject` and `upsertObject`.
- New `:frick-compose` Gradle module: `rememberFrickStream(socket, stream, key)` + `rememberFrickPresence(...)` + `UseFrickEvents` / `UseFrickStatus` Composables. Lives in its own module so the base `:frick` SDK stays Compose-agnostic.
- Android: `FrickDraftStore` mirrors the React and Swift draft id convention and syncs `MessageDraft` rows through object subscriptions/upserts.
- Web Push adapter (`createFrickWebPushAdapter`) rounds out the APNs/FCM trio. VAPID-authenticated ES256 JWT signing, per-tenant credential storage in `tenant_settings.push.webPush.encrypted`. Maps 410 / 404 → `push.unregistered`, 429 → `push.rateLimited`, etc.

#### Phase 6 — Production lifecycle

- Outbound email: `FrickEmailAdapter` interface + `createFrickTestEmailAdapter` (default) + `createFrickResendEmailAdapter` (Resend reference implementation, `RESEND_API_KEY` from env). `createFrickEmailRouter(...)` wraps every send with `frick.email.delivery` devtools telemetry, `redactEmail`-masked recipient logs, and convenience helpers `sendVerificationEmail` / `sendPasswordResetEmail`.
- Composer drafts: `useDraft(conversationId)` in `@frick/react` persists composer text per `(user, conversation)` in `localStorage` with a 250ms debounce by default. Passing `{ sync: true }` uses the `MessageDraft` foundation object for cross-device drafts, with last-write-wins retry on version conflicts.
- Product analytics client API: `trackAnalyticsEvent(...)`, `FrickClient.track(...)`, and `useTrackAnalyticsEvent()` send authenticated `analytics.user_event` records to the platform event pipeline. React apps can opt into automatic route/screen tracking with `<FrickProvider autoAnalytics>`.
- Standalone Fricken Dashboard now loads product analytics through authenticated inspection (`/_frick/inspect/analytics/summary`) and uses the existing inspection platform-event route, so `frick dashboard` can show analytics and pipeline health without mounted server mode.
- TypeScript client OpenTelemetry bridge: `FrickClient` and standalone analytics helpers now emit OTel-compatible analytics and sync WebSocket spans/metrics by default, correlate analytics events with active trace ids, bound frame labels, sanitize close telemetry, and allow `telemetry: false`, `setDefaultClientTelemetryRuntime(...)`, or a custom `FrickClientTelemetryRuntime`.
- Web demo hardening: Vite serve/preview responses now include CSP and browser security headers, and production builds emit the strict header set to `dist/_headers` for static hosts that honor it. Preview uses a stricter no-`unsafe-inline`/no-`unsafe-eval` CSP; dev keeps the local HMR allowances Vite needs. Demo auth sessions are kept in memory only; startup, sign-in, and logout purge legacy browser-stored bearer tokens and logout clears browser push-registration state.
- Web background sync: `apps/web/public/frick-sw.js` Service Worker handles the `frick-pending-appends` sync tag (posts `frick:flush` to clients) and push receive + `notificationclick` deep-link routing. Notification click targets are normalized to same-origin app routes before `postMessage` / `openWindow`. `registerFrickBackgroundSync({ onFlush, onNavigate })` helper in `@frick/core` does the registration dance with graceful degradation when the Background Sync API is missing.

#### Protocol

- Generator now emits a `FrickSchemaDescriptor` (Swift `enum`) and `FRICK_*` constant tables (Kotlin `internal val`s) alongside the existing DTOs: type-id → name and (typeId → fieldId → fieldName) for objects, streams, and events. Used by the native SDKs to decode packed Delta tuples back into named-field shapes.
- `HelloPayload` gains an optional `sessionToken`. WebSocket clients authenticate with the Hello token or an `Authorization: Bearer ...` upgrade header; `sessionToken` URL query credentials are no longer accepted.
- WebSocket sync now rejects all non-`Hello`/non-`Ping` frames until a compatible `HelloAck` has been sent, returning a structured `sync.protocolError` Nack without persisting writes.

### Server (`@frick/server`)

- `POST /analytics/events` now ingests authenticated product analytics into
  the platform event pipeline as `analytics.user_event`, deriving tenant,
  subject, device, and replica identity from the active session and returning
  pipeline receipts with idempotency duplicate status.
- Structured logger redaction now recurses through nested fields and redacts common secret-shaped names such as tokens, passwords, authorization headers, API keys, and private keys.
- Auth sessions now store a SHA-256 digest of the bearer token in SQLite instead of the raw replayable token; the migration rebuilds `auth_sessions`, revoking pre-existing sessions.
- `POST /search` now applies source-level visibility to custom search indexes before returning hits; object-backed hits are checked against object visibility, stream/projection hits without provable source identity fail closed, and framework-reserved source fields are not exposed.
- Custom app-source search indexes now fail closed for tenant users until an app policy hook explicitly allows `search.query`; built-in and foundation-backed indexes with framework visibility proof keep their existing access, and admin principals can still query for operations.
- Admin audit writes are fail-closed for tenant creation, tenant setting writes, account creation, job enqueue, search rebuild, and projection rebuild. Rebuild routes record the allow intent before non-rollbackable work starts.
- Logout now closes active WebSocket sessions for the revoked session token, and privileged WebSocket frames revalidate the backing session row before writes or subscriptions.
- Forward stream pages are bounded by `maxStreamPageSize` across HTTP, SSE initial pages, and WebSocket subscriptions; responses include `cursor` and `hasMore` for continuation.
- WebSocket and SSE admission are bounded by `maxWebSocketConnections` and `maxSseConnections`.
- WebSocket and SSE outbound buffers are bounded by `maxWebSocketOutboundBufferedBytes` and `maxSseOutboundBufferedBytes`; slow clients are closed instead of accumulating unbounded queued data.
- `/auth/signup`, `/auth/login`, and `/auth/dev-login` now use an in-process fixed-window limiter keyed by route, tenant, and identity/IP, returning `429 rateLimit.exceeded` after `maxAuthAttemptsPerWindow`.
- Search requests now enforce query/filter size limits and return a sanitized `sync.protocolError` envelope for invalid adapter query syntax instead of leaking SQLite/FTS parser details.
- Admin search rebuild now rejects projection-backed indexes instead of clearing them through an empty generic source iterator.
- **APNs push adapter** — HTTP/2 over `node:http2`, persistent per-tenant sessions, ES256 JWT signed from the tenant's stored `.p8` PEM and cached for ~50 minutes. Maps `Unregistered` / `BadDeviceToken` / `ExpiredProviderToken` onto the framework's revocation codes so the router tombstones the dead registration. Wire via `createFrickApnsAdapter()` in `ServerOptions.push.adapters`.
- **FCM v1 push adapter** — `fcm.googleapis.com/v1/projects/{projectId}/messages:send` via `fetch`; service-account JWT exchanged for an OAuth2 access token and cached for `expires_in`. Maps `UNREGISTERED` / `INVALID_ARGUMENT` / `SENDER_ID_MISMATCH` onto revocation codes; preserves quota and server errors with stable codes. Wire via `createFrickFcmAdapter()`.
- **Per-tenant push credentials** — stored in `tenant_settings` wrapped with AES-256-GCM. The encryption key comes from `FRICK_PUSH_CRED_KEY` (base64-encoded 32 bytes); when unset the adapters return a `push.credentials.disabled` skipped-delivery rather than running without encryption.
- **`frick.push.delivery` DevTools events** — every fan-out attempt records intent, platform, status, error code, and receipt id so operators can read back exactly what landed where.
- **Platform event pipeline baseline** — the server now ships a shared event contract, memory and durable SQLite adapters, a KafkaJS Redpanda/Kafka adapter boundary, backup/restore preservation, authenticated health at `/_frick/inspect/platform-events` plus `/_frick/dashboard/api/platform-events/health`, and initial job lifecycle events.
- **Dashboard analytics summary** — mounted Fricken Dashboard now exposes `/_frick/dashboard/api/analytics/summary`, a tenant-scoped read model over retained `analytics.user_event` platform events, and renders product event/route summaries in the dashboard.
- **Analytics aggregate consumer** — the server now materializes `analytics.user_event` platform events into durable analytics aggregate/recent-event tables via the configured platform-event adapter, so dashboard summaries work with SQLite and Kafka/Redpanda pipelines.
- **Server OpenTelemetry baseline** — `@frick/server` now has a first-class OTel runtime for HTTP request spans, WebSocket connection/frame telemetry with bounded labels and sanitized close attributes, job-run spans, and request/WebSocket/job metrics, controlled by `FRICK_OTEL_*` / standard OTLP env vars. The Redpanda local profile starts a collector and prints the matching server env.
- WebSocket presence subscribe/set/clear frames now run through authz. Foundation `TypingState` enforces known conversation membership and prevents clients from writing another user's typing state.

### CLI (`@frick/cli`)

- New `frick dev` command prints local runtime profiles; `--profile redpanda`
  starts the checked-in Redpanda Compose service and emits the Kafka platform
  event env vars for local conformance testing.
- New `frick tenants set-push` subcommand:
  - `--platform apns --p8 <file> --key-id ... --team-id ... --bundle-id ... [--sandbox]` encrypts and stores APNs credentials.
  - `--platform fcm --service-account <google-svc-account.json>` encrypts and stores FCM service-account credentials.

### Swift SDK (`packages/swift`)

- `FrickSyncSocket.handleDelta` now decodes the wire's `PackedStreamEvent` tuples into named-field `FrickStreamEvent` values via the new `FrickSchemaDescriptor`. Legacy map-shaped event fixtures continue to decode as before.
- New `FrickInboundEvent.objectsDelta(records:cursor:)` case surfaces `PackedObjectRecord` entries from the gateway's `publishObjects` channel as typed `FrickObjectRecord` values. Additive — existing `.delta` consumers are unchanged.
- `FrickSession` now preserves `tenantId`; Swift SQLite cache metadata stores `tenantId` / `userId` and refuses cached hydration or pending replay when the stored scope does not match the current session.

### Android SDK (`apps/android/frick`)

- `FrickSyncSocket` now decodes `PackedObjectRecord` and `PackedStreamEvent` tuples into named-field maps using the generated `FRICK_OBJECT_NAMES` / `FRICK_STREAM_NAMES` / `FRICK_EVENT_NAMES` / `FRICK_OBJECT_FIELDS` / `FRICK_EVENT_FIELDS` tables. Fixes a regression where every WS Delta event was silently dropped because the decoder cast the tuple form as a map. Unknown field ids round-trip as `"#<id>"` keys so a forward-incompatible schema bump degrades gracefully rather than dropping fields.
- `FrickSession` now preserves `tenantId`; Android SQLite cache metadata stores `tenantId` / `userId` and refuses cached hydration or pending replay when the stored scope does not match the current session.

### Repository

- Added Redpanda local infrastructure at `ops/local/redpanda.compose.yaml`
  for testing the Kafka-compatible platform event pipeline without generating
  infrastructure into app source trees.
- Added the first Frick Platform runtime boundary: project modules can supply
  schema/manifest metadata, and the server can mount authenticated Fricken
  Dashboard routes plus project/schema metadata at `/_frick/dashboard`.
- Added `@frick/agent-kit`, a publishable agent compatibility pack with a
  `frick-agent-kit install` CLI, Codex/Claude/Cursor plugin surfaces, Frick
  skills, subagent profiles, Cursor rules, and a shared app spine template for
  agent-assisted fullstack app builds.
- Added `@frick/mcp` and `frick mcp`, a CLI-owned stdio MCP runtime that lets
  agents inspect documented Frick health, readiness, schema, inspection, stream,
  jobs, and structured-error surfaces. It defaults to read-only mode, with write
  tools gated behind `--allow-writes`.
- Added `frick dashboard`, which serves Fricken Dashboard: a static
  Firebase-style local console under `apps/dev-dashboard` for inspecting
  health, readiness, schema identity, metrics, jobs, migrations, and DevTools
  events against any running Frick server.
- npm publishing is now tag-driven through a pinned-action GitHub Actions workflow that accepts only `framework-v*` tags on `main`, uses npm trusted publishing with OIDC provenance, and publishes the public TypeScript packages from packed `dist` entrypoints.
- `pnpm release:dry-run` now fails publishable packages that expose TypeScript source entrypoints or point manifest fields at files missing from the packed tarball.
- Root `pnpm test`, `pnpm server`, `pnpm web`, and `pnpm cli` build public package entrypoints first so fresh checkouts work with the npm-style `dist` exports.
- `pnpm verify:generated` now regenerates and checks schema DTOs, protocol fixtures, and tracked design-token outputs; the Android publish workflow runs that drift gate plus Android tests/lint/debug builds before publishing to GitHub Packages.
- Apache License 2.0 (`LICENSE`).
- `.gitignore` now excludes `*.p8`, `*.pem`, `*-service-account.json`, and `.env*` so credential files can't be committed by accident.

## 0.1.0 - 2026-05-11

First public scaffolding pass. Establishes the wire contract, server, native clients, demo apps, CLI, and operational documentation. All framework packages start at `0.1.0` after this entry.

### Protocol

- Frame kinds: `hello`, `hello-ack`, `subscribe`, `unsubscribe`, `append`, `signal`, `object-upsert`, `projection-delta`, plus heartbeat and error envelopes.
- `schemaRevision: 1` baseline with capability negotiation in the hello handshake.
- Shared `FrickErrorEnvelope` over HTTP and WebSocket paths.
- Native schema artifact generator emits Swift and Kotlin constants from the TS source of truth.
- Baseline fixtures plus a drift check (`pnpm verify:generated`) guard the generated outputs.
- Schema linter module surfaces shape violations for app authors.

### Server (`@frick/server`)

- Migration runner with checksum-pinned `frick_migrations` table; refuses to boot on drift or unknown future revisions.
- Sync gateway with hello handshake, capability negotiation, frame-size caps, per-tenant limits, heartbeat, presence TTL, and bounded subscription/pending-append queues.
- Multi-tenant isolation threaded through every storage method, request path, and admin route.
- Authorization decisions with typed reason codes; deny-by-default for unknown actions; tenant-scope checks on writes; conversation-membership and blob-ownership enforcement.
- Object versioning with `versionPrecondition` enforcement and `ObjectUpsert` conflict envelopes over the sync socket.
- Typed projection registry with delta broadcasting; conversation inbox re-expressed as a projection.
- Job worker with backoff, dead-letter queue, lifecycle inspect routes, and admin trigger endpoint.
- Push notification router as a job handler with device registrations and admin delivery.
- SQLite FTS5 search adapter wired into store writes with an admin rebuild route.
- Blob derivative storage, synchronous upload validators, and a `blob.process` job handler.
- Backup and restore: NDJSON dump generator with schema-tagged header; restore reader refuses schema drift.
- Per-tenant settings store with admin routes; HTTP and WS paths resolve limits per request.
- DevTools event store with retention pruning; emits events on HTTP, WS, and job lifecycle.
- Compliance: data-subject export and erase endpoints, hash-chained admin audit log with `verifyChain`.
- App registry and hello-driven app routing; `/_frick/inspect/apps` and admin schema-lint route.
- Operational surface: graceful shutdown with in-flight tracking, health/ready/inspect routes, structured logger with redaction defaults, child loggers, per-request log lines, metrics module, idempotency cache with retention and row caps, CORS enforcement, admin bearer auth.

### Swift (`Frick`, `FrickDesign`)

- `FrickSyncSocket` WebSocket transport with hello handshake, append/subscribe/object-upsert send paths, and reconnect handling.
- `FrickClient.connectSync` entry point.
- Shared error envelope parsing over HTTP responses.
- Cache schema compatibility enforced on load.
- Protocol fixture decode tests against generated constants.

### Android (`dev.frick:frick`, `dev.frick:design`)

- `FrickSyncSocket` WebSocket transport scaffolding, hello handshake, status flow, append/subscribe/object-upsert send paths.
- Inbound delta and projection-delta handling.
- Reconnect with backoff plus pending append flush.
- Shared error envelope parsing.
- Cache schema compatibility enforced on load.
- Protocol fixture decode tests against generated constants.
- `mockwebserver3` based sync socket tests.

### Web (`@frick/core`, `@frick/react`, `@frick/web`)

- `@frick/core` runtime with bounded pending append queue, reconnect backoff, projection-delta receive path, `upsertObject` with conflict typing, and cache schema compatibility.
- `@frick/react` `useProjection` hook.
- Web demo wired to the runtime contract.

### CLI (`@frick/cli`)

- Commands: `init`, `schema`, `migrate`, `doctor`, `inspect`, `reset`, `tenants`, `verify`, `lint`, `backup`, `restore`, plus object/stream/projection scaffolders.
- Templates module backing `init` and the scaffolders.

### Docs

- Framework boundaries, threat model, operations runbook, cross-platform client contract.
- App authoring guide, server operations notes (idempotency cache, frame-size cap, per-request logging, metrics snapshot, backup and restore, tenant boundary, CORS).
- Framework hardening spec and plan.
- Versioning policy and release runbook (this round).

### Deprecated

- _None._

### Removed

- _None._

### Security

- Admin routes gated behind `FRICK_ADMIN_TOKEN`.
- Logger redacts secrets by default; CORS enforced on HTTP and WS; deny-by-default authorization; tenant isolation tests across object/stream/blob/inbox paths.
