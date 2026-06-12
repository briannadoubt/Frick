# Frick Server Architecture Map (apps/server) — Rust Rewrite Spec

Scope: `/Users/bri/dev/Frick/apps/server` at v0.3.0 (commit 9f8652d). All paths below are relative
to `apps/server/` unless absolute. Line numbers refer to the files as of this audit.

A Rust rewrite must be WIRE-COMPATIBLE: same MessagePack frame protocol (`@fricken/protocol`
`encodeFrame`/`decodeFrame` — frames are msgpack-encoded 2-tuples `[FrameKind, payload]`), same
schema identity (schemaId / schemaRevision / hash), same JSON error-envelope shape on HTTP
(`createFrickErrorEnvelope`).

---

## 1. Entry points

| Entry | File | Behavior |
|---|---|---|
| Library barrel | `src/index.ts` | Exports-only (no side effects). Re-exports `createFrickServer`, stores, drivers, authz types, config, calls, etc. (`src/index.ts:1-433`). |
| Dev binary | `src/dev.ts:8-14` | `createFrickServer()` with all defaults + `await app.listen()`; prints `http://127.0.0.1:<port>` and `ws://127.0.0.1:<port>/_frick/sync`. Run via `pnpm dev` → `tsx src/dev.ts`. |
| Factory | `createFrickServer(options)` in `src/server.ts:496` | Builds config, store, gateway, registries, HTTP server, WS server; returns handle `{ port, server, store, extensions, config, logger, startedAt, listen, close, notifications, pushRegistry, platformEvents, analyticsConsumer, telemetry, apps, gateway, recurring, httpUrl }` (`src/server.ts:2909-2935`). |

`listen()` (`src/server.ts:2781-2823`): `await store.initialize()` (Postgres migrations; SQLite is
synchronous no-op) → `telemetry.start()` (failures logged `frick.otel.start_failed`, never fatal)
→ `server.listen(port, host)`. On success logs `frick.server.listen` with `schemaId,
schemaRevision, schemaHash, env, host, port, publicUrl, demoAuthEnabled, dbPath,
inspectionEnabled`. Port resolution: `options.port ?? Number(process.env.PORT ?? config.port)`
(`src/server.ts:498`).

GOTCHA — database path: the store path is `options.dbPath ?? process.env.FRICK_DB_PATH ??
defaultDatabasePath()` (`src/server.ts:587`), where `defaultDatabasePath()` =
`<package>/data/frick.sqlite` resolved relative to the compiled module (`src/server.ts:2989-2991`).
`config.dbPath` (default `./frick.sqlite`) is NOT used to open the DB — it is only used for the
production `:memory:` guard and the startup log line.

`inTestRunner` = `config.env === "test" || NODE_ENV === "test" || VITEST !== undefined`
(`src/server.ts:502-505`). Controls default logger (noop in tests vs console), job-worker default
(off in tests), analytics-consumer default, recurring-scheduler start.

---

## 2. config.ts — every env var

`loadFrickConfig(overrides, context)` (`src/config.ts:311`) reads env then layers explicit
overrides (overrides win). All `parse*` helpers treat `undefined` **and empty string** as unset.
`parseBoolean` accepts case-insensitive `true/1/yes` and `false/0/no`; anything else throws
`FrickConfigError` (`src/config.ts:561-575`).

| Env var | Config field | Type / validation | Default |
|---|---|---|---|
| `FRICK_ENV` | `env` | one of `development`,`test`,`production` else throw | `development` |
| `FRICK_DEMO_AUTH_ENABLED` | `demoAuthEnabled` | boolean | `env !== "production"` |
| `FRICK_SESSION_TTL_SECONDS` | `sessionTtlSeconds` | finite number (negatives allowed — ≤0 means "expire immediately", used by tests) | `604800` (7 d) |
| `FRICK_HOST` | `host` | string | `127.0.0.1` (dev/test), `0.0.0.0` (production) (`src/config.ts:860-862`) |
| `FRICK_PORT` | `port` | integer in [0, 65535] else throw | `4099` |
| `FRICK_PUBLIC_URL` | `publicUrl` | string \| undefined | undefined |
| `FRICK_ALLOWED_ORIGINS` | `allowedOrigins` | comma-separated; entries: `*`, exact origin, or `scheme://*.<host>` single leading-label wildcard. Each non-`*` entry must parse as URL with no path/query/fragment/credentials and non-empty host. Malformed → throw (`src/config.ts:721-800`) | `["*"]` non-production; `[]` production |
| `FRICK_DB_DRIVER` | `dbDriver` | `sqlite`\|`postgres` else throw | `sqlite` |
| `FRICK_DB_PATH` | `dbPath` | string | `./frick.sqlite` (but see §1 gotcha) |
| `FRICK_DATABASE_URL` | `databaseUrl` | string \| undefined | undefined |
| `FRICK_BLOB_DRIVER` | `blobDriver` | `sqlite`\|`filesystem`\|`s3` else throw | `sqlite` |
| `FRICK_PASSWORD_HASHER` | `passwordHasher` | `argon2`\|`scrypt` else throw | `argon2` (Argon2id; scrypt creds always verify and transparently re-hash on login) |
| `FRICK_BLOB_STORAGE_PATH` | `blobStoragePath` | string | `./frick-blobs/` |
| `FRICK_BLOB_S3_BUCKET` | `blobS3Bucket` | string \| undefined | undefined |
| `FRICK_BLOB_S3_REGION` | `blobS3Region` | string \| undefined | undefined |
| `FRICK_BLOB_S3_ENDPOINT` | `blobS3Endpoint` | string \| undefined | undefined |
| `FRICK_BLOB_S3_PREFIX` | `blobS3Prefix` | string \| undefined | undefined |
| `FRICK_LOG_LEVEL` | `logLevel` | `debug`\|`info`\|`warn`\|`error` else throw | `info` |
| `FRICK_OTEL_ENABLED` | `otelEnabled` | boolean | true iff any OTLP endpoint configured AND `OTEL_SDK_DISABLED` ≠ `"true"` (case-insensitive) |
| `FRICK_OTEL_SERVICE_NAME` (fallback `OTEL_SERVICE_NAME`) | `otelServiceName` | non-empty after trim else throw | `frick-server` |
| `FRICK_OTEL_EXPORTER_OTLP_ENDPOINT` (fallback `OTEL_EXPORTER_OTLP_ENDPOINT`) | `otelExporterOtlpEndpoint` | string \| undefined | undefined |
| `FRICK_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (fallback `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) | `otelExporterOtlpTracesEndpoint` | string \| undefined | undefined |
| `FRICK_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (fallback `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) | `otelExporterOtlpMetricsEndpoint` | string \| undefined | undefined |
| `FRICK_OTEL_METRIC_EXPORT_INTERVAL_MS` | `otelMetricExportIntervalMs` | positive integer else throw | `60000` |
| `FRICK_INSPECTION_ENABLED` | `inspectionEnabled` | boolean | `env !== "production"` |
| `FRICK_ADMIN_TOKEN` | `adminToken` | string \| undefined; `adminEnabled = !!adminToken` | undefined (admin surface fully disabled: routes 404) |
| `FRICK_IMPLICIT_TENANT_CREATION` | `implicitTenantCreation` | boolean | `env !== "production"` |
| `FRICK_PLATFORM_EVENTS_DRIVER` | `platformEventsDriver` | `sqlite`\|`kafka` else throw | `kafka` if brokers configured, else `sqlite` |
| `FRICK_PLATFORM_EVENTS_TOPIC` | `platformEventsTopic` | non-empty after trim | `frick.platform.events` |
| `FRICK_PLATFORM_EVENTS_KAFKA_BROKERS` | `platformEventsKafkaBrokers` | comma-separated, trimmed, empties dropped | `[]` |
| `FRICK_PLATFORM_EVENTS_RETENTION_MS` | `platformEventsRetentionMs` | positive integer | `604800000` (7 d) |
| `FRICK_PLATFORM_EVENTS_MAX_ROWS` | `platformEventsMaxRows` | positive integer | `1000000` |
| `FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS` | `idempotencyReplayWindowMs` | positive integer | `86400000` (24 h) — lookup-time dedupe bound, independent of retention |
| `FRICK_IDEMPOTENCY_KEY_RETENTION_MS` | `idempotencyKeyRetentionMs` | positive integer | `86400000` (24 h) |
| `FRICK_DEVTOOLS_EVENTS_RETENTION_MS` | `devtoolsEventsRetentionMs` | positive integer | `3600000` (1 h) |
| `FRICK_EXPIRED_SESSION_RETENTION_GRACE_MS` | `expiredSessionRetentionGraceMs` | non-negative integer | `0` |

Limits-layer env vars (`src/limits.ts:136-160`, merged in `src/server.ts:510` as
`mergeLimits({ ...limitsFromEnv(), ...options.limits })` — explicit options win over env, both win
over defaults):

| Env var | Limit field | Validation | Default |
|---|---|---|---|
| `FRICK_MAX_CONNECTIONS_PER_PRINCIPAL` | `maxConnectionsPerPrincipal` | positive integer | 64 |
| `FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL` | `maxBlobBytesPerPrincipal` | positive integer | `Number.MAX_SAFE_INTEGER` (unlimited) |
| `FRICK_BIND_SESSION_DEVICE` | `bindSessionDevice` | boolean | false |

Other env consulted: `PORT` (`src/server.ts:498`), `NODE_ENV`, `VITEST` (test detection),
`OTEL_SDK_DISABLED`. `FRICK_REDIS_URL` is a documented convention for caller-constructed
`RedisClusterBus`, not read by the server itself.

Cross-field validation (`src/config.ts:472-506`), all `FrickConfigError` at load time:
- `dbDriver=postgres` requires `databaseUrl`.
- `blobDriver=filesystem` requires non-blank `blobStoragePath`.
- `blobDriver=s3` requires non-blank `blobS3Bucket`.
- production + `demoAuthEnabled` → refuse to start.
- production + `dbPath === ":memory:"` → refuse to start.
- production + `inspectionEnabled` → warn to stderr (`[frick.config] inspectionEnabled=true in production …`).
- production + adminEnabled → `adminToken.length >= 32` required.

Additional boot check (`src/server.ts:516-524`): `platformEventsDriver=kafka` without brokers and
without an injected `options.platformEvents` → `FrickConfigError`.

Origin matching (`originMatchesAllowlistEntry`, `src/config.ts:808-849`): `*` matches all; exact
string match; wildcard entry matches when scheme AND port match exactly and
`origin.hostname.toLowerCase()` ends with `.<suffixHost>` with at least one extra label (apex never
matches). Requests with NO `Origin` header are always allowed (`isOriginAllowed`,
`src/server.ts:3002-3005`).

`FrickLimits` defaults (`src/limits.ts:88-118`): maxHttpBodyBytes 5,000,000;
maxStreamAppendPayloadBytes 256,000; maxBlobBytes 25,000,000; maxSubscriptionsPerConnection 256;
maxStreamPageSize 500; maxSearchQueryBytes 4,096; maxSearchFilterFields 16; maxSearchFilterKeyBytes
128; maxSearchFilterValueBytes 512; maxPendingAppendsPerClient 1,000; maxWebSocketFrameBytes
524,288; maxWebSocketConnections 10,000; maxConnectionsPerPrincipal 64;
maxWebSocketOutboundBufferedBytes 1,048,576; maxSseConnections 10,000; maxSseOutboundBufferedBytes
1,048,576; maxAuthAttemptsPerWindow 30; authRateLimitWindowMs 300,000; presenceTtlMin/Max 5/600 s;
signalTtlMin/Max 1/120 s; heartbeatIntervalSeconds 25; heartbeatTimeoutSeconds 60;
bindSessionDevice false.

Per-tenant limit overrides (`src/tenant-config.ts:47-65`): `tenant_settings` row key `"limits"`;
only `maxBlobBytes, maxBlobBytesPerPrincipal, maxStreamAppendPayloadBytes,
maxSubscriptionsPerConnection, maxPendingAppendsPerClient` are honored; non-finite/negative values
silently dropped. Resolved once per HTTP request (`src/server.ts:1619`) and once per WS connection
(cached for connection lifetime, `src/sync/gateway.ts:116-125`).

---

## 3. Module map (every `src/` file)

| File | Purpose |
|---|---|
| `analytics/consumer.ts` | Polling worker consuming `analytics.user_event` platform events into the durable analytics read model. |
| `analytics/summary.ts` | `buildAnalyticsSummary` + window normalization for inspect/dashboard analytics endpoints. |
| `app-id.ts` | `DEFAULT_APP_ID = "_default"`, `normalizeAppId` (≤64 chars, `[A-Za-z0-9_.:-]+`). App = per-tenant namespacing axis, NOT a trust boundary (`src/app-id.ts:13-27`). |
| `app-routes/kit.ts` | Helper kit for app-owned routes: `setCors`, `handlePreflight`, `sendJson`, `readJsonBody` (default cap 1 MiB), `matchPath(":param")`, `authenticateRequest`. |
| `apps/registry.ts` | `createFrickAppRegistry`: validates unique ids + basePaths (must start with `/`, no trailing slash; `""` allowed once for root), longest-prefix `resolveByPath`, `findBySchemaId`. |
| `apps/per-app-registries.ts` | Per-app projection + job registry container (see §10). |
| `auth/apple.ts` / `auth/google.ts` | Apple/Google id-token verification (JWKS). |
| `auth/identity-routes.ts` | Identity-provider HTTP router (see route table). NOTE: contains a NUL byte — `grep` treats it as binary; use `rg --text`. |
| `auth/oidc.ts` / `auth/saml.ts` | Generic OIDC verify runtime; SAML metadata/ACS runtime + signature verification. |
| `auth/session-derive.ts` | `deriveSiblingSession`: re-mint a session into a sibling tenant (multi-tenant active-tenant switch). |
| `authz.ts` | `Principal`, `FrickAction`, `decide()`, policy hooks, grant/cascade relaxations, all `assertCan*` helpers (see §8). |
| `authz/rbac.ts` | `makeRbacPolicyHook` — declarative RBAC matrix → policy hook. |
| `backup/dump.ts` / `backup/restore.ts` | NDJSON full/tenant dump; guarded restore (refuses in production). |
| `blobs/gc-job.ts` | Opt-in orphaned-blob GC job + recurring sweep (`blob.gc`, grace 7 d, interval 1 h, min 60 s). |
| `blobs/image-processor.ts` | Reference image blob processor (sniff/dimensions/derivatives). |
| `blobs/processor-job.ts` | `blob.process` job handler + payload codec. |
| `blobs/processor.ts` | Blob processor registry types (`validate`/`process` hooks). |
| `blobs/validation-processor.ts` | `mimeSizeValidator`, `moderationProcessor` building blocks. |
| `calls/*` | FR-15/78/79 call control plane, media-plane adapters (fake, p2p, SFU/mediasoup), call schema fragment, cluster media placement. |
| `cluster/bus.ts` | `FrickClusterBus` contract + `MemoryClusterBus`; `ClusterEnvelope` kinds: streamEvent, objects, objectDeletes, signal, projectionDelta, presenceDelta. |
| `cluster/redis-bus.ts` | Redis pub/sub bus adapter. |
| `cluster/region-bus.ts` / `region-redis-bus.ts` / `region-router.ts` / `region-failover.ts` | Multi-region federation: region bus, write routing/ownership, failover coordinator (design-first, FR-20). |
| `compliance/account-export.ts` / `account-delete.ts` | Self-service export base (masks `secret` sensitivities) and delete cascade. |
| `compliance/data-subject-export.ts` / `data-subject-erase.ts` | Admin-side GDPR export/erase. |
| `config.ts` | Runtime config (see §2). |
| `dashboard/*.ts` | Read-only operator dashboard under `/_frick/dashboard` (routes, assets, accounts/blobs/data/jobs/metadata/tenants/tenant-settings builders). |
| `dev.ts` | Dev entry (see §1). |
| `devtools/emit.ts` / `devtools/event-store.ts` | Durable DevTools event feed (`devtools_events`), pruned by retention. |
| `diagnostics.ts` | `assembleDiagnosticsSnapshot` for `frick inspect diagnostics`. |
| `email/*` | Email adapter contract, router (verification/password reset), Resend + test adapters. |
| `extensions.ts` | Trivial extension-ref registry exposed on the server handle. |
| `index.ts` | Public barrel (exports only). |
| `jobs/registry.ts` | Job-handler registry (`register` throws on duplicate; `resolve`, `list`). |
| `jobs/worker.ts` | Polling job worker; claims jobs and dispatches via registry (or per-app registries by `job.appId`). |
| `jobs/recurring.ts` | Recurring registry + scheduler; idempotency key `recurring:<name>:<tenantId>:<windowStart>`; tick default 30 s; `intervalMs >= 60_000`; timer unref'd. |
| `limits.ts` | `FrickLimits`, defaults, env subset, `FrickLimitError`, `clampTtlSeconds`. |
| `logger.ts` | JSON-line structured logger with recursive sensitive-field redaction (see §12). |
| `metrics.ts` | In-process counters/gauges keyed `${name}\|${stableSortedFieldsJson}` (see §12). |
| `platform-events/*` | Platform event pipeline: types, factory (sqlite vs kafka by config), sqlite + kafka + memory adapters. |
| `platform/project.ts` | `FrickProjectModule` (manifest + schema) — Firebase-like app boundary; converts to app definition. |
| `projections/registry.ts` / `projections/helpers.ts` | Projection registry (register/get/list/snapshot/notify, delta listener) + helpers. |
| `push/*` | Push framework: registry, router (`push.deliver` job), APNs/FCM/WebPush/test adapters, encrypted per-tenant credentials in `tenant_settings`. |
| `search/types.ts` | Search index registry, adapter seam, `DEFAULT_SEARCH_LIMIT`, `MAX_SEARCH_LIMIT`. |
| `search/sqlite-fts.ts` / `pg-fts.ts` | FTS5 / Postgres FTS adapters. |
| `search/source-fields.ts` | Reserved `_frick_*` source fields; strip/parse helpers. |
| `server.ts` | HTTP server + all built-in routes + boot wiring (this document, §§4–6). |
| `storage/*.ts` | SQLite/Postgres drivers, framework migrations (checksummed), and one store per concern: accounts, sessions (token stored as SHA-256 digest), tenants, tenant-settings, objects, streams, signals, presence, blobs (+bytes drivers +derivatives), grants, invitations, jobs, push registrations, refresh tokens, password reset, SAML assertions, service principals, admin audit (hash-chained), search, idempotency cache, reset, schema. |
| `store.ts` | `FrickStore` facade composing all storage; write-listener seam (single broadcast funnel); prune timers. |
| `store-app-scoped.ts` | App-scoped store view helper. |
| `sync/gateway.ts` | WS sync gateway (see §6). CONTAINS A LITERAL NUL BYTE at line 554 (see §6.9). |
| `sync/signal-router.ts` | Fan signal envelopes to signal subscribers (used by WS + HTTP + cluster paths). |
| `sync/sse.ts` | SSE registry: `text/event-stream`, heartbeat default 15 s, initial page + live events, buffered-bytes cap. |
| `sync/subscriptions.ts` | `SyncClient` (socket, subscriptions map, principal?, sessionToken?, appId?) + `SubscriptionRegistry` (linear scan matchers per kind). |
| `sync/wire.ts` | `sendFrame`: drops if `readyState !== 1`; closes socket `1013 "WebSocket outbound buffer exceeded"` when `bufferedAmount + frame > maxBufferedAmount` (checked before AND after send). |
| `telemetry/runtime.ts` | OTel SDK wrapper: HTTP spans, WS connection/frame telemetry, job telemetry; noop runtime. |
| `tenant.ts` | `DEFAULT_TENANT_ID = "_default"`, `normalizeTenantId` (≤64, `[A-Za-z0-9_.:-]+`), strict `validateTenantId` (`/^[a-z0-9_][a-z0-9\-_]{0,62}$/i`), `TenantIdValidationError` (reason `invalidTenantId`). |
| `tenant-config.ts` | Per-tenant limits + retention resolution (see §2). |

---

## 4. HTTP route table

Request pipeline (`dispatchHttp`, `src/server.ts:1090-2779`), in order:
1. **App routes** (`options.appRoutes`): prefix+method match, declaration order; handler returning
   true claims the request; throw → 500 `{"error":"internal_error",...}` and log
   `frick.app_route.handle_failed`. App routes run BEFORE built-in CORS.
2. **CORS**: `setCors` always sets `X-Frick-Schema-Hash: <store.schema.hash>`. If origin allowed:
   `Access-Control-Allow-Origin` (`*` when wildcard-only/no-Origin, else echo concrete origin +
   `Vary: Origin`), `Access-Control-Allow-Headers: authorization, content-type, if-match,
   x-frick-idempotency-key, x-frick-owner-id, x-frick-session-token, x-frick-trace-id`,
   `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`,
   `Access-Control-Expose-Headers: etag, x-frick-schema-hash, x-frick-blob-id,
   x-frick-content-hash` (`src/server.ts:3213-3250`). `OPTIONS` → 204 if allowed, else 403
   envelope `auth.forbidden` + `details.reason="originNotAllowed"`, requestId `cors_rejected`.
3. **Dashboard** (`/_frick/dashboard...`).
4. **App resolution**: `appRegistry.resolveByPath(url)` strips the matched basePath; `activeAppId`
   = matched app id when registry has >1 app, else `_default` (`src/server.ts:1159-1172`).
5. Built-in routes below (matched against the basePath-relative URL).

Token extraction (`sessionTokenFromRequest`, `src/server.ts:5067-5076`): `Authorization: Bearer
<t>` (case-insensitive regex `/^Bearer\s+(.+)$/i`) else header `x-frick-session-token`.

Auth column legend — **none**: public. **session**: requires active session (or admin token, or
`sk_` service key) via `protectedHttpPrincipal` (`src/server.ts:3688-3725`); unprotected paths get
synthetic public principal `{userId:"public", deviceId:"public", replicaId:"public",
tenantId:"_default"}`. **inspect**: production → admin token only; non-production → admin token OR
any active session (`src/server.ts:3821-3840`). **admin**: bearer must equal `FRICK_ADMIN_TOKEN`
exactly (plain `===`, deliberately not constant-time, `src/server.ts:3702-3706`); when admin
disabled the whole `/_frick/admin/` block 404s; wrong-but-valid session token → 403
`auth.forbidden` "Admin scope required", missing/invalid → 401 (`src/server.ts:1387-1418`).

### 4.1 Public / lifecycle

| Method | Path | Auth | Purpose / response |
|---|---|---|---|
| GET | `/health` | none | `{ok:true, service:"frick-server", status:"ok"}` (`src/server.ts:1174`) |
| GET | `/ready` | none | 200 `{status:"ready", schemaId, schemaRevision, schemaHash, appliedMigrations}` or 503 `{status:"not-ready", reason:"database_unresponsive"\|"migrations_unavailable", ...}` (`src/server.ts:1186-1209`) |
| GET | `/schema` | none | Active app's full schema JSON (`src/server.ts:1438`) |

### 4.2 Auth (built-in password/demo)

All return `cache-control: no-store` + `pragma: no-cache` (`sendAuthJson`,
`src/server.ts:3257-3264`). All run tenant pre-check `ensureTenantAllowed` and the fixed-window
auth limiter (key `route\0tenantId\0(identityLowercased || ip:<remoteAddress>)` — literal `\0`
escapes; 30 attempts / 300 s default → 429 `rateLimit.exceeded`) (`src/server.ts:3030-3072`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | none | Body `{displayName, handle, password, tenantId?, platform?, deviceId?, replicaId?}`. displayName trimmed/collapsed, 2–80 chars; handle lowercased, `/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/` (3–32); password 8–256 chars. `userId = userIdFromHandle(tenantId, handle)` = `user-<handle with _→->` for `_default`, else `user-<tenantId>-<base>`. 201 `{schemaHash, sessionToken, tenantId, userId, displayName, handle, deviceId, replicaId, expiresAt}` (`src/server.ts:1443-1481`). |
| POST | `/auth/login` | none | Body `{identity, password, tenantId?, ...}`; verify → 200 same shape; invalid creds → 401 `auth.unauthenticated` and a `deny` audit row (`src/server.ts:1483-1523`). |
| POST | `/auth/dev-login` | none (gated `demoAuthEnabled`, else 403 `auth.forbidden`) | Body `{userId, tenantId?, platform?, deviceId?, replicaId?}`. Auto-creates the account when missing with handle `devHandleFromUserId(userId)` = userId stripped of `user-` prefix, non `[a-z0-9_-]` runs → `-`, truncated to 32, fallback `dev-user`; random 32-byte password; logs `frick.auth.dev_login_auto_create`. 200 `{schemaHash, sessionToken, tenantId, userId, deviceId, replicaId, expiresAt}` (no displayName/handle). (`src/server.ts:1525-1582`). GOTCHA: `auth_accounts.user_id` is the GLOBAL primary key (handle uniqueness is per `(tenant_id, handle)` COLLATE NOCASE, migration `0003`, `src/storage/migrations.ts:339-340`) — the same `userId` cannot exist in two tenants; dev-login of an existing userId under a different tenant fails on the PK. |
| POST | `/auth/logout` | session token required | Deletes the session row, live-disconnects WS via `gateway.closeSession(token)`, audits `auth.logout`. 200 `{ok:true}` (`src/server.ts:1584-1607`). |

Defaults inside auth routes: `platform` ∈ web/ios/android/server (default `web`, only validated —
not stored); `deviceId` default `device-<16-char-token>`; `replicaId` default `replica-<…>`
(`randomToken(12)` = 12 random bytes base64url ≈ 16 chars). Session: `sessionToken =
randomToken(32)` (32 bytes → 43-char base64url); `expiresAt = now + sessionTtlSeconds`
(`src/server.ts:5416-5429`). Sessions are stored under `sha256(token)` hex
(`session_token_digest`), never the raw token (`src/storage/session-store.ts:167-169`).

### 4.3 Identity-provider routes (mounted only when `options.identityProviders` set; `src/auth/identity-routes.ts:1971-2031`)

POST `/auth/apple/verify`, POST `/auth/apple/notifications`, POST `/auth/email/signup`, POST
`/auth/email/login`, POST `/auth/email/forgot-password`, POST `/auth/email/reset-password`, POST
`/auth/google/verify`, POST `/auth/refresh`, POST `/auth/refresh/revoke`, POST
`/auth/oidc/:id/verify`, GET `/auth/saml/:id/metadata`, POST `/auth/saml/:id/acs`. They share the
same auth-attempt limiter (route labels e.g. `apple-verify`, `oidc-verify:<id>`,
`forgot-password`); identity router runs before `/ready` (`src/server.ts:1181-1184`).

### 4.4 Protected data-plane routes (auth: session; per-tenant limits applied)

| Method | Path | Purpose / notes |
|---|---|---|
| POST | `/analytics/events` | Publish `analytics.user_event` to platform events; traceId/idempotencyKey also via `x-frick-trace-id` / `x-frick-idempotency-key` headers; `occurredAt` must match `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` AND round-trip `new Date(t).toISOString()===t`. 202 `{ok, eventId, sequence, acceptedAt, duplicate}` (`src/server.ts:1621-1655`). |
| GET | `/account/export` | Owned-object export + optional `onAccountExport` app hook (attached as `app`); audits `account.export`; no-store headers (`src/server.ts:1657-1684`). |
| DELETE or POST | `/account` | Framework delete (objects+sessions+account) → `onAccountDelete` hook → `gateway.closeSession(token)` → audit `account.delete`. 200 `{ok, tenantId, userId, deletedAt, accountDeleted, deletedSessions, deletedObjects}` (`src/server.ts:1686-1743`). |
| GET | `/objects?type=T` | 400 `type_required` without `type`. 200 `{schemaHash, type, data}` via `listObjectsForUser` (`src/server.ts:1745-1760`). |
| POST/PUT | `/objects/:type/:id` | `assertCanWriteObject` → optimistic concurrency via `If-Match` header (quoted or bare integer; `*`/absent = unconditional; `W/` prefix stripped) → `upsertObjectWithPolicy`. Sets `ETag: <nextVersion>`. 201 created / 200 updated `{schemaHash, object:{id,...valueWithoutId}, version, previousVersion, mergePolicy}`. Version conflict → 409 `storage.conflict` envelope with `details {tenantId, objectType, objectId, expectedVersion?, actualVersion, mergePolicy}` + `ETag: actualVersion` (`src/server.ts:1795-1860`). |
| DELETE | `/objects/:type/:id` | Reuses the write decision; 200 `{schemaHash, existed:boolean}` either way (idempotent) (`src/server.ts:1762-1794`). |
| POST | `/push/registrations` | `{deviceId, platform∈apns\|fcm\|webPush\|test, token, environment?∈production\|sandbox (default production)}`; webPush token validated. 201 `{registration}` (`src/server.ts:1862-1896`). |
| DELETE | `/push/registrations/:id` | 404 for missing OR other-user-owned (no cross-user existence leak); 204 on revoke (`src/server.ts:1898-1921`). |
| POST | `/share/invite` | `{recordType, recordId, permission∈read\|write, expiresInSeconds?}`; ttl default `DEFAULT_FRICK_INVITATION_TTL_SECONDS`, clamped to `MAX_FRICK_INVITATION_TTL_SECONDS` (protocol constants); invitation id `inv-<token12>`, token `randomToken(32)`. 201 `{invitation}` (`src/server.ts:1923-1948`). |
| POST | `/share/accept` | Redeem token; outcomes notFound/tenantMismatch/expired/alreadyRedeemed → 403 with distinct messages; self-accept by owner rejected. Grant id `grant-<token12>`. 201 `{grant}` (`src/server.ts:1950-2040`). |
| GET | `/share/grants` | Filters `recordType`, `recordId`, `includeRevoked=true`. 200 `{grants}` (`src/server.ts:2042-2059`). |
| DELETE | `/share/grants/:id` | Owner-only revoke; non-owner → 404 (`src/server.ts:2061-2088`). |
| POST | `/share/grants/:id/leave` | Grantee-only self-revoke; others (incl. owner) → 404 (`src/server.ts:2090-2126`). |
| GET | `/projections` | 200 `{schemaHash, projections:[{name, sources}]}` (`src/server.ts:2128-2137`). |
| GET | `/projections/:name` | 404 `projectionNotFound` if unregistered; 405 `method_not_allowed` if no `read` impl; `assertCanSubscribe(projection)`; query params passed as `Record<string,string>` (`query.key` is the authz key). 200 `{schemaHash, projection, data}` (`src/server.ts:2139-2185`). |
| POST | `/search` | `{index, q, filter?, limit?}`; q byte-capped; filter flat string\|number map, key regex `/^[A-Za-z0-9_-]+$/`, reserved `_frick_*` keys rejected; limit clamped to `MAX_SEARCH_LIMIT`, default `DEFAULT_SEARCH_LIMIT`; adapter errors wrapped as `invalidSearchQuery`; per-hit authz post-filter; non-admin `total` = visible count. 200 `{schemaHash, index, hits, total}` (`src/server.ts:2187-2246`). |
| GET | `/blobs` | Non-admin defaults `ownerId` to self; with ownerId includes `usage {ownerId, usedBytes, quotaBytes\|null}`. 200 `{schemaHash, data, usage?}` (`src/server.ts:2248-2282`). |
| POST | `/blobs` | Metadata-only create `{blobId, ownerId, contentHash, byteLength, mimeType, storageKey?}` → 201 (`src/server.ts:2538-2560`). |
| GET | `/blobs/:id` | Metadata; 404 `blob_not_found`; owner/grant-cascade read authz (`src/server.ts:2516-2536`). |
| PUT | `/blobs/:id/content` | Raw body ≤ maxBlobBytes. Existing metadata: ownership + byteLength/contentHash match check (hash compared only when stored hash starts `sha256-`). New: ownerId from `?ownerId=` or header `x-frick-owner-id`; mime from `content-type` (param-stripped, default `application/octet-stream`). Sync validators (4 KiB preview) → 415 `blob.unsupportedContentType`. Quota projection check → 413 `blob.quotaExceeded`. Enqueues `blob.process` jobs idempotency-keyed `<blobId>:<processorId>:<contentHash>`. contentHash format `sha256-<64hex>`. 201/200 `{ok, blobId, byteLength, contentHash}` (`src/server.ts:2284-2413`). |
| GET | `/blobs/:id/content` | 404 `blob_content_not_found`; 200 with headers `content-type`, `content-length`, `x-frick-blob-id`, `x-frick-content-hash` (`src/server.ts:2415-2442`). |
| GET | `/blobs/:id/derivatives` | 200 `{derivatives}` (`src/server.ts:2489-2514`). |
| GET | `/blobs/:id/derivatives/:derivativeId/content` | 200 bytes with `etag: "<contentHash>"` (`src/server.ts:2444-2487`). |
| POST | `/signals/:name/:key` | `assertCanSignal` (+ WebRTC call-membership gate when calls enabled) → `store.enqueueSignal` → `gateway.publishSignal`. 200 `{ok:true}` (`src/server.ts:2562-2601`). |
| GET | `/signals/:name/:key` | Drain: 200 `{schemaHash, name, key, data}` (`src/server.ts:2603-2634`). |
| GET | `/streams/:stream/:key` | Forward page: `?after=` (exclusive, default 0) + `?limit=`; reads limit+1 to compute `hasMore`. 200 `{schemaHash, stream, key, data, cursor, hasMore}`. `?before=` backward page (exclusive; default limit 50, clamp [1, min(500, maxStreamPageSize)]). `?since=<seq>` strict cursor read (non-negative integer else 400 `stream.invalidCursor`) → `{events}` only. (`src/server.ts:2636-2738`). |
| GET | `/streams/:stream/:key/cursor` | Head probe `{sequence, count}`-shaped via `store.streamHead` (`src/server.ts:2655-2658`). |
| GET | `/streams/:stream/:key/events` | SSE: 429 over `maxSseConnections`; initial page then live events; heartbeat 15 s default (`src/server.ts:2708-2724`). |
| POST | `/append` | `{stream, key, event, payload, requestId}`; payload size = msgpack-encoded bytes ≤ maxStreamAppendPayloadBytes; idempotency by `(tenantId, replicaId, requestId)` within replay window. 200 `{ok, event}`. NO inline broadcast — store write listener fans out (FR-114) (`src/server.ts:2740-2776`). |

Fallback: 404 `{"error":"not_found"}` (`src/server.ts:2778`).

### 4.5 Inspection routes — `GET /_frick/inspect/*` (gated `config.inspectionEnabled`; auth: inspect; `src/server.ts:1211-1385`)

| Sub-path | Returns |
|---|---|
| `server` | `{schemaId, schemaVersion, schemaRevision, schemaHash, appId, env, demoAuthEnabled, inspectionEnabled, startedAt}` (app-resolved schema) |
| `apps` | `{apps:[{id, basePath, schemaId, schemaRevision}]}` |
| `migrations` | `{applied:[{id, schemaRevision, appliedAt, checksum, durationMs}]}` |
| `metrics` | `{snapshotAt, uptimeSeconds, counters, gauges}` |
| `platform-events` | pipeline `health()` |
| `analytics/summary` | `?windowMs=&limit=` summary |
| `projections` | `{projections:[{name, sources, supportsRebuild, supportsRead}]}` |
| `search` | `{adapter, indexes:[{name, source}]}` |
| `db` | `{ready, applied, lastApplied?, idempotencyCache:{size, capacity, evictions}}` |
| `jobs` | `{registeredHandlers, counts, workerEnabled}` |
| `devtools/events` | `?kind=&tenantId=&sinceId=&limit=` newest-first feed |
| `devtools/summary` | `?windowMs=` (default 60 000) per-kind aggregate |
| `devtools/events/:id` | single event or 404 |
| anything else | 404 `{error:"not_found"}` |

### 4.6 Admin routes — `/_frick/admin/*` (auth: admin; `handleAdminRoute`, `src/server.ts:3913-5065`)

Every mutation writes a hash-chained `admin_audit_log` row (SHA-256 over `previousHash ||
canonical_json(row)`; genesis previousHash `""`; `src/storage/admin-audit-store.ts`). `strictAudit`
failures abort the request as `AdminAuditWriteError` → 500 `sync.protocolError` +
`details.reason="adminAuditWriteFailed"`; plain `audit` failures are swallowed.

| Method | Sub-path | Purpose |
|---|---|---|
| GET | `audit-log` | `?since=&action=&limit=` → `{entries}` |
| POST | `sessions/revoke` | `{userId? \| sessionToken?, tenantId?}`; deletes rows + live-disconnects WS. 400 `missingTarget` when neither. → `{revoked, disconnected}` |
| GET | `tenants` | `?includeArchived=true` → `{tenants}` (reads deliberately not audited) |
| POST | `tenants` | `{tenantId, displayName?}` → 201 row; exists → 409 `storage.conflict`-style envelope with `details.reason="tenantExists"` (NOTE: code is `sync.protocolError` here, `src/server.ts:4073-4089`) |
| POST | `tenants/:id/archive` | 404 `tenant_not_found` or 200 row |
| GET | `tenants/:id/settings` | `{tenantId, settings}` |
| PUT | `tenants/:id/settings/:key` | Body is ANY JSON value (not just object). → `{tenantId, key, value}` |
| GET | `tenants/:id` | row or 404 |
| GET | `accounts?tenantId=&limit=` | tenantId required; limit default 100, max 1000 |
| POST | `accounts` | create account (no session minted); handle conflict → 409 `storage.conflict` reason `handleExists` |
| POST | `accounts/move` | `{userId, fromTenantId\|tenantId, toTenantId}` — moves identity row only (data does NOT follow); revokes old-tenant sessions + disconnects. 404/409 envelopes; → `{userId, fromTenantId, toTenantId, moved, revoked, disconnected}` |
| POST | `jobs/:jobType` | `{tenantId?, payload?, idempotencyKey?}` → 201 job row |
| POST | `push/deliver` | `{tenantId?, intent, recipientUserIds[], body?{title,body,data}, threadId?, deepLink?}` → 201 `{jobId, jobType, status}` |
| POST | `backup` | `{tenantId?}` (`"all"` or validated tenant) → streamed `application/x-ndjson` dump |
| POST | `restore` | 403 in production (`restoreNotAllowedInProduction`); requires `?confirm=yes`; `?overwrite=true&forceSchemaDrift=true`; refusals → 409 `restore_refused` |
| POST | `search/:index/rebuild?tenantId=` | projection-sourced indexes → `projectionSourceUnsupported`; → `{index, tenantId, rebuiltAt}` |
| POST | `projections/:name/rebuild?tenantId=` | 405 when no `rebuild` impl; → `{projection, tenantId, rebuiltAt}` |
| GET | `data-subject?tenantId=&userId=` | GDPR export |
| POST | `data-subject/erase?tenantId=&userId=&confirm=` | production requires `confirm=yes` else 412 `confirmation_required` |
| GET | `compliance/manifest` | static manifest (audit table, endpoints, retention defaults) |
| GET | `compliance/audit/verify` | `verifyChain()`; 200 valid / 409 invalid |
| PUT | `tenants/:id/push/apns` | `{keyId, teamId, bundleId, privateKeyPem, useSandbox?}` → 204 |
| PUT | `tenants/:id/push/fcm` | `{projectId, clientEmail, privateKey, tokenUri?}` → 204 |
| PUT | `tenants/:id/push/webpush` | `{subject, publicKey, privateKey}` → 204 |
| POST | `schema/lint` | `{previous?}` → lintSchema / lintSchemaChange result |
| * | anything else | 404 `{error:"not_found"}` |

Admin-token fingerprint for audit rows: `sha256(adminToken)` hex truncated to **12 chars**
(`src/server.ts:647-649`). User-lifecycle audit actor: `u:` + 12-hex sha256(subject)
(`src/server.ts:658-659`). Service-key fingerprint: 12-hex sha256 of the key-id prefix before the
first `.` (`src/server.ts:3786-3789`).

### 4.7 Dashboard — `/_frick/dashboard` (`src/dashboard/routes.ts`)

GET/HEAD only (else 405). Auth per API call via the inspect rule. `/_frick/dashboard` → 302 to
`/_frick/dashboard/`. API routes (all `cache-control: no-store`, strict CSP/security headers,
`src/dashboard/routes.ts:37-58`): `/api/metadata`, `/api/analytics/summary`, `/api/accounts`,
`/api/tenants`, `/api/tenant-settings`, `/api/blobs`, `/api/jobs`, `/api/data/objects/:type`,
`/api/platform-events/health`. Anything else: static asset, else 404.

### 4.8 HTTP error envelope contract (`sendError`, `src/server.ts:3266-3351`)

Body shape (top-level duplication is intentional):
```json
{ "error": <FrickErrorEnvelope>, "code": "...", "message": "...", "requestId": "...", "retryable": false }
```
The envelope is built with `details.routeCode = <requestId string>` plus error-specific details
(`reason`, `limit`/`configuredMax`/`actualValue`, `projection`, `index`, `processorId`,
`tenantId`, …). GOTCHA: `sendError` stamps `schemaHash`/`schemaRevision` from **foundationSchema**,
not the active app schema (`src/server.ts:3341-3342`); per-route 409/anti-conflict envelopes built
inline also use foundationSchema.

Status mapping (`src/server.ts:3267-3284`): FrickLimitError → 429 for
`maxSseConnections`/`maxAuthAttemptsPerWindow`, else 413; BlobValidationRejectedError → 415;
AdminAuditWriteError → 500; AuthenticationError → 401; AuthorizationError → 403;
CorsOriginRejectedError → 403; ProjectionNotFound/SearchIndexNotFound → 404; everything else
→ 400.

Code mapping (`httpErrorCode`, `src/server.ts:3364-3402`): SessionExpiredError →
`auth.sessionExpired`; AuthenticationError → `auth.unauthenticated`; AuthorizationError + CORS →
`auth.forbidden`; blob validation → `blob.unsupportedContentType`; invalid stream cursor →
`stream.invalidCursor`; FrickLimitError → `blob.tooLarge` (maxBlobBytes) / `blob.quotaExceeded`
(maxBlobBytesPerPrincipal) / `stream.appendRejected` (maxStreamAppendPayloadBytes) /
`rateLimit.exceeded` (others); default `sync.protocolError`.

Body reading: chunked accumulate; over-limit pauses the stream and throws (still writes the 413
response) (`src/server.ts:3420-3439`). Empty body parses as `{}`. Bodies must be JSON objects
(`requireRecord`) except admin tenant-settings PUT.

---

## 5. Auth model details

- **Principal** (`src/authz.ts:51-89`): `{userId, deviceId, replicaId, tenantId, scope?:
  "tenant"|"admin"|"service", serviceScopes?}`. Default scope tenant.
- **Session resolution** (`principalFromActiveSessionToken`, `src/server.ts:3791-3815`): active
  session → principal; else if a stale row exists with `expiresAt <= now` → `SessionExpiredError`
  (`auth.sessionExpired`); else generic 401. Archived tenant (`tenants.archivedAt` set) → 401
  "Tenant is archived".
- **Admin principal**: `{userId:"_admin", deviceId:"_admin", replicaId:"_admin",
  tenantId:"_default", scope:"admin"}` (`src/server.ts:3861-3867`). Admin bearer is checked before
  session/service lookups on protected paths.
- **Service principals (FR-46)**: keys shaped `sk_<keyId>.<secret>` (detected by `sk_` prefix +
  `.`); resolved via `store.servicePrincipals.authenticate`; produce scope `"service"` with
  `serviceScopes`; both allow and deny outcomes are audited (action
  `servicePrincipal.authenticate`) fire-and-forget (`src/server.ts:3727-3789`).
- **Tenant gate** (`ensureTenantAllowed`, `src/server.ts:3895-3911`): `_default` always allowed;
  archived tenant → `UnknownTenantError`; unknown tenant → auto-`ensure()` when
  `implicitTenantCreation` else `UnknownTenantError` (403 `auth.forbidden`,
  `details.reason="unknownTenant"`, `details.tenantId`).

---

## 6. WebSocket gateway (`src/sync/gateway.ts`, endpoint `/_frick/sync`)

WS server config (`src/server.ts:759-771`): `path: "/_frick/sync"`, `maxPayload =
limits.maxWebSocketFrameBytes` (524 288), `verifyClient` enforces the same origin allowlist —
rejected upgrade → HTTP 403 "origin not allowed".

### 6.1 Connect
(`#handleConnection`, `src/sync/gateway.ts:231-337`)
1. Global cap: `activeConnections >= maxWebSocketConnections` → close `1013, "WebSocket connection
   limit exceeded"` before any registration.
2. Optional connect-time auth: `Authorization: Bearer <sessionToken>` upgrade header → principal
   (invalid token is silently ignored at connect; the client may still Hello-auth later).
3. Per-tenant limits resolved once and cached for the connection.
4. Per-principal cap: reserve a slot keyed `(tenantId NUL userId)`; over
   `maxConnectionsPerPrincipal` → Nack `rateLimit.exceeded` (requestId `"connect"`,
   `retryable: true`, `details {limit:"maxConnectionsPerPrincipal", configuredMax}`) then close
   `1013`.
5. Register client; gauge `frick.ws.connections.current`; DevTools `ws.connect` event with a
   synthesized `clientId` (randomUUID).
6. Heartbeat timer: every `max(50ms, heartbeatIntervalSeconds*1000)` send `[Ping, {sentAt:
   Date.now()}]`; if no inbound frame within `max(interval, heartbeatTimeoutSeconds*1000)` →
   `socket.terminate()` (`src/sync/gateway.ts:692-711`).
7. **Frame serialization**: all inbound frames for one connection are chained through a single
   promise so processing is strictly in arrival order (`src/sync/gateway.ts:304-310`).

### 6.2 Raw frame handling (`#handleRawFrame`, `src/sync/gateway.ts:1020-1087`)
- Inbound size re-check (belt + ws maxPayload braces): over limit → Nack `rateLimit.exceeded`
  (requestId `"frame"`) then close `1009, "frame too large"`.
- `decodeFrame` then metrics counter `frick.ws.frames.total{kind:<FrameKind enum name>}`, DevTools
  per-connection frameCounts, telemetry.
- Any decode/dispatch throw → Nack `sync.protocolError` with requestId `"unknown"`.

### 6.3 Handshake gate
Before a successful Hello, every frame except `Hello` and `Ping` → Nack `sync.protocolError`,
`details.reason="handshakeRequired"`, with `schemaHash`/`schemaRevision` of the store schema;
requestId extracted per frame kind (subscriptionId for Subscribe/CursorCommit, requestId for
writes, else `"pre-hello"`) (`src/sync/gateway.ts:1089-1110`, `2278-2292`).

### 6.4 Hello (`src/sync/gateway.ts:1113-1274`)
1. **Session auth** (`#authenticateHelloSession`): no token → anonymous OK. Invalid token → Nack
   `auth.unauthenticated` reason `unauthenticated`, close `1008`. Device binding (opt-in
   `bindSessionDevice`): Hello `deviceId`/`replicaId` must BOTH equal the session row's values
   else Nack `auth.unauthenticated` reason `sessionDeviceMismatch`, close 1008. Re-Hello with a
   different principal than the connection's → Nack `auth.forbidden` reason
   `notAuthorizedForResource`, close 1008. Per-principal cap re-checked (idempotent for the same
   key) → Nack `rateLimit.exceeded` requestId `"hello"`, close 1013.
2. **App routing**: client capabilities' advertised `schema.schemaId` matched via
   `appRegistry.findBySchemaId`. On a genuine multi-app server (>1 registered app), an advertised
   schemaId that matches no app AND isn't the store schemaId → Nack `auth.forbidden`
   `details {reason:"appNotAuthorized", knownAppIds:[...]}`. Connection pins `client.appId`
   (storage app id = matched app id if >1 app else `_default`).
3. **No clientCapabilities (legacy)**: strict hash equality via `rejectSchemaMismatch(helloHash,
   target.hash)`; mismatch → Nack `schema.incompatible` (+ `details.appId` when app-matched).
4. **With capabilities**: `compareSchemaCompatibility(clientSchema, targetSchema)`; incompatible →
   Nack `schema.incompatible` (details: `appId` or `knownAppIds`). Then
   `unsupportedRequiredCapabilities` → Nack `sync.protocolError` with
   `details.unsupportedCapabilities`.
5. **Success** (`#sendHelloSuccess`, `src/sync/gateway.ts:1439-1456`): send `[HelloAck,
   {schemaHash, schemaId, schemaRevision, schemaCompatibility, serverCapabilities}]`, mark
   handshake complete, then send `[Schema, <full schema object>]` as a second frame.

### 6.5 Per-frame session re-validation (`#activePrincipalForFrame`, `src/sync/gateway.ts:2022-2069`)
On EVERY authenticated frame: re-read the session from the store. Expired/invalid → auth Nack +
close `1008`. Principal changed under the same token → Nack `auth.forbidden` "Session principal
changed" + close 1008. Archived tenant → Nack + close 1008. Anonymous (no principal) → auth Nack
(`Missing session token`), connection stays open.

### 6.6 Frames
| Frame | Behavior |
|---|---|
| `Subscribe` | Cap `maxSubscriptionsPerConnection` (re-subscribing same id exempt) → Nack `rateLimit.exceeded`. Projection name must exist in the connection's (per-app) registry else Nack `auth.forbidden` reason `projectionNotFound`. `assertCanSubscribe` (kind ∈ object/stream/presence/signal/projection; unknown kinds silently allowed). Replies: projection → `[ProjectionDelta, {projection, changes:<tenant snapshot>}]`; stream (key required, else thrown → protocolError Nack) → `[StreamPage, {subscriptionId, events, cursor, hasMore}]` (reads `maxStreamPageSize+1` to compute hasMore; cursor = last event sequence or requested cursor); object → `[Snapshot, {subscriptionId, objects, cursor: 0}]` with per-record read filtering (§8). (`src/sync/gateway.ts:1307-1437`) |
| `Append` | Pending-writes cap (`maxPendingAppendsPerClient`, shared with ObjectUpsert) → Nack `rateLimit.exceeded` retryable. Payload msgpack-encoded size > maxStreamAppendPayloadBytes → Nack `stream.appendRejected` `details.reason="payloadTooLarge"`. `assertCanAppend` → `store.appendEvent` (idempotent by requestId) → `[Ack, {requestId, cursor: <sequence>}]`. No inline broadcast (store write listener funnel, FR-114). (`src/sync/gateway.ts:1458-1540`) |
| `ObjectUpsert` | Same pending cap. `assertCanWriteObject` → `upsertObjectWithPolicy` (expectedVersion optional) → `[Ack, {requestId, version: nextVersion}]`. Version conflict → Nack `storage.conflict` `details {expectedVersion?, actualVersion, mergePolicy}` + store schemaHash/Revision. (`src/sync/gateway.ts:1542-1635`) |
| `PresenceSet` | `assertCanWritePresence`; TTL from schema `presence.ttlMs/1000` clamped to [presenceTtlMinSeconds, presenceTtlMaxSeconds] (console.warn on clamp); `store.setPresence` → local PresenceDelta fan-out + cluster `presenceDelta` envelope → `[Ack, {requestId}]`. |
| `PresenceClear` | Same, with `cleared:[key]`. |
| `SignalSend` | `assertCanSignal` (+ call-membership gate for the `WebRTCSignal` name) → `enqueueSignal` + `routeSignal` → `[Ack, {requestId}]`. |
| `CallCommand` | Disabled → Nack `auth.forbidden` reason `callsDisabled`. Ops: create (gated by `assertCanCreateCall`), join, accept, leave, end, setMediaState, sfuConnectTransport, sfuProduce, sfuConsume → `[CallCommandResult, {...}]`. `CallAuthzError` → Nack `auth.forbidden` + `details.reason`; `CallStateError`/`CallMediaUnsupportedError` → Nack `sync.protocolError` + reason. (`src/sync/gateway.ts:1812-2001`) |
| `CursorCommit` | Echo `[Ack, {requestId: subscriptionId, cursor}]` — no persistence (`src/sync/gateway.ts:1296-1298`). |
| `Ping` | `[Pong, {sentAt, receivedAt: Date.now()}]`. Allowed pre-Hello. |
| unknown kinds | silently ignored (`src/sync/gateway.ts:1302-1303`). |

Auth Nack shape (`#sendAuthNack`, `src/sync/gateway.ts:2003-2020`): code `auth.unauthenticated`
(AuthenticationError) or `auth.forbidden` (AuthorizationError); message =
`decision.publicMessage`; `details.reason = decision.reason`. All Nacks also duplicate
`code`/`message` at the payload top level: `[Nack, {requestId, error: envelope, code, message}]`.

### 6.7 Fan-out (single funnel, FR-114)
`store.setWriteListener` → `#handleStoreWrite` (`src/sync/gateway.ts:677-690`): objectUpsert →
`publishObjects`; objectDelete → `publishObjectDeletes`; stream append → `publishStreamEvent` +
SSE bridge. The gateway is the ONLY broadcaster; HTTP/WS handlers never publish inline.
- Stream delta: `[Delta, {objects: [], events: [packStreamEvent(...)], cursor: <sequence>}]` to
  subscribers matching (stream, key, same tenant, same app, active principal).
- Object delta: `[Delta, {objects: packObjectRecord[], events: [], cursor: Date.now()}]`; rows
  pass tenant visibility + (when policy hooks exist or any grant exists —
  `#perRecordReadAuthzActive`) per-record `object.read` pipeline.
- Object deletes: ONE `[Delta, {objects: <id-only tombstone records>, events: [], removed:
  [{type, id}...], cursor: Date.now()}]` — both tombstones and the `removed` list
  (`src/sync/gateway.ts:766-803`).
- Projection delta: `[ProjectionDelta, {projection, changes}]`,
  `filterProjectionChangesForPrincipal` is currently a pass-through (`src/sync/gateway.ts:2342-2350`).
- Presence delta: `[PresenceDelta, {subscriptionId, records: packPresenceRecord[], cleared}]` per
  matching subscription.
- Cluster bus: every publish* also forwards an envelope (kinds streamEvent/objects/objectDeletes/
  signal/projectionDelta/presenceDelta) with `originNodeId`, `tenantId`, `appId` (default
  `_default`); peer envelopes re-run the local fan-out only (no re-publish). Tenant-filtered via
  optional `setSubscribedTenants` refcounting (`src/sync/gateway.ts:469-481`).

### 6.8 Outbound backpressure
`sendFrame` closes the socket `1013, "WebSocket outbound buffer exceeded"` when
`bufferedAmount + encoded > maxWebSocketOutboundBufferedBytes` (checked before and after send)
(`src/sync/wire.ts:8-37`).

### 6.9 The NUL byte (IMPORTANT)
`#principalConnectionKey` returns `` `${principal.tenantId}<NUL>${principal.userId}` `` with a
LITERAL 0x00 byte embedded in the template literal at `src/sync/gateway.ts:554` (verified with
`od -c`). This makes the file "binary" to grep — use `rg --text` / `grep -a`. The Rust port must
keep a NUL separator in this key (and in `authAttemptKey` at `src/server.ts:3069-3072`, which uses
`\0` escapes) so ids containing other delimiters cannot collide. `src/auth/identity-routes.ts`
also contains a NUL byte and matches as binary.

### 6.10 Session/lifecycle hooks
`closeSession(token)` and `closeSessionsForUser(userId, tenantId?)` close matching sockets with
`1008, "Session revoked"`; called by logout, account delete, admin revoke, account move.
WebSocket close-code → telemetry category mapping at `src/sync/gateway.ts:2302-2340`.

---

## 7. Tenancy model

- Two partition axes on every framework table: `tenant_id` (security boundary) and `app_id`
  (namespacing, NOT a trust boundary — see the long comment at `src/app-id.ts:13-27`). Defaults:
  `_default` / `_default`.
- The principal's tenant is pinned at session mint and re-derived per request from the session
  row. Cross-tenant access denied with reason `tenantMismatch` unless `scope === "admin"`
  (`decide`, `src/authz.ts:309-318`).
- Tenants ledger: `store.tenants` with `archivedAt`; archived tenants reject auth and live frames.
- App selection: HTTP → URL basePath prefix; WS → Hello-advertised schemaId. Storage app id is the
  resolved app id only when the registry holds >1 app, else always `_default` (HTTP:
  `src/server.ts:1171-1172`; WS: `src/sync/gateway.ts:545-551`).
- `#isPrincipalActive` cheap check: admin OR tenantId not starting with `_archived_`
  (`src/sync/gateway.ts:2254-2256`); authoritative archived check hits the tenants store.

## 8. Policy hooks & authorization pipeline (`src/authz.ts`)

Order, for every decision: `decide()` baseline → app `policyHooks` (synchronous, run only on
allow, first deny wins — tightening-only) → grant relaxation (object.read/object.write denies with
reason `notAuthorizedForResource`/`ownerMismatch` flip to allow when an active grant of the
required permission exists) → cascade grant relaxation (stream.read/projection.read — also
`notMember` — by record id == streamId/projection key). Baselines: blob.read/write → owner-only
(`ownerMismatch`); everything else in the switch → ALLOW; unknown actions → deny. Search has a
special rule: custom app-source indexes fail closed unless a hook explicitly returns ALLOW
(`explicitSearchPolicyAllow`, `src/authz.ts:908-934`). Subscription per-record reads start from a
tenant-wide ALLOW baseline (`canSubscriberReadObjectRecord`, `src/authz.ts:803-819`) and are
skipped wholesale when there are no hooks and the grants table is empty. WebRTC call signals are
additionally gated on call membership (`gateCallSignal` → deny `notMember`).

Actions: `object.read, object.write, stream.read, stream.append, presence.read, presence.write,
signal.send, signal.read, blob.read, blob.write, projection.read, search.query, call.create`.
Deny reasons: `unauthenticated, notAuthorizedForResource, notMember, ownerMismatch,
schemaIncompatible, tenantMismatch`.

## 9. Jobs, recurring, analytics workers

- Job worker (`createFrickJobWorker`) polls the job store; dispatches via the shared registry or
  `perAppRegistries.for(job.appId).jobs`. Enabled by default outside test runners
  (`src/server.ts:961-981`).
- Framework job types: `push.deliver` (notification router), `blob.process`, `blob.gc` (opt-in
  only). App handlers may pre-register `push.deliver`/`blob.process` to override; duplicates throw
  at boot otherwise.
- Recurring scheduler: tick default 30 000 ms, per-(tenant, window) idempotency key
  `recurring:<name>:<tenantId>:<windowStart>`, min interval 60 000 ms; started only outside test
  runners and only when jobs exist; timer unref'd.
- Analytics consumer polls platform events into the analytics read model; default on outside test
  runners.

## 10. Per-app registries (`src/apps/per-app-registries.ts`)

Activated only when ≥1 app declares `projections` or `jobs` (`src/server.ts:553-557`). Container
lazily creates one `{appId, projections, jobs}` set per app id (the `_default` set is created
eagerly; `for("")` maps to `_default`). Wiring (`src/server.ts:559-584`, `938-959`):
- Server-wide projections are registered into BOTH the shared registry and the `_default` set;
  each app's declared projections go only into that app's set (validated against the app's own
  schema — unknown source type → `FrickConfigError` at boot).
- Each per-app projection registry gets a delta listener that forwards to
  `gateway.publishProjectionDelta` (late-bound via `gatewayRef`).
- The default app's job set IS the server-wide registry; every non-default app receives copies of
  all framework/server-wide handlers, then its own handlers (collision with a framework type →
  registry throws at boot).
- The gateway resolves projection subscribe/snapshot against
  `perAppRegistries.for(client.appId).projections` when active, else the shared registry
  (`src/sync/gateway.ts:510-515`).

## 11. Graceful shutdown contract (`close()`, `src/server.ts:2826-2907`)

Idempotent (memoized promise). Order:
1. Set `closing = true`; stop recurring scheduler.
2. Begin stopping job worker and analytics consumer (handlers drain first — they depend on the
   store).
3. `sse.closeAll()`; `gateway.close()` (clears heartbeats, session map, projection delta listener,
   store write listener, cluster unsubscribe, terminates all sockets).
4. Push adapters' optional `close()` (best-effort, logged `frick.push.adapter_close_failed`).
5. Await worker + analytics stop + adapter closes.
6. `server.close()` (drains in-flight HTTP); drain timer `shutdownTimeoutMs` (default 5000 ms,
   `src/server.ts:501`) then `server.closeAllConnections()`.
7. `wss.close()` → close injected platform-events pipeline (only if not the store's own sqlite
   pipeline) → `store.close()` (swallow double-close) → telemetry shutdown → log
   `frick.server.closed`. "Server is not running" errors are tolerated.
`inFlight`/`closing` counters tracked per request via `response.on("close")`
(`src/server.ts:695-758`).

## 12. Logging, metrics, telemetry, DevTools

- **Logger** (`src/logger.ts`): JSON lines `{ts: ISO, level, msg, ...fields}`; warn/error →
  stderr, debug/info → stdout; threshold from `logLevel`; `child()` merges fields. Redaction:
  field NAMES matching
  `/(?:authorization|password|passphrase|secret|token|api[-_]?key|private[-_]?key|signing[-_]?key|cookie|ciphertext|signature|digest|mnemonic|\bseed\b|\botp\b|body|payload)/i`
  recursively replaced with `"<redacted>"`; cycles → `"[Circular]"`. Note `schemaHash`/`entryHash`
  are intentionally NOT matched.
- **Key log events**: `frick.server.listen`, `frick.server.closed`, `frick.http.request` (with
  requestId, method, path, status, durationMs, tenantId/userId when resolved),
  `frick.auth.dev_login_auto_create`, `frick.app_route.handle_failed`, `frick.otel.*_failed`,
  `frick.push.adapter_close_failed`, `frick.platform_events.close_failed`.
- **Metrics** (`src/metrics.ts`): in-memory counters/gauges only, keyed
  `${name}|${JSON.stringify(sortedFields)}`; negative counter inc throws. Names used:
  `frick.http.requests.total{method,status}`, `frick.http.errors.total{code}`,
  `frick.ws.frames.total{kind}`, `frick.ws.connections.current` (gauge). Snapshot sorted by
  (name, fieldKey) and served at `/_frick/inspect/metrics`.
- **Telemetry** (`src/telemetry/runtime.ts`): optional OTel SDK (OTLP HTTP); every call is wrapped
  so telemetry failures never affect request handling.
- **DevTools events** (`emitDevToolsEvent`): durable rows for `http.request` (per request,
  `src/server.ts:1076-1086`), `ws.connect`, `ws.disconnect` (with per-kind frameCounts);
  retention-pruned; queryable via `/_frick/inspect/devtools/*`.

## 13. Surprises / undocumented gotchas (recap)

1. Literal NUL bytes inside string literals: `src/sync/gateway.ts:554` and somewhere in
   `src/auth/identity-routes.ts` (~offset 23 758). Wire-relevant only as in-memory map keys, but
   any byte-for-byte source tooling must use `rg --text`.
2. `config.dbPath` is decorative for SQLite runtime — actual path resolution bypasses it (§1).
3. HTTP error envelopes always carry **foundationSchema** hash/revision, even on multi-app servers.
4. `total` in non-admin `POST /search` responses is the post-filter count, not the adapter's.
5. Non-admin search queries the adapter with `limit: MAX_SEARCH_LIMIT` then slices to the caller's
   limit AFTER authz filtering (`src/server.ts:2218-2240`).
6. `DELETE /objects/:type/:id` responds 200 with `existed` flag — never 204/404 (comment says 204
   but code is `removed ? 200 : 200`, `src/server.ts:2786`).
7. Admin token equality is intentionally not constant-time (documented rationale,
   `src/server.ts:3703-3705`).
8. Session tokens are stored only as SHA-256 hex digests; `StoredSession.sessionToken` is
   re-attached from the caller's plaintext.
9. `CursorCommit` is a pure echo Ack — no durable cursor state.
10. Pre-Hello `Ping` is allowed; everything else is rejected with `handshakeRequired`.
11. `userId` is the GLOBAL PK in `auth_accounts` (handles are per-tenant unique, NOCASE); non-default
    tenants namespace userIds as `user-<tenantId>-<handle>`.
12. Object/Append pending-write budgets share ONE counter per connection (deliberate).
13. `filterProjectionChangesForPrincipal` is currently identity — projection deltas are
    tenant+app-scoped but not per-principal filtered.
14. WS connect with an invalid bearer silently proceeds unauthenticated (auth errors surface at
    Hello/frames), while Hello with an invalid token hard-closes 1008.
15. The auth attempt limiter increments the bucket count even for requests it then rejects, and
    prunes lazily at most once per window.
