# Current Status

Frick is pre-1.0. The backend — the schema-driven sync server, the `frick` CLI,
and the `frick-mcp` stdio bridge — is a Rust workspace under `crates/` (Rust
1.95). The web client runtime (TypeScript) and React bindings, the Swift SDK,
the Android/Kotlin SDK, design-token packages, and DevTools stay
TypeScript/Swift/Kotlin under `packages/` and `apps/`. The public contract is
still hardening, so storage layout, route details, and package surfaces can
change before a stable 1.0 release.

The Rust backend landed via the FR-236 epic (cutover FR-255). The crates are
`frick-protocol`, `frick-schema`, `frick-codegen`, `frick-store`,
`frick-server`, `frick-cli`, `frick-mcp`, and `frick-conformance`. The wire
contract stays byte/wire-compatible with the TypeScript client runtime under
`packages/protocol`, pinned by the shared fixtures under `conformance/`.

## Stable Enough To Build Against

- Schema identity fields (`schemaId`, `schemaVersion`, `schemaRevision`, `schemaHash`) and generated Swift/Kotlin/TypeScript artifacts.
- Shared structured error envelopes across HTTP, WebSocket nacks, and SDK error types.
- MessagePack WebSocket frames for Hello/HelloAck, subscribe, append, signal, presence, object upsert, snapshot, delta, projection delta, ack, and nack.
- SQLite-backed server persistence, migrations, health/ready/inspect/admin
  routes, metrics, request logging, CORS enforcement, and admin bearer auth.
  `frick-store` ships both SQLite and Postgres backends. (The CLI's
  `backup`/`restore` commands are not yet ported and return `cli.unsupported`.)
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
- Docker Compose deployment profiles are available through
  `frick deploy --profile compose|lightweight`, and `frick deploy image` prints
  the image-build plan. The compose profile wires Redpanda/Kafka platform
  events and the OTel collector around a prebuilt `FRICK_SERVER_IMAGE`; the
  lightweight profile keeps the same server shape with SQLite platform events.
  The canonical monorepo server Dockerfile from the prior TypeScript server no
  longer ships, so `frick deploy image` needs a `--dockerfile <path>`; a
  turnkey Rust-server Dockerfile is follow-up work.
- TypeScript client OpenTelemetry API bridge for analytics requests and sync
  WebSocket transport metrics/spans. The bridge is active by default but is a
  no-op until the app installs an OTel provider. Swift and Android expose
  dependency-light telemetry hooks for analytics `track` calls only; they do
  not bundle native OTel SDKs, and native sync telemetry remains pending.
- Swift and Android WebSocket sync transports with capability handshake, object subscriptions/upserts, live delete tombstones, presence, packed-frame decoding, cache compatibility, and cross-device draft helpers. Swift clients can pass app schema id/revision/hash and a `FrickSchemaDescriptor` into `FrickClient`, auto-clear framework cache state when sign-in swaps users, buffer frames issued immediately after `connect()` until the WebSocket opens, replay active subscriptions after reconnect, skip malformed rows during `fetchObjects` instead of aborting the whole fetch, auto-restore sessions from the Keychain, and auto-resolve `expectedVersion` from cached object versions for HTTP writes.

## Known Limitations

- The CLI is the `frick-cli` crate (the `frick` binary). Repository development
  runs it with `cargo run -p frick-cli -- <command>`; packaging a standalone
  distributable binary remains release work. `verify`/`backup`/`restore` are
  listed for surface parity but return `cli.unsupported`.
- The `frick init` scaffold produces a TypeScript app project (it does not yet
  scaffold a Rust app). A reference Dockerfile recipe for a scaffolded app lives
  under `docker/scaffolded-app/` with a build/run guide in
  `docs/docker-recipes.md`.
- `frick-server` is an embeddable library crate (no standalone server binary);
  a host wires it in with `create_frick_server(...)` and calls `.listen()`. Its
  route/storage internals are not public API unless documented in
  `docs/framework-boundaries.md` or re-exported from the crate's `lib.rs`.
- `frick-codegen` is the Rust DTO generator, but `pnpm schema:generate` is still
  the canonical artifact generator wired into `verify:generated`; making
  `frick-codegen` the byte-identical canonical generator is a follow-up.
- Multi-app servers route by URL prefix and WebSocket Hello schema id. Runtime
  rows for objects, streams, presence, signals, blobs, jobs, sessions, accounts,
  and tenant settings carry `app_id` partitions, and per-app projection/job
  registries are active when app configs are supplied. Remaining multi-app work
  is mostly operational polish: migration/inspection ergonomics, app-level admin
  workflows, and broader product guidance for hosting many apps on one server.
- Sharing is scoped to individual object records and same-tenant principals.
  It cascades read access only to the stream/projection rows keyed by the
  shared record id. It does not cascade to child records, blobs, jobs, search
  results, or arbitrary app routes.
- Identity-provider sessions honor the single configured
  `FRICK_SESSION_TTL_SECONDS` lifetime, and Apple/Google/OIDC verify routes plus
  email password-reset routes share the built-in auth-attempt limiter. Apple,
  Google, generic OIDC issuers (`identityProviders.oidc`, with direct
  `jwksUri` or discovery-resolved key sets), SAML 2.0 Service Providers
  (`identityProviders.saml`, with signature-verified assertions + replay
  protection), and email/password are supported; arbitrary non-OIDC OAuth
  provider routing remains unimplemented.
- Blob bytes default to SQLite but can use the local filesystem with
  `FRICK_BLOB_DRIVER=filesystem` and a writable `FRICK_BLOB_STORAGE_PATH`, or an
  S3-compatible object store with `FRICK_BLOB_DRIVER=s3` and
  `FRICK_BLOB_S3_BUCKET`. Blob metadata remains in SQLite. External blob byte
  stores are not yet part of NDJSON backup/restore or account export payloads,
  so operators must back up the filesystem path or bucket separately.
  Derivative offloading and richer lifecycle policies remain follow-up work.
- APNs, FCM, and Web Push all have documented push-adapter exports and
  `frick tenants set-push` credential workflows. Web Push encrypts payloads per
  RFC 8291 when browser subscription keys are present; multi-key credential
  rotation remains follow-up work.
- Outbound email (the `FrickEmailAdapter` interface, an email router, a Resend
  reference adapter, and an in-memory test adapter wired into the password-reset
  and welcome flows) existed in the prior TypeScript server but is **not yet
  ported** to the Rust `frick-server`; treat it as follow-up work.
- Swift and Android package publication is configured in source, but local verification still depends on the host having Xcode or Android SDK/JDK paths installed.
- CI and Android publishing gate the framework Android modules
  (`:frick`, `:frick-compose`, `:design`). The old demo `:app` remains in the
  workspace and in the stricter local `pnpm android:build` script, but it is
  excluded from CI/publish while it is rebuilt around the current SDK surface.
- Internal specs and plans are historical. They explain why slices happened, not necessarily what is true now.

## Current Local Quality Gate

For backend changes (the Rust workspace under `crates/`), run from the repo root:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

For web-client and artifact-generation changes, run:

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
