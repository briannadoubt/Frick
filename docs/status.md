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
- SQLite- and Postgres-backed server persistence, migrations, health/ready/inspect/admin
  routes, metrics, request logging, CORS enforcement, and admin bearer auth.
  `frick-store` ships both SQLite and Postgres backends, and the CLI ships
  `backup`/`restore` as NDJSON dump/restore commands.
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
  built-in platform-event consumer so the SQLite platform-events deployment has
  the dashboard read model; the Kafka/Redpanda platform-events driver is still
  a follow-up and fails fast if selected.
- Server-side OpenTelemetry trace export through OTLP HTTP/protobuf, enabled by
  OTLP env vars and included in the Redpanda local profile through the checked-in
  collector config. The in-process metrics snapshot remains available at
  `/_frick/inspect/metrics`; OTLP metrics export is still pending.
- Docker Compose deployment profiles are available through
  `frick deploy --profile compose|lightweight`, and `frick deploy image` prints
  the image-build plan. The compose profile wires Redpanda/Kafka platform
  events and the OTel collector around a prebuilt `FRICK_SERVER_IMAGE`; the
  lightweight profile keeps the same server shape with SQLite platform events.
  The canonical monorepo `ops/deploy/server.Dockerfile` builds the standalone
  Rust `frick-server` binary and is the default image for `frick deploy image`.
- TypeScript client OpenTelemetry API bridge for analytics requests and sync
  WebSocket transport metrics/spans. The bridge is active by default but is a
  no-op until the app installs an OTel provider. Swift and Android expose
  dependency-light telemetry hooks for analytics `track` calls only; they do
  not bundle native OTel SDKs, and native sync telemetry remains pending.
- Swift and Android WebSocket sync transports with capability handshake, object subscriptions/upserts, live delete tombstones, presence, packed-frame decoding, cache compatibility, and cross-device draft helpers. Swift clients can pass app schema id/revision/hash and a `FrickSchemaDescriptor` into `FrickClient`, auto-clear framework cache state when sign-in swaps users, buffer frames issued immediately after `connect()` until the WebSocket opens, replay active subscriptions after reconnect, skip malformed rows during `fetchObjects` instead of aborting the whole fetch, auto-restore sessions from the Keychain, and auto-resolve `expectedVersion` from cached object versions for HTTP writes.

## Known Limitations

- The CLI is the `frick-cli` crate (the `frick` binary). Repository development
  runs it with `cargo run -p frick-cli -- <command>`; packaging a standalone
  distributable binary remains release work. `verify`, `backup`, and `restore`
  are implemented in Rust.
- The `frick init` scaffold produces a TypeScript schema + client project (no
  embedded server — the backend is the Rust `frick-server` binary). The
  canonical server image lives at `ops/deploy/server.Dockerfile` with a
  build/run guide in `docs/docker-recipes.md`.
- `frick-server` is an embeddable library crate that also ships a standalone
  `frick-server` binary (`cargo run -p frick-server`, or the
  `ops/deploy/server.Dockerfile` image; it serves `FRICK_SCHEMA_PATH` or the
  foundation schema). A host can still wire the library in directly with
  `create_frick_server(...)` and call `.listen()`. Its route/storage internals
  are not public API unless documented in `docs/framework-boundaries.md` or
  re-exported from the crate's `lib.rs`.
- `frick-codegen` is the Rust DTO generator, and
  `cargo run -p frick-cli -- schema generate` is the canonical DTO artifact
  generator. `pnpm schema:generate` remains as the workspace wrapper.
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
  Google, generic OIDC issuers (`FRICK_OIDC_PROVIDERS`, with pinned issuer,
  audiences, and JWKS URI), and email/password are supported. Frick does not
  terminate SAML in-process; enterprise SAML SSO is supported by fronting Frick
  with a SAML-to-OIDC broker and consuming the OIDC route. Arbitrary non-OIDC
  OAuth provider routing remains unimplemented.
- Blob bytes default to SQLite but can use the local filesystem with
  `FRICK_BLOB_DRIVER=filesystem` and a writable `FRICK_BLOB_STORAGE_PATH`, or an
  S3-compatible object store with `FRICK_BLOB_DRIVER=s3` and
  `FRICK_BLOB_S3_BUCKET`. Blob metadata remains in SQLite. External blob byte
  stores are not yet part of NDJSON backup/restore or account export payloads,
  so operators must back up the filesystem path or bucket separately.
  The blob processor/validator pipeline and `blob.process` job are ported;
  image-derivative generation and richer lifecycle policies remain follow-up
  work.
- APNs, FCM, and Web Push all have documented push-adapter exports and
  `frick tenants set-push` credential workflows. Web Push encrypts payloads per
  RFC 8291 when browser subscription keys are present. Push credential key
  rotation supports a primary `FRICK_PUSH_CRED_KEY` plus overlap reads through
  `FRICK_PUSH_CRED_KEY_PREVIOUS`.
- Outbound email ships as a Rust `FrickEmailAdapter` trait, email router,
  Noop default, in-memory test adapter, and live Resend adapter. SES, Postmark,
  SMTP, and email-address verification routes remain follow-up or out-of-tree
  adapter work.
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
