# Current Status

Frick is pre-1.0. The framework has a working schema-driven sync server, TypeScript runtime, React bindings, Swift SDK, Android/Kotlin SDK, design-token packages, CLI, and demo apps. The public contract is still hardening, so storage layout, route details, and package surfaces can change before a stable 1.0 release.

## Stable Enough To Build Against

- Schema identity fields (`schemaId`, `schemaVersion`, `schemaRevision`, `schemaHash`) and generated Swift/Kotlin/TypeScript artifacts.
- Shared structured error envelopes across HTTP, WebSocket nacks, and SDK error types.
- MessagePack WebSocket frames for Hello/HelloAck, subscribe, append, signal, presence, object upsert, snapshot, delta, projection delta, ack, and nack.
- SQLite-backed server persistence, migrations, health/ready/inspect/admin routes, backup/restore, metrics, request logging, CORS enforcement, and admin bearer auth.
- Documented server extension points for app-owned HTTP routes, durable job
  handlers, recurring job schedules, search indexes, blob processors, push
  adapters, policy hooks, multi-app URL/schema routing, and cluster-bus fan-out.
- Optional identity-provider server routes through
  `createFrickServer({ identityProviders })`: Apple JWT verification and
  server-to-server notifications, Google ID-token verification, email/password
  signup/login, app-owned User object mapping, first-sign-in hooks, and normal
  session minting.
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
- TypeScript `@frick/core` runtime and `@frick/react` hooks for objects, streams, projections, presence, signals, auth, blobs, search, realtime wrappers, drafts, and background sync.
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
- Swift and Android WebSocket sync transports with capability handshake, object subscriptions/upserts, presence, packed-frame decoding, cache compatibility, and cross-device draft helpers.

## Known Limitations

- The CLI is still private to the monorepo. Development uses `pnpm cli <command>`; publishing a standalone npm CLI remains release work.
- The default deploy image builds the canonical monorepo server runtime.
  Published-package and scaffolded-app image recipes are still follow-up
  release work.
- `@frick/server` has an import-safe package entrypoint and documented export
  map for the baseline server, telemetry, project, migration/reset, cluster
  bus, and production push-adapter surfaces. Deep route/storage imports remain
  internal.
- Multi-app servers route by URL prefix and WebSocket Hello schema id, but
  storage, configured handlers, projection registries, job workers, and
  processors are still shared at the server level.
- Identity-provider sessions use a fixed 30-day lifetime today and the
  provider routes do not yet share the built-in auth attempt limiter. Generic
  OIDC, SAML, and arbitrary OAuth provider routing remain unimplemented.
- Blob bytes are stored in SQLite today. `FRICK_BLOB_STORAGE_PATH` is parsed for a future filesystem driver but is not the active blob-byte store.
- Web Push registration validation and adapter code exist, but the documented
  public push-adapter exports and CLI credential provisioning currently cover
  APNs and FCM only.
- Outbound email router/adapters, including the Resend reference adapter, are
  present under server internals for tests/framework work but are not exported
  as a documented `@frick/server` app surface.
- Swift and Android package publication is configured in source, but local verification still depends on the host having Xcode or Android SDK/JDK paths installed.
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
pnpm android:build
```
