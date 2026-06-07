# Current Status

Frick is pre-1.0. The framework has a working schema-driven sync server, TypeScript runtime, React bindings, Swift SDK, Android/Kotlin SDK, design-token packages, DevTools, MCP runtime inspection, Agent Kit guidance surfaces, CLI, and demo apps / harnesses. The public contract is still hardening, so storage layout, route details, and package surfaces can change before a stable 1.0 release.

## Stable Enough To Build Against

- Schema identity fields (`schemaId`, `schemaVersion`, `schemaRevision`, `schemaHash`) and generated Swift/Kotlin/TypeScript artifacts.
- Shared structured error envelopes across HTTP, WebSocket nacks, and SDK error types.
- MessagePack WebSocket frames for Hello/HelloAck, subscribe, append, signal, presence, object upsert, snapshot, delta, projection delta, ack, and nack.
- SQLite-backed server persistence, migrations, health/ready/inspect/admin
  routes, backup/restore, metrics, request logging, CORS enforcement, and admin
  bearer auth. A standalone Postgres migration runner and schema parity tests
  exist, but the server runtime still constructs SQLite-backed stores.
- Documented server extension points for app-owned HTTP routes, durable job
  handlers, recurring job schedules, search indexes, blob processors, push
  adapters, policy hooks, multi-app URL/schema routing, and cluster-bus fan-out.
- Optional identity-provider server routes through
  `createFrickServer({ identityProviders })`: Apple JWT verification and
  server-to-server notifications, Google ID-token verification, email/password
  signup/login, email password reset tokens, app-owned User object mapping,
  first-sign-in hooks, and normal session minting.
- Cross-user sharing primitives for object records: owners can create
  single-use invitation tokens, recipients can accept them into durable
  read/write grants, owners can list and revoke grants, and active grants
  relax `object.read` / `object.write` authorization decisions within the
  same tenant. Grantees can leave a share, object subscriptions filter
  snapshots and live deltas per record, and read grants cascade narrowly to the
  stream/projection rows keyed by the shared record id.
- Fricken Dashboard, served locally by `frick dashboard` and mountable at
  `/_frick/dashboard`, for inspecting health, readiness, schema identity,
  schema resources, tenant-visible schema object rows, metrics, jobs,
  migrations, tenant and account directories, and DevTools events against a running
  server. Standalone mode reads platform event pipeline health and
  tenant-scoped product analytics summaries through authenticated inspection
  routes; mounted mode exposes the same product views, read-only object data,
  tenant ledger rows, sanitized tenant settings summaries, sanitized account
  rows, sanitized background-job rows, and blob metadata/derivative summary
  rows through authenticated dashboard APIs.
- TypeScript `@fricken/core` runtime and `@fricken/react` hooks for objects, streams, projections, presence, signals, auth, blobs, search, realtime wrappers, drafts, and background sync.
- First-class platform events for framework telemetry, job lifecycle events,
  and authenticated product analytics ingestion through TypeScript, Swift, and
  Android/Kotlin clients. React route analytics is enabled by default after a
  session is available, and product analytics summaries are materialized by a
  built-in platform-event consumer so SQLite and Kafka/Redpanda deployments
  share the same dashboard read model.
- Server-side OpenTelemetry export for HTTP request spans, WebSocket
  connection/frame telemetry, job-run spans, and request/WebSocket/job metrics
  with bounded WebSocket labels and sanitized close telemetry, enabled by OTLP
  env vars and included in the Redpanda local profile through the checked-in
  collector config.
- Standard image and Docker Compose deployment profiles are available through
  `frick deploy image` and `frick deploy --profile compose|lightweight`. The
  image command builds or pushes the `FRICK_SERVER_IMAGE`; the compose profile
  wires the mounted dashboard, Redpanda/Kafka platform events, and OTel
  collector around that image; the lightweight profile keeps the same server
  shape with SQLite platform events.
- TypeScript client OpenTelemetry API bridge for analytics requests and sync
  WebSocket transport metrics/spans. The bridge is active by default but is a
  no-op until the app installs an OTel provider. Swift and Android expose
  dependency-light telemetry hooks for analytics `track` calls only; they do
  not bundle native OTel SDKs, and native sync telemetry remains pending.
- Swift and Android WebSocket sync transports with capability handshake, object subscriptions/upserts, presence, packed-frame decoding, cache compatibility, and cross-device draft helpers. Swift clients can pass app schema id/revision/hash and a `FrickSchemaDescriptor` into `FrickClient`, auto-clear framework cache state when sign-in swaps users, buffer frames issued immediately after `connect()` until the WebSocket opens, replay active subscriptions after reconnect, and skip malformed rows during `fetchObjects` instead of aborting the whole fetch.

## Known Limitations

- The CLI has a standalone-buildable `@fricken/cli` package with a `frick` bin
  and publish metadata. Repository development still uses `pnpm cli <command>`;
  the npm publish workflow does not yet include `apps/cli`, so publishing the
  CLI remains release work.
- The default deploy image builds the canonical monorepo server runtime.
  Published-package and scaffolded-app image recipes are still follow-up
  release work.
- `@fricken/server` has an import-safe package entrypoint and documented export
  map for the baseline server, telemetry, project, migration/reset, cluster
  bus, and production push-adapter surfaces. Deep route/storage imports remain
  internal.
- Multi-app servers route by URL prefix and WebSocket Hello schema id, but
  storage, configured handlers, projection registries, job workers, and
  processors are still shared at the server level.
- Sharing is scoped to individual object records and same-tenant principals.
  It cascades read access only to the stream/projection rows keyed by the
  shared record id. It does not cascade to child records, blobs, jobs, search
  results, or arbitrary app routes.
- Identity-provider sessions honor the single configured
  `FRICK_SESSION_TTL_SECONDS` lifetime, and Apple/Google/OIDC verify routes plus
  email password-reset routes share the built-in auth-attempt limiter. Apple,
  Google, generic OIDC issuers (`identityProviders.oidc`, with direct
  `jwksUri` or discovery-resolved key sets), and email/password are supported;
  SAML and arbitrary non-OIDC OAuth provider routing remain unimplemented.
- Blob bytes default to SQLite but can use the local filesystem with
  `FRICK_BLOB_DRIVER=filesystem` and a writable `FRICK_BLOB_STORAGE_PATH`.
  Blob metadata remains in SQLite. Filesystem blob byte files are not yet part
  of NDJSON backup/restore or account export payloads, so operators must back
  up `FRICK_BLOB_STORAGE_PATH` separately. Object-storage/S3 drivers,
  derivative offloading, and richer lifecycle policies remain follow-up work.
- APNs, FCM, and Web Push all have documented push-adapter exports and
  `frick tenants set-push` credential workflows. Web Push encrypts payloads per
  RFC 8291 when browser subscription keys are present; multi-key credential
  rotation remains follow-up work.
- Outbound email is a documented `@fricken/server` surface (the
  `FrickEmailAdapter` interface, `createFrickEmailRouter`, the Resend reference
  adapter at `@fricken/server/email/resend-adapter`, and the in-memory test
  adapter), wired into the password-reset and first-sign-in welcome flows via
  `identityProviders.email.outbound`. Only the Resend reference adapter ships
  in-tree; SES/Postmark/SMTP providers are implemented out-of-tree against the
  same interface.
- Swift and Android package publication is configured in source, but local verification still depends on the host having Xcode or Android SDK/JDK paths installed.
- CI and Android publishing gate the framework Android modules
  (`:frick`, `:frick-compose`, `:design`). The old demo `:app` remains in the
  workspace and in the stricter local `pnpm android:build` script, but it is
  excluded from CI/publish while it is rebuilt around the current SDK surface.
- Internal specs and plans are historical. They explain why slices happened, not necessarily what is true now.

## Current Local Quality Gate

For TypeScript/server/CLI/web changes, run:

```bash
pnpm test
pnpm typecheck
pnpm verify:generated   # schema DTOs, protocol fixtures, and design tokens
```

For native changes, also run the relevant native check:

```bash
pnpm swift:test
pnpm android:build   # strict local check; CI/publish run the SDK/design module subset
```
