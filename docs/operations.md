# Operations Runbook

> **New to Frick?** Start with the [onboarding guide](./onboarding.md) — it walks through the mental model and gets a local server, web demo, and WebSocket sync running in about fifteen minutes. Come back here once you need to operate a server in production.

This document describes what the Frick sync server (`crates/frick-server`)
looks like to an operator today: the runtime modes it supports, the
environment variables it reads, the HTTP endpoints exposed for orchestrators,
the inspection routes, and the shutdown contract. Anything aspirational lives
under `internal/specs/` and `internal/plans/` — this file only describes what
is in main right now.

The framework ships a `frick` CLI (`crates/frick-cli`) for ops (`frick doctor`,
`frick migrate status`, `frick reset`, `frick tenants list`, …); run it with
`cargo run -p frick-cli -- <command>`. The CLI reads the same environment
variables documented below.

> **Server packaging note.** `frick-server` is currently an embeddable Rust
> library with no standalone server binary; a host process wires it in with
> `create_frick_server(...)` and calls `.listen()`. The config, env vars,
> routes, limits, and shutdown contract below all describe that runtime. The
> TypeScript-flavored construction snippets (`createFrickServer({ … })`) in this
> document are retained from the prior implementation and describe the
> equivalent option surface; the Rust option/wiring names may differ.

Building a new app rather than operating an existing one? Start from the
[Getting Started](./authoring.md#getting-started) section of the app
authoring guide — it walks through `frick init` and the `frick scaffold`
commands that produce a Frick application skeleton compatible with this
runbook.

## Web demo security headers

The Vite dev and preview servers attach the demo app's CSP and browser
security headers automatically. `pnpm --filter @fricken/web build` also
emits those strict preview headers to `apps/web/dist/_headers`, which
static hosts such as Netlify and Cloudflare Pages can apply at the site
root. Set `VITE_FRICK_HTTP` and, when the WebSocket endpoint differs from
the derived default, `VITE_FRICK_WS` before building so `connect-src`
matches the production server rather than the local demo defaults. If
your deployment platform ignores `_headers`, copy the generated values
into the web server or CDN configuration before serving the demo to users.

## Runtime modes

The server reads `FRICK_ENV` (defaulting to `development`). Allowed values:

| Mode          | When to use                       | Implies                                                                                                  |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `development` | Local dev loops                   | Host `127.0.0.1`, demo auth on, inspection routes on, `allowedOrigins=["*"]`, console logger             |
| `test`        | Automated test runs               | Same defaults as development; the server's structured logger is replaced with a no-op so output is quiet |
| `production`  | Anything user-facing or shipped   | Host `0.0.0.0`, demo auth off, inspection off, `allowedOrigins=[]`, `dbPath=":memory:"` is rejected      |

Overrides applied as a partial `FrickConfig` to `createFrickServer({ config })`
beat env vars, which beat the per-mode defaults above.

## Environment variables

All variables are optional. Defaults match the runtime mode.

| Variable                    | Default (dev/test)          | Default (production)                  | Notes                                                                |
| --------------------------- | --------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `FRICK_ENV`                 | `development`               | `production` (when set)               | One of `development`, `test`, `production`.                          |
| `FRICK_HOST`                | `127.0.0.1`                 | `0.0.0.0`                             | Host the HTTP server binds to.                                       |
| `FRICK_PORT`                | `4099`                      | `4099`                                | Integer in `[0, 65535]`. `0` asks the kernel to allocate a port.     |
| `FRICK_PUBLIC_URL`          | unset                       | unset                                 | Externally-reachable URL; surfaced in the startup log when set.      |
| `FRICK_ALLOWED_ORIGINS`     | `["*"]`                     | `[]`                                  | Comma-separated allowlist. Entries may be `*` (allow all), an exact origin (`https://app.example.com`), or a subdomain wildcard (`https://*.example.com`, which matches any subdomain but not the apex `example.com`). Enforced for HTTP preflight and WebSocket upgrades; same-origin/server-to-server requests omit `Origin`. Malformed patterns are rejected at startup. |
| `FRICK_DB_DRIVER`           | `sqlite`                    | `sqlite`                              | Durable-storage driver selector. One of `sqlite` or `postgres`. `postgres` requires `FRICK_DATABASE_URL`, but the server runtime still constructs the SQLite-backed stores; Postgres currently covers the standalone migration/schema runner while runtime store ports are in progress. |
| `FRICK_DB_PATH`             | `./frick.sqlite`            | `./frick.sqlite`                      | SQLite path (used by the `sqlite` driver). `":memory:"` is rejected in production. |
| `FRICK_DATABASE_URL`        | unset                       | unset                                 | Postgres connection string for the standalone Postgres migration/schema runner. Required when `FRICK_DB_DRIVER=postgres`; ignored by the `sqlite` runtime store. |
| `FRICK_BLOB_DRIVER`         | `sqlite`                    | `sqlite`                              | Blob-bytes storage driver. One of `sqlite`, `filesystem`, or `s3`. `sqlite` keeps blob bytes in the SQLite `blob_content` table; `filesystem` stores them under `FRICK_BLOB_STORAGE_PATH` in tenant-isolated, id-keyed files; `s3` stores them in an S3-compatible object store under a tenant-isolated key prefix (see "Object-storage blob driver" below). Blob metadata always stays in SQLite. Selecting `filesystem` without a writable `FRICK_BLOB_STORAGE_PATH`, or `s3` without `FRICK_BLOB_S3_BUCKET`, fails fast at startup. |
| `FRICK_BLOB_STORAGE_PATH`   | `./frick-blobs/`            | `./frick-blobs/`                      | Filesystem root for blob bytes. Used by the `filesystem` blob driver; inert under the default `sqlite` driver. Must be a writable directory when `FRICK_BLOB_DRIVER=filesystem`. |
| `FRICK_BLOB_S3_BUCKET`      | unset                       | unset                                 | Target bucket for the `s3` blob driver. Required when `FRICK_BLOB_DRIVER=s3`; inert otherwise. |
| `FRICK_BLOB_S3_REGION`      | unset                       | unset                                 | AWS region for the `s3` blob driver. Optional for S3-compatible stores that ignore it. |
| `FRICK_BLOB_S3_ENDPOINT`    | unset                       | unset                                 | Custom endpoint for an S3-compatible store (MinIO, Cloudflare R2, DigitalOcean Spaces, …). Omit for real AWS S3. Setting it defaults path-style addressing on. |
| `FRICK_BLOB_S3_PREFIX`      | unset                       | unset                                 | Key prefix every blob object lives under in the bucket. Optional. |
| `FRICK_LOG_LEVEL`           | `info`                      | `info`                                | One of `debug`, `info`, `warn`, `error`.                             |
| `FRICK_OTEL_ENABLED`        | `true` when an OTLP endpoint is set; otherwise `false` | same | Enables the built-in OpenTelemetry SDK runtime.                      |
| `FRICK_OTEL_SERVICE_NAME`   | `frick-server`              | `frick-server`                        | OTel service name. Falls back to `OTEL_SERVICE_NAME` when set.        |
| `FRICK_OTEL_EXPORTER_OTLP_ENDPOINT` | unset              | unset                                 | Base OTLP HTTP collector endpoint. Falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`; Frick appends `/v1/traces` and `/v1/metrics`. |
| `FRICK_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset       | unset                                 | Signal-specific traces endpoint. Falls back to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. |
| `FRICK_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset      | unset                                 | Signal-specific metrics endpoint. Falls back to `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. |
| `FRICK_OTEL_METRIC_EXPORT_INTERVAL_MS` | `60000`          | `60000`                               | OTel metric export interval. Positive integer milliseconds.          |
| `FRICK_DEMO_AUTH_ENABLED`   | `true`                      | `false`                               | Toggles `POST /auth/dev-login`. Forcing on in prod logs a warning.   |
| `FRICK_SESSION_TTL_SECONDS` | `604800` (7d)               | `604800`                              | New sessions get `expiresAt = now + ttl`.                            |
| `FRICK_INSPECTION_ENABLED`  | `true`                      | `false`                               | Gates `/_frick/inspect/*`. Forcing on in prod logs a warning.        |
| `FRICK_ADMIN_TOKEN`         | unset                       | unset                                 | Enables `/_frick/admin/*` and production inspection auth. Must be at least 32 chars in production. |
| `FRICK_IMPLICIT_TENANT_CREATION` | `true`                 | `false`                               | Allows auth routes to create unknown tenants automatically.           |
| `FRICK_PLATFORM_EVENTS_DRIVER` | `sqlite`                  | `sqlite` unless brokers are set       | One of `sqlite` or `kafka`. Kafka uses the built-in KafkaJS adapter. |
| `FRICK_PLATFORM_EVENTS_TOPIC` | `frick.platform.events`    | `frick.platform.events`               | Kafka/Redpanda topic name for platform events.                        |
| `FRICK_PLATFORM_EVENTS_KAFKA_BROKERS` | unset             | unset                                 | Comma-separated Kafka/Redpanda brokers. When set and no driver is forced, the driver defaults to `kafka`. |
| `FRICK_PLATFORM_EVENTS_RETENTION_MS` | `604800000` (7d)    | `604800000`                           | SQLite platform event retention window. Positive integer milliseconds. |
| `FRICK_PLATFORM_EVENTS_MAX_ROWS` | `1000000`               | `1000000`                             | SQLite platform event row cap after retention pruning. Positive integer. |
| `FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS` | `86400000` (24h)    | `86400000`                            | Replay-window bound (ms) for `requestId` idempotency, enforced at lookup time independent of retention/pruning: a retry older than the window mints a fresh event. Positive integer. |
| `FRICK_IDEMPOTENCY_KEY_RETENTION_MS` | `86400000` (24h)    | `86400000`                            | Durable retention window (ms) for `idempotency_keys` rows; the background prune deletes rows older than this. Independent of `FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS` (the lookup-time dedupe bound). Positive integer. Per-tenant `retentionMs` settings still override this globally. |
| `FRICK_DEVTOOLS_EVENTS_RETENTION_MS` | `3600000` (1h)      | `3600000`                             | Retention window (ms) for the DevTools event feed (`devtools_events`); older rows are dropped by the prune timer. Positive integer. |
| `FRICK_EXPIRED_SESSION_RETENTION_GRACE_MS` | `0`           | `0`                                   | Grace period (ms) kept before an expired `auth_sessions` row is pruned. `0` prunes the moment a session expires; raise to retain recently-expired rows (e.g. forensics). Non-negative integer. Overridden by an explicit `createFrickServer({ expiredSessionRetentionGraceMs })`. |
| `FRICK_MAX_CONNECTIONS_PER_PRINCIPAL` | `64`               | `64`                                  | Per-principal concurrent WebSocket connection cap (see Runtime limits). Positive integer. An explicit `createFrickServer({ limits })` override wins over this env var. |

Validation errors throw `FrickConfigError` at startup, before any port is
opened. Unknown env values (e.g. `FRICK_ENV=staging`) are fatal — the
server refuses to boot.

## Object-storage blob driver

Setting `FRICK_BLOB_DRIVER=s3` (FR-54) moves blob *bytes* from SQLite into any
S3-compatible object store — AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces,
etc. — while blob *metadata* stays in SQLite. Bytes are written under a
tenant-isolated, content-addressed key prefix (the same collision-free,
traversal-proof encoding the `filesystem` driver uses), so a crafted blob id can
never reach another tenant's objects.

The AWS SDK (`@aws-sdk/client-s3`) is an **optional** dependency, imported lazily
only when the s3 driver is built — `sqlite`/`filesystem` deployments never load
it. Because the SDK import is asynchronous and the store constructor is
synchronous, the s3 driver is built by the host process and injected, exactly
like a `RedisClusterBus`:

```ts
import { createFrickServer, createS3BlobBytesDriver } from "@fricken/server";

const blobBytesDriver = await createS3BlobBytesDriver({
  bucket: process.env.FRICK_BLOB_S3_BUCKET!,
  region: process.env.FRICK_BLOB_S3_REGION,
  endpoint: process.env.FRICK_BLOB_S3_ENDPOINT, // omit for real AWS S3
  prefix: process.env.FRICK_BLOB_S3_PREFIX,
  // credentials default to the AWS provider chain; pass accessKeyId /
  // secretAccessKey to override.
});

const server = createFrickServer({ blobBytesDriver });
```

`createS3BlobBytesDriver` also accepts `forcePathStyle` (defaults to `true` when
a custom `endpoint` is set — most S3-compatible stores need it) and static
`accessKeyId`/`secretAccessKey`. Selecting `FRICK_BLOB_DRIVER=s3` without
injecting a driver throws at construction; selecting it without
`FRICK_BLOB_S3_BUCKET` fails fast at config load. SQLite remains the default, so
this is fully opt-in.

## Blob processing pipeline

Blob processors (registered via `createFrickServer({ blobProcessors: [...] })`)
hook the upload pipeline in two phases: a synchronous `validate(...)` that runs
before any row is written (rejected uploads short-circuit with
`blob.unsupportedContentType`), and an asynchronous `process(...)` that runs as a
`blob.process` job after the upload commits and persists any returned
derivatives. Frick ships three stock processor factories (FR-55, FR-130) — all
additive and behind the same registry surface:

```ts
import {
  createFrickServer,
  imageBlobProcessor,
  mimeSizeValidator,
  moderationProcessor,
} from "@fricken/server";

const server = createFrickServer({
  blobProcessors: [
    // MIME/size gate: reject anything not on the allow-list or over the cap.
    // Allow-list entries match exactly, or by prefix when they end in `/`.
    mimeSizeValidator({
      allowedMimeTypes: ["image/", "application/pdf"],
      maxBytes: 10 * 1024 * 1024,
      matches: { mimePrefixes: ["application/"] },
    }),

    // Image validation + derivative extraction. The derivative generator is
    // pluggable; the default `copyDerivativeGenerator` re-tags the source bytes
    // (no native image library required). Supply your own (e.g. a `sharp`
    // wrapper) for real resizing.
    imageBlobProcessor({
      matches: { mimePrefixes: ["image/"] },
      derivatives: [
        { derivativeId: "thumb-256", maxEdge: 256, mimeType: "image/webp" },
        { derivativeId: "thumb-64", maxEdge: 64 },
      ],
      // derivativeGenerator: myResizer,
    }),

    // Moderation extension point — Frick ships the hook *mechanism*, not a
    // moderation impl. The hook runs in the async `process` phase (never blocks
    // the upload) and its verdict is persisted as a JSON sidecar derivative.
    moderationProcessor({
      hook: async ({ blobId, content }) => {
        const verdict = await myModerationVendor.scan(content);
        return { decision: verdict.flagged ? "flag" : "allow", details: verdict };
      },
    }),
  ],
});
```

Derivatives are retrievable through the existing derivative routes
(`GET /blobs/:blobId/derivatives` and
`GET /blobs/:blobId/derivatives/:derivativeId/content`). Re-running a processor
overwrites the prior derivative on the `(tenant, parent, derivative)` key.

## Local runtime profiles

`frick dev` prints the standard local runtime plan as JSON. The default
`sqlite` profile is zero-infrastructure and uses the SQLite platform event
pipeline:

```bash
frick dev --dry-run
```

Use the Redpanda profile when you want to test the Kafka-compatible event
pipeline locally:

```bash
frick dev --profile redpanda
```

That command starts Redpanda and a local OpenTelemetry Collector from
`ops/local/redpanda.compose.yaml` with Docker Compose and waits for them. The
profile binds broker access to `127.0.0.1:19092`, collector access to
`127.0.0.1:4318`, sets `FRICK_PLATFORM_EVENTS_DRIVER=kafka`, points
`FRICK_PLATFORM_EVENTS_KAFKA_BROKERS` and `FRICK_TEST_KAFKA_BROKERS` at the
local broker, enables OTel export with
`FRICK_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, and prints the
server/web/dashboard commands to run against it. Use `--dry-run` to inspect
the plan without starting Docker.

## Deployment profiles

`frick deploy` prints or starts the standard Docker Compose deployment profile
as JSON. It does not generate platform code into an app repository; the app is
provided as a built image through `FRICK_SERVER_IMAGE` and the checked-in
Compose files wire the Frick runtime services around it.

```bash
frick deploy image --dry-run
frick deploy --profile compose --dry-run
frick deploy --profile lightweight --dry-run
```

`frick deploy image` prints the plan for building the server image consumed by
the profiles. Pass `--tag <image>` to set the image tag, `--dockerfile <path>`
and `--context <path>` to point at your app/runtime-specific build inputs, and
`--push` to request publishing the tag after a successful build.

> The canonical monorepo `ops/deploy/server.Dockerfile` from the prior
> TypeScript server no longer ships, so the default Dockerfile path is not
> present in the tree — supply `--dockerfile <path>` for the image you actually
> build. Providing a turnkey Dockerfile for the Rust server is follow-up work.

`--profile compose` uses `ops/deploy/compose.yaml` and is the
production-shaped self-hosted profile: `frick-server` serves the app and the
mounted dashboard, Redpanda backs the Kafka-compatible platform event pipeline,
and the OTel collector receives server telemetry. The emitted plan sets
`FRICK_ENV=production`,
`FRICK_PLATFORM_EVENTS_DRIVER=kafka`,
`FRICK_PLATFORM_EVENTS_KAFKA_BROKERS=redpanda:9092`,
`FRICK_OTEL_ENABLED=true`, and
`FRICK_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`.

`--profile lightweight` uses `ops/deploy/lightweight.compose.yaml` and keeps
the same server/dashboard deployment shape with the SQLite platform event
pipeline and OTel disabled. This is intended for small self-hosted installs
and smoke environments that do not need a broker.

Without `--dry-run`, the CLI runs `docker compose -f <profile> up -d --wait`
and emits the same plan with `started` and `exitCode`. Docker output stays off
stdout so automation can always parse the JSON record.

### Standalone image recipes (outside the monorepo)

If you scaffold an app with `frick init` (which produces a TypeScript app that
embeds the Frick client/server contract), the reference Dockerfile recipe under
[`docker/scaffolded-app/`](../docker/scaffolded-app) builds that app into an
image: it runs as a non-root user, declares a `/var/lib/frick` data volume, and
`HEALTHCHECK`s against `/ready`. See [`docker-recipes.md`](docker-recipes.md)
for the build/run walkthrough and the SQLite-volume vs `FRICK_DATABASE_URL`
storage guidance.

## Runtime limits

`createFrickServer({ limits })` accepts partial `FrickLimits` overrides. Any
omitted field falls back to the framework default. `maxConnectionsPerPrincipal`
can also be set with the `FRICK_MAX_CONNECTIONS_PER_PRINCIPAL` env var; an
explicit `limits` override wins over the env var, which wins over the default.
These limits are enforced inside the server and should complement, not replace,
reverse-proxy request and connection caps.

| Limit | Default | Applies to |
| --- | ---: | --- |
| `maxHttpBodyBytes` | 5,000,000 | JSON request bodies |
| `maxStreamAppendPayloadBytes` | 256,000 | encoded stream append payloads |
| `maxBlobBytes` | 25,000,000 | blob upload bodies |
| `maxSubscriptionsPerConnection` | 256 | active subscriptions per WebSocket |
| `maxStreamPageSize` | 500 | forward HTTP, SSE, and WebSocket stream pages |
| `maxSearchQueryBytes` | 4,096 | `POST /search` query text |
| `maxSearchFilterFields` | 16 | exact-match search filter field count |
| `maxSearchFilterKeyBytes` | 128 | each search filter key |
| `maxSearchFilterValueBytes` | 512 | each search filter value after stringification |
| `maxPendingAppendsPerClient` | 1,000 | queued appends per WebSocket client |
| `maxWebSocketFrameBytes` | 524,288 | inbound WebSocket frame payloads |
| `maxWebSocketConnections` | 10,000 | concurrently accepted WebSocket connections (global) |
| `maxConnectionsPerPrincipal` | 64 | concurrent WebSocket connections per authenticated principal, keyed by `(tenantId, userId)` |
| `maxWebSocketOutboundBufferedBytes` | 1,048,576 | queued outbound bytes per WebSocket client |
| `maxSseConnections` | 10,000 | concurrently open SSE connections |
| `maxSseOutboundBufferedBytes` | 1,048,576 | queued outbound bytes per SSE response |
| `maxAuthAttemptsPerWindow` | 30 | attempts per auth route + identity/IP bucket. Covers password login/signup/dev-login, every identity-provider verify route (`/auth/apple/verify`, `/auth/google/verify`, `/auth/oidc/:id/verify`), and the email password-reset routes (`/auth/email/forgot-password`, `/auth/email/reset-password`) (FR-29) |
| `authRateLimitWindowMs` | 300,000 | fixed auth-attempt rate-limit window |

Forward stream reads return at most `maxStreamPageSize` events by default and
include `cursor` plus `hasMore` so clients can continue from the last delivered
sequence. Oversized WebSocket frames are rejected by the `ws` parser before
MessagePack decode and the connection is closed. WebSocket connections over
`maxWebSocketConnections` are closed with code `1013`. WebSocket connections
that would exceed `maxConnectionsPerPrincipal` for their authenticated
principal — enforced at connect when a bearer token is present, otherwise at
the `Hello` handshake — receive a `rateLimit.exceeded` Nack (with
`details.limit: "maxConnectionsPerPrincipal"`) and are closed with code
`1013`; the cap is keyed per `(tenantId, userId)`, so one principal hitting
its cap never affects other principals. SSE requests over
`maxSseConnections` return `429 rateLimit.exceeded`. Slow clients whose
WebSocket or SSE outbound buffers exceed their configured caps are closed
rather than allowed to accumulate unbounded queued data. Auth attempts over
`maxAuthAttemptsPerWindow` in the current fixed window also return `429`
(`rateLimit.exceeded` for the password routes; `{ "error": "rate_limited" }`
with a `Retry-After` header for the identity-provider verify and email
password-reset routes — FR-29).

## App-owned HTTP routes

Apps can mount product-owned HTTP handlers with
`createFrickServer({ appRoutes })`. Each route declares a `pathPrefix`, an
optional `method`, and a `handle(req, res)` function. Routes run before
Frick's built-in routes, in declaration order. Returning `true` means the app
handled the request; returning `false` lets the next app route or the
framework's built-in router continue.

Use app routes for narrow product endpoints such as OAuth callbacks, payment
webhooks, or REST reads that do not belong in the sync protocol. Do not use
them to replace documented Frick operational routes or bypass tenant/session
policy. App routes that need CORS on their own prefixes must handle `OPTIONS`
and headers themselves; Frick's built-in CORS shortcut only runs after app
routes fall through.

## Job workers and recurring schedules

`createFrickServer({ jobs })` registers durable background-job handlers at
boot. The worker is enabled outside test runners by default, claims ready rows
from the framework job store, calls the matching handler by `jobType`, retries
retryable failures, dead-letters exhausted jobs, and emits
`jobs.lifecycle` platform events for terminal and retryable outcomes. Disable
the polling loop in embedded tests with
`createFrickServer({ jobs: { workerEnabled: false } })`.

`createFrickServer({ recurring })` adds an in-process scheduler for jobs that
should be enqueued on a time-window cadence without an external cron service.
Each recurring spec has a stable `name`, a registered `jobType`, an
`intervalMs` of at least 60 seconds, and a `resolveTargets({ store, logger })`
function that returns `(tenantId, payload)` targets. Frick derives the
idempotency key as `recurring:<name>:<tenantId>:<windowStart>`, so repeated
ticks in the same window are no-ops. The scheduler timer is stopped by
`close()` and is `unref()`'d so it does not keep the process alive after
shutdown.

## Identity provider routes

`createFrickServer({ identityProviders })` mounts provider-owned auth routes
alongside the built-in `/auth/signup`, `/auth/login`, and `/auth/dev-login`
routes. The current implementation supports Apple, Google ID tokens, generic
OpenID Connect issuers, and email/password accounts with single-use password
reset tokens:

- `POST /auth/apple/verify` verifies an Apple `identityToken` against Apple's
  JWKS with the configured audience, creates or finds the mapped app-owned User
  object, and returns `{ session, user, isNewUser }`.
- `POST /auth/apple/notifications` verifies Apple's server-to-server
  notification JWT in `{ payload }`. Email update events patch the mapped User
  object; `consent-revoked` and `account-delete` set the mapped `revokedAt`
  field and delete active sessions for that user.
- `POST /auth/google/verify` verifies a Google `idToken` against Google's JWKS
  and the configured OAuth client id, creates or finds the mapped User object by
  `googleSubjectField`, and returns `{ session, user, isNewUser }`.
- `POST /auth/oidc/:providerId/verify` verifies a generic OpenID Connect
  `idToken` for a configured provider (Okta, Auth0, Microsoft Entra, Keycloak,
  any standards-compliant issuer). Apps declare providers via
  `identityProviders.oidc: [{ id, issuer, clientId, audience?, jwksUri? |
  discovery, claimMappings? }]`. Each provider resolves its signing keys
  either from a directly-configured `jwksUri` or by fetching the issuer's
  discovery document at `<issuer>/.well-known/openid-configuration` and reading
  its `jwks_uri` (when `discovery: true`). Verification uses `jose` to check the
  signature against the resolved JWKS, the `iss` claim against the configured
  `issuer`, the `aud` claim against `audience` (defaulting to `clientId`), and
  expiry; the optional request `nonce` is checked when supplied in the body.
  Standard claims `sub`, `email`, `name`, and `preferred_username` plus any
  configured `claimMappings.extra` (`{ "<UserField>": "<claim>" }`) populate the
  mapped User object. The verified `sub` is stored on `oidcSubjectField` as a
  per-provider composite `"<providerId>:<sub>"`, so two issuers that reuse the
  same subject value never alias onto one account. Returns
  `{ session, user, isNewUser }`. An unconfigured `:providerId` returns `404`,
  and verification failures return `401 { error: "oidc_token_invalid", code }`.
- `POST /auth/email/signup` creates a mapped User row and password account from
  `{ email, password, displayName? }`. Email is normalized to lowercase, the
  default minimum password length is 8, and duplicate emails return `409`.
- `POST /auth/email/login` verifies `{ email, password }` and returns
  `{ session, user, isNewUser: false }`. Unknown email and bad password share
  the same `401 invalid_credentials` response.
- `POST /auth/email/forgot-password` accepts `{ email }`, normalizes the email,
  always returns `200 { ok: true }`, and only dispatches when the address maps
  to a real account. When `email.outbound` is configured with a `resetUrl`
  builder, the framework composes and sends the reset email through the
  configured adapter (see "Outbound email" below). The optional
  `email.onPasswordResetRequested` hook also fires when set — it receives
  `{ email, userId, tenantId, token, expiresAt }` and coexists with the
  framework send, so apps can layer extra behavior or take full control.
- `POST /auth/email/reset-password` accepts `{ token, password }`, enforces the
  email provider's `minPasswordLength`, consumes the single-use reset token,
  updates the password, deletes active sessions for that user, and returns
  `200 { ok: true }`. Invalid, expired, or already-consumed tokens return
  `400 { error: "invalid_or_expired_token" }`.

These routes are not controlled by `FRICK_DEMO_AUTH_ENABLED`; they are mounted
only for configured providers. Apps must provide a User object mapping when
they do not use the conventional `User.appleSubject`, `User.googleSubject`,
`User.oidcSubject`, `User.email`, `User.displayName`, `User.primaryTenantId`,
and `User.revokedAt` fields. On first sign-in, the optional `onFirstSignIn` hook
receives `provider: "apple" | "google" | "email" | "oidc"` (with `providerId`
set for OIDC sign-ins) and decides the tenant id, user id override, display
name, and extra User fields. Email reset tokens are random
opaque values stored only as SHA-256 hashes and expire after 60 minutes.
Provider sessions are normal Frick bearer sessions minted with the single
configured `FRICK_SESSION_TTL_SECONDS` lifetime — the same TTL as
password/dev-login sessions, not a separate fixed value (FR-29). The provider
verify routes and the email password-reset routes share the built-in
per-(route, identity/IP) auth-attempt limiter, returning `429
{ "error": "rate_limited", "retryAfterSeconds" }` with a `Retry-After` header
once `maxAuthAttemptsPerWindow` is exceeded; verify routes bucket by client IP,
`forgot-password` by email, and `reset-password` by token.

The framework now supports generic OpenID Connect issuers (above) and SAML 2.0
Service Providers via `identityProviders.saml` (each provider mounts
`GET /auth/saml/:id/metadata` and `POST /auth/saml/:id/acs`; inbound assertions
are signature-verified against the configured IdP certificate with audience /
validity-window / recipient / InResponseTo checks and assertion-replay
protection). Arbitrary non-OIDC OAuth provider routing remains unimplemented.

## Sharing routes

The server always mounts authenticated sharing routes for framework object
records. Sharing uses a two-step model: an owner creates an invitation token
out-of-band, and the recipient redeems that token into a durable grant in the
same tenant.

- `POST /share/invite` accepts `{ recordType, recordId, permission,
  expiresInSeconds? }` and returns `201 { invitation }`. `permission` is
  `"read"` or `"write"`. The default invitation lifetime is 14 days; larger
  client lifetimes are clamped to 90 days.
- `POST /share/accept` accepts `{ token }` and returns `201 { grant }`.
  Tokens are single-use, tenant-bound, expire at `expiresAt`, and cannot be
  accepted by the user who created them.
- `GET /share/grants?recordType=&recordId=&includeRevoked=true` returns grants
  where the principal is either the owner or the grantee. Revoked grants are
  excluded unless `includeRevoked=true`.
- `DELETE /share/grants/:id` marks a grant revoked and returns `{ grant }`.
  Only the owner who issued the underlying invitation can revoke it.
- `POST /share/grants/:id/leave` lets the grantee self-revoke ("leave") a
  grant they hold and returns `{ grant }`. Only the grantee of the grant may
  call it; any other caller (including the owner) receives `404`. Revocation
  is idempotent, so leaving an already-revoked grant returns the existing
  revoked row.

Active grants participate in the framework authorization path for
`object.read` and `object.write`. A `"write"` grant satisfies reads and writes;
a `"read"` grant satisfies reads only. Grants never cross tenant boundaries.
For reads, the framework also applies a narrow cascade to derived primitives
whose key is the granted record id: the stream whose `streamId` equals the
record id and projection rows whose subscribe/read `key` equals the record id.
The cascade never relaxes stream appends, whole-projection subscribes without a
key, child records, blobs, jobs, search indexes, or custom app routes.

Object **subscriptions** are authorized per record on the same pipeline (FR-116).
The initial snapshot and every live `object.read` delta are filtered for each
subscriber with the same policy-hook + grant evaluation used for individual
reads, on top of tenant scoping: the subscription baseline allows tenant-wide
reads, a policy hook that denies `object.read` for a principal removes those
rows, and a grant on a record makes it visible to the grantee. Different
subscribers on the same object type therefore see different row sets; denied
rows are omitted from the snapshot and never fanned out to that connection.
Per-record evaluation is skipped (allow-all, the prior behavior) when no policy
hook is registered **and** no sharing grant has ever been issued, so deployments
that use neither pay no per-row cost and see no behavior change.

## Account data export

The server always mounts an authenticated self-service data-export route. This
is the data-subject "give me a copy of my own data" surface (distinct from the
operator-driven `/_frick/admin/data-subject` route, which exports an arbitrary
user's framework-owned records for a privileged operator).

- `GET /account/export` returns the calling principal's own data as a single
  JSON bundle and sets `cache-control: no-store`. No request body or query
  parameters are required. An unauthenticated request returns `401`.

The bundle shape is:

```jsonc
{
  "tenantId": "_default",
  "userId": "user-ada",
  "generatedAt": "2026-05-30T12:00:00.000Z",
  "schemaHash": "…",
  "objects": {
    "<ObjectType>": [ /* records this principal owns, with `id` */ ]
  },
  "app": { /* present only when an onAccountExport hook is registered */ }
}
```

Scoping and isolation:

- Object reads are tenant-scoped to the session's tenant, so a record from
  another tenant can never appear — even one whose owner field matches the
  caller's `userId`.
- A record is treated as owned by the principal when one of its
  `ownerId` / `userId` / `createdBy` fields equals the principal's `userId`
  (the framework default; see `DEFAULT_OWNER_FIELDS`). Apps whose schema uses a
  different owner field can override this in their own export wiring.
- Object types the principal owns no records of appear with an empty array so
  the bundle shape is stable.

Sensitivity handling: this is the principal's own data, so `pii`, `private`
(the default), and `content` fields are returned in full — the point of the
export is to hand the user everything they authored. Only `secret`-classified
fields (credentials, tokens, internal secrets that may be co-located on an
owned record) are masked with `<redacted>`, so an export can never become a
credential-exfiltration vector. See `docs/threat-model.md`.

App augmentation: pass `onAccountExport(principal, base)` to `createFrickServer`
to add app-specific data (e.g. stream history, blob metadata) to the bundle.
The hook receives the resolved principal and the framework's owned-object base;
its return value is attached as `app`. The hook is responsible for scoping every
read it performs to `principal.tenantId` / `principal.userId` — the framework
cannot enforce isolation on queries it does not own. When no hook is registered
the `app` key is omitted.

## Account data deletion

The server always mounts an authenticated self-service deletion route at
`DELETE /account` (with `POST /account` accepted as an alias for clients that
cannot send a body-less `DELETE`). Like the export, this is the data-subject
"delete my own data" surface — the calling principal erasing their **own**
account — distinct from the operator-driven `/_frick/admin/data-subject` erase.
The route is gated by the standard protected-path authentication, so a request
without a valid session token returns `401`.

The framework default removes, scoped to the calling principal's tenant only:

- every object record the principal owns — across every object type in the
  active schema — matched on the same `DEFAULT_OWNER_FIELDS`
  (`ownerId` / `userId` / `createdBy`) ownership convention the export uses
  (override via `AccountDeleteOptions`);
- every session row for the principal in that tenant (the caller's own session
  included, so the token stops authenticating immediately and any live gateway
  connection for it is closed); and
- the principal's `auth_accounts` row.

Tenant isolation is enforced by the tenant-scoped store, so a record from
another tenant is never touched — not even a cross-tenant record whose owner
field happens to equal the caller's `userId`. The response sets
`cache-control: no-store` and reports what was removed:

```jsonc
{
  "ok": true,
  "tenantId": "_default",
  "userId": "user-ada",
  "deletedAt": "2026-05-30T12:00:00.000Z",
  "accountDeleted": true,
  "deletedSessions": 1,
  "deletedObjects": { "<ObjectType>": 0 }
}
```

The deletion is idempotent at the storage layer, but once the account row is
gone the session no longer authenticates, so a second call returns `401`.

App augmentation: pass `onAccountDelete(principal, result)` to
`createFrickServer` to cascade app-specific deletion (stream history, blob
content, derived projections, third-party records). It runs **after** the
framework default has committed, receives the framework's result (so it can read
the counts), and is responsible for scoping its own deletes to
`principal.tenantId` / `principal.userId` — the framework cannot enforce
isolation on tables it does not own. A throw from the hook surfaces as an
`account_delete_rejected` error after the framework data is already gone, so keep
cascades idempotent.

Every deletion appends an `account.delete` row to the admin audit hash chain
(target = the deleted `userId`, detail = tenant + removed counts), giving an
operator a tamper-evident record of data-subject deletions. Retention policies
(soft-delete windows, legal-hold) are out of scope here — a deletion is
immediate and hard.

## Moving an account between tenants

The authenticated admin route `POST /_frick/admin/accounts/move` reassigns an
account from one tenant to another (FR-39). It is admin-only (standard
`/_frick/admin/*` bearer auth — a request without the admin token returns `401`),
tenant-scoped, and audited.

Request body:

```jsonc
{
  "userId": "user-ada",        // required — the stable principal id to move
  "fromTenantId": "tenant-old", // the account's current tenant (defaults to _default)
  "toTenantId": "tenant-new"    // required — the destination tenant
}
```

On success the route returns `200`:

```jsonc
{
  "userId": "user-ada",
  "fromTenantId": "tenant-old",
  "toTenantId": "tenant-new",
  "moved": true,
  "revoked": 1,        // old-tenant session rows deleted
  "disconnected": 0    // live sockets dropped
}
```

What the route does, in order:

1. **Verifies the target tenant exists** via `ensureTenantAllowed`. A non-default
   `toTenantId` must already be in the tenants ledger; if implicit tenant
   creation is disabled and the tenant is unknown (or archived) the request is
   rejected with `403` (`auth.forbidden`, `reason: "unknownTenant"`).
2. **Moves the account identity row** — updates `auth_accounts.tenant_id` in
   place. `user_id`, handle, display name, and password hash are preserved.
   - `404` (`reason: "accountNotFound"`) when no account exists for
     `(fromTenantId, userId)`.
   - `409` (`storage.conflict`, `reason: "handleExists"`) when the target tenant
     already has an account with the same handle (case-insensitive) or `userId`.
3. **Revokes the account's old-tenant sessions** — deletes every session row
   bound to `fromTenantId` and live-disconnects any open WebSocket, so the user
   must re-authenticate to obtain a session in the new tenant.
4. **Appends an `accounts.move` row** to the admin-audit hash chain
   (target = `fromTenantId/userId`, detail = from/to tenant, userId, and the
   revoked/disconnected counts).

**Data boundary — important.** This route moves the account *identity* only. The
account's per-tenant DATA in the object and stream stores is tenant-scoped and is
**NOT** migrated by this route. Objects, stream history, blobs, projections, and
any app-owned records keyed by tenant stay where they are. Re-homing that data is
a separate, deliberate migration concern: the framework cannot safely assume an
account's old-tenant rows should follow it (the destination tenant may already
have conflicting data, and cross-tenant copies can violate isolation invariants).
Plan and execute any data move explicitly, out of band, after the identity move.

## Outbound email

> **Not yet ported.** The outbound-email surface below describes the prior
> TypeScript server and is not yet implemented in the Rust `frick-server`. It is
> retained here as the target contract; treat it as follow-up work.

Frick ships a pluggable outbound email surface that mirrors the push-adapter
convention: the framework defines the `FrickEmailAdapter` interface, apps
register an implementation, and the framework's identity flows dispatch through
it. Credential-bearing provider SDKs stay out of the core bundle.

Public exports from `@fricken/server`:

- `FrickEmailAdapter`, `FrickEmailMessage`, `FrickEmailDelivery`, and
  `FrickEmailContext` — the adapter interface and its message/result shapes. An
  adapter implements `send(message, ctx)` and returns a `FrickEmailDelivery`
  (`status: "delivered" | "failed"`, optional `receiptId`, structured `error`).
- `createFrickResendEmailAdapter(options?)` — the Resend reference adapter. It
  POSTs to the Resend v1 `/emails` endpoint with a bearer token; `apiKey`
  defaults to `RESEND_API_KEY`. HTTP failures map to structured codes
  (`email.unauthorized`, `email.rateLimited`, `email.serverError`,
  `email.invalidRequest`, `email.networkError`) rather than throwing. Also
  importable from the `@fricken/server/email/resend-adapter` subpath, matching
  `@fricken/server/push/apns-adapter`.
- `createFrickTestEmailAdapter()` — an in-memory adapter that records every
  send and always succeeds. Use it in tests to assert what the framework
  dispatched.
- `createFrickEmailRouter(options)` — wraps an adapter with the framework's
  common concerns: provider exceptions become `adapter.threw` failures, and
  every attempt is logged and recorded in the DevTools event feed
  (`frick.email.delivery`) with the recipient local-part redacted. Exposes
  `send`, `sendVerificationEmail`, and `sendPasswordResetEmail` helpers.

Wire it into the email/password identity flows via
`identityProviders.email.outbound`:

```ts
import { createFrickServer } from "@fricken/server";
import { createFrickResendEmailAdapter } from "@fricken/server/email/resend-adapter";

createFrickServer({
  identityProviders: {
    email: {
      outbound: {
        adapter: createFrickResendEmailAdapter(), // reads RESEND_API_KEY
        defaultFrom: "noreply@yourapp.com",
        appName: "Your App",
        // App composes the link — only the app knows its host + screen paths.
        resetUrl: ({ token }) => `https://yourapp.com/reset?token=${token}`,
        welcome: {}, // optional first-sign-in welcome email; supply body/subject to customize
      },
    },
  },
});
```

With `outbound` set, the framework dispatches the templated password-reset
email on `/auth/email/forgot-password` (only when `resetUrl` is provided and the
email maps to a real account) and a welcome email on `/auth/email/signup` (when
`welcome` is set). Sends are best-effort: a failed delivery is logged and
audited but never fails the originating auth request. Apps that want completely
custom email content can build a `FrickEmailRouter` themselves and call its
`send(...)` with their own `FrickEmailMessage`, or keep using the
`onPasswordResetRequested` hook (which still fires alongside the framework send).

Today the framework ships only the Resend reference adapter and the in-memory
test adapter; other providers (SES, Postmark, SMTP) are implemented out-of-tree
against the same `FrickEmailAdapter` interface.

## Health vs. ready

There are two unauthenticated endpoints for orchestrators:

- `GET /health` returns `200 { ok: true, status: "ok", service: "frick-server" }`
  as soon as the process has bound a port. It does not touch the database.
  Wire it to a liveness probe.
- `GET /ready` returns `200 { status: "ready", schemaId, schemaRevision,
  schemaHash, appliedMigrations }` once the migration runner has finished
  AND a `SELECT 1` against the database succeeds. Otherwise it returns
  `503 { status: "not-ready", reason, ... }`. Wire it to a readiness probe
  and gate traffic on it.

A Kubernetes example:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 4099 }
  initialDelaySeconds: 2
readinessProbe:
  httpGet: { path: /ready, port: 4099 }
  initialDelaySeconds: 1
  periodSeconds: 5
```

## Inspection routes

When `inspectionEnabled` is true (the default outside production), the
server exposes these GET endpoints under `/_frick/inspect/`:

- `/_frick/inspect/server` — `{ schemaId, schemaVersion, schemaRevision,
  schemaHash, appId, env, demoAuthEnabled, inspectionEnabled, startedAt }`.
- `/_frick/inspect/apps` — `{ apps: [{ id, basePath, schemaId,
  schemaRevision }, ...] }` for multi-app server routing checks.
- `/_frick/inspect/migrations` — `{ applied: [{ id, schemaRevision,
  appliedAt, checksum, durationMs }, ...] }` read from the
  `frick_migrations` ledger.
- `/_frick/inspect/db` — `{ ready, applied, lastApplied?, idempotencyCache }`.
- `/_frick/inspect/jobs` — `{ registeredHandlers, counts, workerEnabled }`.
- `/_frick/inspect/projections` — registered projection names, sources,
  and whether each projection supports rebuild/read handlers.
- `/_frick/inspect/search` — active search adapter id plus registered
  index names and sources.
- `/_frick/inspect/metrics` — `{ snapshotAt, uptimeSeconds, counters, gauges }`.
  Returns a JSON snapshot of in-process counters and gauges. Counter names
  include `frick.http.requests.total{method,status}`,
  `frick.http.errors.total{code}`, and `frick.ws.frames.total{kind}`. Gauges
  include `frick.ws.connections.current`. No retention or historical
  aggregation — scrape periodically to integrate with a metrics backend. When
  OTel is enabled, the server also exports HTTP request spans, WebSocket
  connection spans, job-run spans, and request/WebSocket/job metrics through
  OTLP:
  `frick.http.server.requests{method,status}`,
  `frick.http.server.duration_ms{method,status}`,
  `frick.ws.connections.current{authenticated}`,
  `frick.ws.frames.total{kind}`,
  `frick.ws.frame.bytes{kind}`,
  `frick.ws.connection.duration_ms{authenticated}`,
  `frick.jobs.runs.total{jobType,status}`, and
  `frick.jobs.run.duration_ms{jobType,status}`. WebSocket frame `kind` is
  bounded to known protocol names or `unknown`; close telemetry records the
  close code and a bounded category, not raw close text. Tenant/user ids are
  span attributes, not metric labels. Keep job type names low-cardinality and
  registry-defined. The in-process inspection snapshot remains available for
  local dashboard panels and simple health checks.
- `/_frick/inspect/platform-events` — platform event pipeline health:
  `{ adapter, ok, pending, claimed, deadLettered, retained, unclaimed,
  consumers }`. The default adapter is SQLite, with bounded retention and
  row-cap pruning controlled by the platform event env vars above.
- `/_frick/inspect/analytics/summary?windowMs=86400000` — authenticated,
  tenant-scoped product analytics summary derived from the same materialized
  read model as the mounted dashboard API. The response includes event totals,
  unique users, top event names, top viewed routes, and recent event metadata.
- `/_frick/inspect/devtools/events` — newest-first DevTools event feed with
  optional `kind`, `tenantId`, `sinceId`, and `limit` filters.
- `/_frick/inspect/devtools/events/:id` — one DevTools event by numeric id.
- `/_frick/inspect/devtools/summary?windowMs=60000` — event counts by kind
  over a rolling window.

The `idempotencyCache` object reports the in-memory front cache state —
`size` (currently held entries), `capacity` (configured maximum), and
`evictions` (cumulative count since process start). Tune the capacity
with `createFrickServer({ idempotencyCacheCapacity })`. Default 10,000.
The durable `idempotency_keys` SQLite table is separately bounded (see
retention slice).

For local development, `frick dashboard` serves Fricken Dashboard at
`http://127.0.0.1:4299` by default. In the monorepo, run
`cargo run -p frick-cli -- dashboard`. It is a
static console that reads `/health`, `/ready`, and the authenticated
`/_frick/inspect/*` endpoints from the configured Frick HTTP server. Use
`--endpoint <url>` to point it at another server, and use its Dev Login flow or
paste a bearer token before opening inspection-backed panels. Standalone mode
loads platform-event health from `/_frick/inspect/platform-events` and product
analytics from `/_frick/inspect/analytics/summary`, so local dashboard views
work without mounting the dashboard into the server process.

For production deployments, the Frick server can mount Fricken Dashboard at
`/_frick/dashboard`. Mounted mode is the preferred production shape because the
dashboard shares the server origin and security headers. Static dashboard
assets contain no sensitive data and may be served without auth; data-bearing
dashboard APIs under `/_frick/dashboard/api/*` require auth. In production,
those APIs require the configured admin bearer until the dashboard capability
system lands. In development, a valid session bearer from `/auth/dev-login` can
read the dashboard APIs. `/_frick/dashboard/api/platform-events/health`
returns the same platform-event health payload as the inspection route.
`/_frick/dashboard/api/analytics/summary?windowMs=86400000` returns a
tenant-scoped product analytics summary derived from retained
`analytics.user_event` platform events, including event totals, unique users,
top event names, top viewed routes, and recent event metadata. Tenant session
principals only see their session tenant; production admin bearers see the
project-wide summary. The server's analytics aggregate consumer materializes
those events into local analytics read-model tables, so the summary endpoint
works with both the default SQLite platform-event adapter and the Kafka/Redpanda
adapter.

`/_frick/dashboard/api/data/objects/:type?limit=50&tenantId=_default` returns
read-only schema object rows for the mounted dashboard data browser. Tenant
session principals are pinned to their session tenant and use the same
object-visibility filter as sync snapshots; admin bearers may pass `tenantId`
to inspect a tenant's rows directly. The endpoint validates `:type` against the
active schema and caps `limit` at 200 rows. Field values are redacted by their
schema-declared sensitivity classification before being returned: fields marked
`pii`, `secret`, or `content` are replaced with `"<redacted>"`, while `public`
and (the default) `private` values pass through. Annotate fields with
`sensitivity` in the schema to keep sensitive values out of inspection output.

`/_frick/dashboard/api/accounts?limit=50&tenantId=_default` returns sanitized
account rows for the mounted dashboard Auth view: `tenantId`, `userId`,
`handle`, `displayName`, and `createdAt`. Password hashes, password salts,
session tokens, devices, and rate-limit state are never included. Tenant
session principals are pinned to their session tenant; admin bearers may pass
`tenantId` to inspect a tenant account directory. The endpoint caps `limit` at
200 rows and reports whether additional rows were truncated.

`/_frick/dashboard/api/jobs?limit=50&tenantId=_default&status=ready&jobType=blob.process`
returns sanitized background-job rows for the mounted dashboard Jobs view:
`id`, `tenantId`, `jobType`, `status`, attempt counters, lifecycle timestamps,
and `lastErrorCode`. Tenant session principals are pinned to their session
tenant; admin bearers may pass `tenantId`, `status`, and `jobType` filters. The
endpoint caps `limit` at 200 rows, reports truncation, and never returns job
payloads, completed results, idempotency keys, worker ids, or last error
messages.

`/_frick/dashboard/api/blobs?limit=50&tenantId=_default&ownerId=user-ada`
returns read-only blob metadata for the mounted dashboard Storage view:
`tenantId`, `blobId`, `ownerId`, `contentHash`, `byteLength`, `mimeType`, and
`createdAt`, plus a derivative summary with derivative count, total derivative
bytes, processor ids, MIME types, latest derivative timestamp, and whether any
derivative metadata exists. Tenant session principals are pinned to their
session tenant and own user id, even if query parameters request another tenant
or owner. Admin bearers may pass `tenantId` and `ownerId` to inspect a tenant's
storage metadata. The endpoint caps `limit` at 200 rows, reports truncation,
and never returns blob content bytes, derivative content bytes, storage keys,
or raw derivative metadata.

`/_frick/dashboard/api/tenants?includeArchived=true&limit=50` returns the
tenant ledger rows used by the mounted dashboard Settings view: `tenantId`,
optional `displayName`, `createdAt`, and optional `archivedAt`. Tenant session
principals only receive their session tenant row; admin bearers receive the
active tenant directory by default and may pass `includeArchived=true` to see
soft-archived tenants. The endpoint caps `limit` at 200 rows and never includes
tenant settings or encrypted credential material.

`/_frick/dashboard/api/tenant-settings?tenantId=_default` returns a sanitized
tenant settings summary for the mounted dashboard Settings view. Tenant session
principals are pinned to their session tenant; admin bearers may pass
`tenantId` to inspect another tenant. The response includes validated
per-tenant `limits`, optional `retentionMs`, push credential configured/not
configured flags for APNs, FCM, and Web Push, plus stored setting key names.
Encrypted push credential values and unknown setting values are never returned.

The platform event pipeline defaults to SQLite for local and lightweight
deployments. Set `FRICK_PLATFORM_EVENTS_DRIVER=kafka` with
`FRICK_PLATFORM_EVENTS_KAFKA_BROKERS=host:9092` to use the built-in
KafkaJS adapter against Redpanda or Kafka. The Kafka adapter connects lazily
on first publish or claim so server construction remains synchronous. This
baseline commits only contiguous terminal offsets on `ack`, republishes
retried events to the broker, and publishes poison messages to `<topic>.dlq`.
The job worker publishes initial `jobs.lifecycle` events for completed,
retryable failed, and dead-lettered jobs; downstream consumers can claim those
events from the same adapter as analytics and telemetry events. SQLite claims
use a five-minute visibility lease; if a consumer crashes after claiming but
before `ack`, `retry`, or `deadLetter`, the same consumer name can reclaim that
event after the lease expires and the delivery attempt count increments.
The built-in analytics aggregate consumer uses consumer name
`frick.analytics.aggregates` and is enabled by default outside test runners.
Tests and embedded runtimes can use `createFrickServer({ analytics: {
workerEnabled: false } })` or tune `pollIntervalMs` / `claimBatchSize`.
Terminal actions are matched against the delivery's `attempt` and `claimedAt`
values so an expired attempt cannot acknowledge, retry, or dead-letter a newer
claim.
Per-consumer health lag is still process-local, and idempotency is enforced by
the active adapter process after it has published or consumed a matching event;
cross-process and post-restart Kafka idempotency require a durable key index in
a follow-up hardening pass.

Product analytics enters through the same pipeline. Authenticated clients can
`POST /analytics/events` with a JSON body containing `name`, optional
`properties`, optional `context`, optional `attributes`, optional `traceId`,
optional `idempotencyKey`, and optional canonical ISO `occurredAt`. The server
derives `tenantId`, `subjectId`, `deviceId`, and `replicaId` from the active
session; clients cannot spoof those identity fields. Accepted events publish as
`analytics.user_event` with source `frick.analytics.ingest` and return
`202 { ok, eventId, sequence, acceptedAt, duplicate }`. The TypeScript SDK
wraps this route as `trackAnalyticsEvent(...)`, `FrickClient.track(...)`, and
`useTrackAnalyticsEvent()`; Swift and Android/Kotlin expose the same
authenticated `FrickClient.track(...)` semantics and receipt shape. React
browser apps using `<FrickProvider>` record automatic route analytics by
default after a session token is available; pass `autoAnalytics={false}` to
opt out. The tracker tears down its history listeners on unmount. Default route
properties include only `path` and document `title`; apps must provide
`routeProperties` explicitly to include query strings, hash fragments, or full
URLs.
The TypeScript client also includes an OpenTelemetry API bridge by default:
analytics posts emit `frick.analytics.track` spans plus
`frick.client.analytics.events.total{status}` and
`frick.client.analytics.duration_ms{status}` metrics, and sync sockets emit
`WebSocket /_frick/sync` client spans plus
`frick.client.ws.frames.sent.total{kind}`,
`frick.client.ws.frames.received.total{kind}`, and
`frick.client.ws.connection.duration_ms{closeCategory}`. The bridge is a no-op
until the host app installs an OTel provider; pass `telemetry: false` to
`FrickClient` to disable it, or `setDefaultClientTelemetryRuntime(...)` to
replace the default for standalone helpers. Frame labels are bounded to known
protocol names or `unknown`, close telemetry records a bounded category rather
than raw close text, and the default analytics header injection sends only
`traceparent`.
Swift and Android/Kotlin expose dependency-light `FrickClientTelemetryRuntime`
hooks for analytics `track` calls with the same analytics span and metric
names, trace-id body correlation, and optional `traceparent` injection from a
host-provided telemetry runtime. They do not bundle or initialize native OTel
SDKs, and native sync socket telemetry is still pending.

For agents that need live runtime context, `frick mcp` runs a stdio MCP server
owned by the same CLI. It defaults to read-only and exposes documented health,
readiness, inspection, stream-read, job, schema, and structured-error
explanation resources/tools.

```
frick mcp --endpoint http://127.0.0.1:4099
frick mcp --print-config --endpoint http://127.0.0.1:4099
```

Mutating MCP tools are hidden unless `--allow-writes` is provided, and those
writes must still pass normal Frick auth, tenant isolation, schema
compatibility, and policy checks. Do not expose raw SQL or private storage
internals through MCP.

When inspection is disabled (production default), every path under
`/_frick/inspect/` returns `404` — its existence is not advertised. To
opt back in for an on-call session, set `FRICK_INSPECTION_ENABLED=true`.
A startup warning is logged when that override is active in production.

Inspection routes require authentication. Outside production, callers must
send a valid session bearer or `x-frick-session-token` header. In
production, callers must send the configured admin bearer token. The
`sessionToken` query parameter is not accepted for HTTP inspection routes.

## Graceful shutdown

The running server exposes a `close()` (graceful shutdown) that:

1. Signals axum's graceful-shutdown future, which stops accepting new
   connections and lets in-flight requests and the WebSocket gateway drain.
2. Awaits the serve loop to finish.
3. Detaches the store's write-listener funnel so the store no longer holds the
   gateway's broadcast closure.
4. Logs `frick.server.closed`.

`close()` is idempotent — after the first call the shutdown channel and serve
handle are taken, so repeated calls are no-ops.

A typical signal-handling pattern in a host wrapper awaits a `SIGINT`/`SIGTERM`
signal (e.g. via `tokio::signal`) and then calls `server.close().await` before
exiting.

## Startup log line

When `listen()` resolves, the server emits a single structured log
record on the `frick.server` target with the event name
`frick.server.listen` and the structured fields:

```
schema_id = "..."
schema_revision = 1
host = "127.0.0.1"
port = 4099
env = "development"
```

## Per-request log line

Every HTTP request emits one `frick.http.request` log line with
`requestId`, `method`, `path`, `status`, `durationMs`, and (when the
request resolves a principal) `tenantId` and `userId`. The
`Authorization` header and any field named `sessionToken`, `password`,
or `passwordHash` are redacted before emission. Set
`FRICK_LOG_LEVEL=info` (the default) or higher to see them.

## Projection delta push

Apps register projections at boot via `ServerOptions.projections`
(`createFrickServer({ projections: [...] })`). Each projection declares one
or more `sources` (object or stream types); at startup the server validates
that every declared source `type` exists in the active schema and throws a
`FrickConfigError` otherwise, so a typo surfaces at boot rather than
silently never matching a write. Projections are also exposed for HTTP read
at `GET /projections/:name` when the handler implements `read`.

A projection's `apply(event, ctx)` runs after every matching source write —
object upserts (HTTP `PUT /objects/...` or the WebSocket `ObjectUpsert`
frame) and stream appends alike — and may return `{ changes }` declaring the
affected rows. The registry materializes those changes into a tenant-scoped
row map so later subscribers can be replayed the current state.

Clients subscribe over the sync WebSocket with kind `"projection"` and the
projection's registered name (the optional `key` is reserved for future
per-row scoping and is ignored today). On subscribe the server delivers an
**initial snapshot** — a `ProjectionDelta` frame whose changes upsert every
current row for the subscriber's tenant (empty when the projection has no
rows yet) — and thereafter pushes a `ProjectionDelta` frame on each new
`apply` change. Both the snapshot and live deltas are scoped to the
subscriber's tenant, so a client never sees another tenant's rows.
Subscribing to an unknown projection nacks with `auth.forbidden` +
`details.reason = "projectionNotFound"`.

Fan-out is in-process by default; when a cluster bus is configured the
gateway also forwards each delta to peer nodes (`projectionDelta`
envelopes) so subscribers on any node receive it. The materialized snapshot
state is per-node and not persisted — it is rebuilt from `apply` changes as
writes flow, and a `projections/:name/rebuild` admin call re-derives a
projection's state from source data.

## Server-originated object and stream live push

Object upserts, object deletes, and stream appends are live-pushed to
already-subscribed sync clients **regardless of which caller drove the write**.
Whether a write arrives as a client WebSocket `ObjectUpsert`/`Append` frame, an
HTTP `PUT /objects/...` / `DELETE /objects/...` / append request, or a
server-side caller invoking `store.upsertObject`,
`store.upsertObjectWithPolicy`, `store.deleteObject`, or `store.appendEvent`
directly (a background job or an app command route), the subscriber receives
the same `Delta` frame.

This is wired through a single broadcast funnel. The store fires a write-change
notification on every successful object upsert, object delete, and stream
append; the sync gateway is the sole consumer of that notification and fans the
change out to matching subscribers. Delete deltas carry both a back-compat
tombstone object record and `removed: [{ type, id }]`. The gateway no longer
broadcasts inline from its frame handlers or the HTTP routes — so a single
write produces exactly one delta per subscriber, never a duplicate. Upsert
broadcasts carry the **stored** (post-merge) object state, which is the correct
snapshot to replicate under any merge policy.

Because the funnel reuses the same publish path as before, deltas remain
tenant-scoped (a subscriber only sees writes in its own tenant) and, when a
cluster bus is configured, server-originated writes forward to peer nodes
(`objects` / `streamEvent` envelopes) with the same parity client mutations
already had. The SSE bridge is fed from the same funnel, so EventSource
subscribers also receive server-originated stream appends.

One observable nuance: a client that writes and is also subscribed receives
the canonical `Delta` for its own write. Because the broadcast fires inside the
store write, that `Delta` may arrive **before** the write's `Ack`. The two are
independent on the client (the delta updates the cache, the ack clears the
pending write), so ordering is not contractual and convergence is unaffected.

## Backup and restore

The framework ships a portable dump/restore format. Use it for offline
migrations, pre-deploy snapshots, and copying data between environments.
The format is independent of the underlying driver. SQLite is the active
runtime store today; the standalone Postgres schema/migration runner is in
place, and the Postgres store adapter will produce dumps in the same shape once
the runtime store port lands.

### Format

Dumps are newline-delimited JSON (NDJSON). The first line is a header:

```json
{ "type": "header", "row": {
    "frickFormat": 1,
    "createdAt": "2026-05-11T00:00:00.000Z",
    "schemaId": "frick-foundation",
    "schemaVersion": "0.1.0",
    "schemaRevision": 1,
    "schemaHash": "<sha-256>",
    "appliedMigrations": ["0001_objects", "..."],
    "tenantId": "_default"
} }
```

Every subsequent line is `{ "type": "<table>", "row": { ... } }`. The
`row` shape matches the SQL column layout; binary columns are
base64-encoded under a sibling `<col>_base64` key.

When `FRICK_BLOB_DRIVER=filesystem` is selected, blob metadata is still dumped
from SQLite but the blob byte files under `FRICK_BLOB_STORAGE_PATH` are not yet
included in the NDJSON stream. Back up and restore that directory alongside the
database until filesystem/object-storage byte export lands.

The `tenantId` field is either a specific tenant (per-tenant dump) or
`"all"` (whole-database dump). Per-tenant dumps filter rows where
`tenant_id = <chosen>` and skip framework infra (admin audit log,
migration ledger). Whole-database dumps include both.

### CLI

```
frick backup [--tenant-id <id>|all] [--output <path>] [--db-path <path>]
frick restore --input <path> --confirm yes \
              [--tenant-id <id>] [--overwrite] [--force-schema-drift] \
              [--db-path <path>]
```

`frick backup` defaults to the `_default` tenant; pass `--tenant-id all`
for the whole database. Output goes to stdout unless `--output` is
given. `frick restore` requires `--confirm yes` for safety and refuses
against a production-mode config unless `FRICK_RESTORE_ALLOW_PROD=1`.

### HTTP admin

When `adminEnabled` is on:

- `POST /_frick/admin/backup` (body `{ "tenantId"?: string }`) streams
  NDJSON in the response body.
- `POST /_frick/admin/restore?confirm=yes` (body: raw NDJSON) replays
  the dump and returns a `FrickRestoreReport` JSON. Refused in
  production mode with `auth.forbidden` and
  `details.reason: "restoreNotAllowedInProduction"`.
- `POST /_frick/admin/sessions/revoke` proactively revokes sessions so
  operators no longer delete `auth_sessions` rows by hand. Body is either
  `{ "userId": "...", "tenantId"?: "..." }` (every session for that user,
  optionally scoped to one tenant) or `{ "sessionToken": "..." }` (a single
  session). It deletes the matching rows — blocking future requests — and
  live-disconnects any currently-connected WebSocket for those sessions with
  close code `1008` so a revoked client can't keep streaming on an
  already-open socket. Returns `{ "revoked": <rows>, "disconnected": <conns> }`.
  A request naming neither target returns `400 sync.protocolError`. Audit-logged
  as `sessions.revoke`.

Separately, **expired** `auth_sessions` rows are now swept automatically. They
were always filtered out on read, but nothing deleted them, so the table grew
unbounded. The store runs an expired-session prune once at startup and then on a
15-minute background timer (alongside the `idempotency_keys`, `devtools_events`,
and `platform_events` prune passes). A session is eligible the moment it expires;
embedders can keep a forensics grace window via
`createFrickServer({ expiredSessionRetentionGraceMs })` or disable the timer with
`expiredSessionPruneIntervalMs: 0` (the one-shot at startup still runs).

#### Configuring retention windows

The retention windows for the growth-prone, auto-pruned tables are configurable
from the environment (or `createFrickServer`/`loadFrickConfig` overrides). The
prune mechanics are unchanged — these knobs only move the windows. Leaving every
variable unset reproduces the historical defaults exactly, so this is purely
additive.

| Table | Env var | Default | Notes |
| ----- | ------- | ------- | ----- |
| `idempotency_keys` | `FRICK_IDEMPOTENCY_KEY_RETENTION_MS` | 24h | Durable cleanup window. Distinct from the lookup-time `FRICK_IDEMPOTENCY_REPLAY_WINDOW_MS`. Per-tenant `retentionMs` settings still take precedence. |
| `devtools_events` | `FRICK_DEVTOOLS_EVENTS_RETENTION_MS` | 1h | DevTools event feed. |
| `platform_events` | `FRICK_PLATFORM_EVENTS_RETENTION_MS` | 7d | SQLite platform-event pipeline (also bounded by `FRICK_PLATFORM_EVENTS_MAX_ROWS`). |
| `auth_sessions` (expired) | `FRICK_EXPIRED_SESSION_RETENTION_GRACE_MS` | 0 | Grace before an expired session row is deleted. |

Per-stream retention (FR-145) remains opt-in and is configured separately via
`createFrickServer({ streamRetention })`, keyed by stream type.

Both routes audit-log under `backup.dump` and `backup.restore`. These
backup and restore audit writes are fail-closed: if the audit row cannot be
recorded, the admin action is rejected instead of silently continuing.
The same fail-closed policy applies to sensitive admin mutations for tenant
creation, tenant setting writes, account creation, job enqueue, search
rebuild, and projection rebuild. Rebuild routes record the allow intent
before starting work because rebuild side effects are not rollbackable.

### Schema drift and migration parity

Restore compares the source header's `schemaHash` to the target's. A
mismatch is refused unless `--force-schema-drift` (or
`?forceSchemaDrift=true` over HTTP) is passed. The target's applied
migrations must be a superset of the source's, otherwise restore
refuses with `missingMigrations`. Run `frick migrate up` against the
target first when restoring a dump from an older deployment.

### Failure handling

Rows that fail to insert (foreign-key violations, duplicate ids,
unknown table types, parse errors) are reported in the `skipped` array
of the returned report; restore keeps going. This lets operators
inspect what didn't make it without aborting the entire restore.

## Multi-app servers

`createFrickServer({ apps })` mounts multiple Frick schemas on the same
process — each app is `{ id, schema, basePath }`. HTTP requests resolve to
the app whose `basePath` is the longest prefix of the URL (e.g.
`GET /chat/schema` returns the `chat` app's schema). WebSocket clients
self-identify via the schemaId they advertise in the Hello frame; the
gateway routes the connection to the matching app's schema for
compatibility checking and HelloAck. `/_frick/inspect/apps` lists every
registered app and is gated by `inspectionEnabled`. Duplicate `basePath`
throws `FrickConfigError` at construction. App routing is a request/protocol
boundary plus a storage partition: framework tables for objects, streams,
presence, signals, blobs, jobs, sessions, accounts, and tenant settings carry
`app_id`, and per-app projection/job registries are active when app configs are
supplied. Keep mutually-untrusted apps separated operationally until your
deployment has reviewed the remaining admin/inspection and product-governance
surfaces for shared-process hosting.

## Schema lint

Use `frick lint` to validate the current foundation schema (`frick lint`)
or to diff it against a previous snapshot (`frick lint --against ./prev.json`).
Findings are JSON Lines with a stable `ruleId` (e.g. `object.removed`,
`field.required.added`) so CI can filter or suppress rules without parsing
free-form messages; the CLI exits 1 when any finding has severity
`breaking`. The same linter is available over HTTP at
`POST /_frick/admin/schema/lint` (admin-only, audit-logged as
`schema.lint`); the body is `{ previous?: FrickSchema }` and the response
is `{ findings, breakingCount }`.

## Configuring push credentials

Frick encrypts per-tenant push credentials at rest using AES-256-GCM. Set
`FRICK_PUSH_CRED_KEY` to a base64-encoded 32-byte random value before
starting the server. All credential operations fail with
`push.credentials.disabled` when this variable is unset or malformed.

```bash
# Generate a key (one-time, keep secret, back up to a secrets manager)
openssl rand -base64 32
```

Rotation requires re-saving every tenant's credentials with the new key;
there is no multi-key decryption in v1.

### APNs (Apple Push Notification service)

1. In App Store Connect, go to Keys and create an APNs auth key. Download
   `AuthKey_<keyId>.p8`.
2. Note your Team ID (10-character alphanumeric string visible under
   Membership).
3. PUT the credentials to the admin route:

```http
PUT /_frick/admin/tenants/<tenantId>/push/apns
Authorization: Bearer <adminToken>
Content-Type: application/json

{
  "keyId": "<keyId from filename>",
  "teamId": "<10-char Team ID>",
  "bundleId": "com.example.app",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
  "useSandbox": true
}
```

Use `"useSandbox": true` for development builds (targets
`api.sandbox.push.apple.com`). Omit or set `false` for production.

The server returns `204 No Content` on success, `400` with
`{ "error": "push.credentials.disabled" }` when `FRICK_PUSH_CRED_KEY` is
unset, or `400` when required fields are missing.

4. Register the adapter at server boot:

```ts
import { createFrickApnsAdapter } from "@fricken/server";

const server = createFrickServer({
  push: {
    adapters: [createFrickApnsAdapter()],
  },
});
```

### FCM (Firebase Cloud Messaging)

Download a service-account JSON from the Google Cloud Console and PUT it:

```http
PUT /_frick/admin/tenants/<tenantId>/push/fcm
Authorization: Bearer <adminToken>
Content-Type: application/json

{
  "projectId": "<project-id>",
  "clientEmail": "<service-account-email>",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
}
```

### Web Push (VAPID)

Generate a VAPID keypair and PUT the base64url-encoded keys:

```http
PUT /_frick/admin/tenants/<tenantId>/push/webpush
Authorization: Bearer <adminToken>
Content-Type: application/json

{
  "subject": "mailto:ops@example.com",
  "publicKey": "<base64url VAPID public key>",
  "privateKey": "<base64url VAPID private key>"
}
```

## Known gaps

- CORS is enforced for HTTP preflight requests and WebSocket upgrades.
  Same-origin and server-to-server requests with no `Origin` header bypass
  CORS by browser convention. Allowlist entries support `*` (allow all),
  exact origins, and single subdomain wildcards (`<scheme>://*.<host>`);
  regex, path/port patterns, and multi-segment wildcards are not supported.
- The CLI is the `frick-cli` crate; run it in the monorepo with
  `cargo run -p frick-cli -- <command>`. Packaging and distributing a
  standalone `frick` binary is a release-surface follow-up. The CLI's
  `verify`/`backup`/`restore` commands are listed for parity but currently
  return `cli.unsupported`.
- Blob bytes default to SQLite (`FRICK_BLOB_DRIVER=sqlite`, the `blob_content`
  table). Set `FRICK_BLOB_DRIVER=filesystem` with a writable
  `FRICK_BLOB_STORAGE_PATH` to store bytes on the local filesystem, or
  `FRICK_BLOB_DRIVER=s3` with `FRICK_BLOB_S3_BUCKET` to store bytes in an
  S3-compatible object store. Blob metadata stays in SQLite under every driver.
  External blob byte stores are not yet included in NDJSON backup/restore or
  account export payloads, so operators must back up the filesystem path or
  bucket separately. Byte export and derivative offloading are follow-ups.
- Outbound email ships the Resend reference adapter and an in-memory test
  adapter only (see "Outbound email"). Other providers (SES, Postmark, SMTP)
  are implemented out-of-tree against the exported `FrickEmailAdapter`
  interface.
