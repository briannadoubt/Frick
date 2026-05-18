# Current Status

Frick is pre-1.0. The framework has a working schema-driven sync server, TypeScript runtime, React bindings, Swift SDK, Android/Kotlin SDK, design-token packages, CLI, and demo apps. The public contract is still hardening, so storage layout, route details, and package surfaces can change before a stable 1.0 release.

## Stable Enough To Build Against

- Schema identity fields (`schemaId`, `schemaVersion`, `schemaRevision`, `schemaHash`) and generated Swift/Kotlin/TypeScript artifacts.
- Shared structured error envelopes across HTTP, WebSocket nacks, and SDK error types.
- MessagePack WebSocket frames for Hello/HelloAck, subscribe, append, signal, presence, object upsert, snapshot, delta, projection delta, ack, and nack.
- SQLite-backed server persistence, migrations, health/ready/inspect/admin routes, backup/restore, metrics, request logging, CORS enforcement, and admin bearer auth.
- Fricken Dashboard, served locally by `frick dashboard` and mountable at
  `/_frick/dashboard`, for inspecting health, readiness, schema identity,
  schema resources, metrics, jobs, migrations, and DevTools events against a
  running server. Standalone mode reads platform event pipeline health and
  tenant-scoped product analytics summaries through authenticated inspection
  routes; mounted mode exposes the same product views through authenticated
  dashboard APIs.
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
- TypeScript client OpenTelemetry API bridge for analytics requests and sync
  WebSocket transport metrics/spans. The bridge is active by default but is a
  no-op until the app installs an OTel provider; native SDK telemetry capture is
  still pending.
- Swift and Android WebSocket sync transports with capability handshake, object subscriptions/upserts, presence, packed-frame decoding, cache compatibility, and cross-device draft helpers.

## Known Limitations

- The CLI is still private to the monorepo. Development uses `pnpm cli <command>`; publishing a standalone npm CLI remains release work.
- `apps/server` is a runtime app and partial library surface today. `createFrickServer` and documented options are the intended baseline; deep route/storage imports are internal.
- Multi-app servers route by URL prefix and WebSocket Hello schema id, but storage is still shared at the server level.
- Blob bytes are stored in SQLite today. `FRICK_BLOB_STORAGE_PATH` is parsed for a future filesystem driver but is not the active blob-byte store.
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
