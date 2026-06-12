# Frick

Frick is a fullstack realtime framework: one versioned schema drives the sync server, a TypeScript client runtime (with React bindings), and reusable Swift and Kotlin client SDKs. Objects, streams, presence, signals, projections, jobs, blobs, and cross-user sharing grants are all first-class framework primitives; the wire format is a compact MessagePack frame protocol; and DTOs for every supported client language are generated from the same canonical schema AST.

The sync server, the `frick` CLI, and the MCP bridge are Rust crates under
`crates/` (Rust 1.95, pinned by `rust-toolchain.toml`). The web client runtime,
React bindings, Swift SDK, and Kotlin SDK stay TypeScript/Swift/Kotlin under
`packages/` and `apps/`.

## Quickstart

The backend lives in the Cargo workspace. Build and gate it from the repo root:

```bash
cargo build --workspace
cargo test --workspace        # the backend quality gate
```

The `frick` CLI is the `frick-cli` crate; run it through Cargo:

```bash
cargo run -p frick-cli -- schema check        # validate the foundation schema, print its identity
cargo run -p frick-cli -- schema generate     # regenerate tracked client DTO artifacts
cargo run -p frick-cli -- schema export --out schema.json  # write the active schema for FRICK_SCHEMA_PATH
cargo run -p frick-cli -- init my-app         # scaffold a TypeScript app project
cargo run -p frick-cli -- dashboard           # serve Fricken Dashboard at http://127.0.0.1:4299
cargo run -p frick-cli -- dev --profile redpanda --dry-run  # print the Redpanda/Kafka local profile
```

The sync server runtime (`frick-server`) is both an embeddable library and a
standalone binary. Run `cargo run -p frick-server` to serve `FRICK_SCHEMA_PATH`
or the foundation schema, or wire the library into a host with
`create_frick_server(...)` and call `.listen()`. The MCP stdio bridge runs via
`cargo run -p frick-mcp` (or `cargo run -p frick-cli -- mcp`).

The web client still runs on the TypeScript toolchain:

```bash
pnpm install
pnpm schema:generate          # wrapper around `frick schema generate`
pnpm web                      # http://127.0.0.1:5173
```

## Where to go next

- [`docs/onboarding.md`](./docs/onboarding.md) — "what is Frick" plus a 15-minute hands-on tutorial.
- [`docs/schema-author-tutorial.md`](./docs/schema-author-tutorial.md) — add an object type end-to-end, regenerate native DTOs, lint for breaking changes.
- [`docs/authoring.md`](./docs/authoring.md) — full app authoring reference (init flags, scaffold commands, server wiring).
- [`docs/operations.md`](./docs/operations.md) — runtime modes, environment variables, admin routes, shutdown contract.
- [`docs/status.md`](./docs/status.md) — current stable surfaces, known limitations, and quality gates.
- [`docs/threat-model.md`](./docs/threat-model.md) — trust boundaries and the auth/permissions story.
- [`docs/push-adapters.md`](./docs/push-adapters.md) — wire up the APNs and FCM adapters, set per-tenant credentials via the CLI, and read back delivery telemetry.
- [`docs/push-receive.md`](./docs/push-receive.md) — typed `FrickPushPayload` + `FrickDeepLinkRouter` for iOS / Android / web push receive.
- [`docs/horizontal-scale.md`](./docs/horizontal-scale.md) — running multiple server nodes behind a load balancer with the cluster-bus contract and bundled Redis adapter.
- [`docs/cross-platform-client-contract.md`](./docs/cross-platform-client-contract.md) — what every client SDK must implement.
- [`docs/versioning.md`](./docs/versioning.md) — schema-identity stability, when to bump revision vs hash, breaking-change policy.
- [`AGENTS.md`](./AGENTS.md) — repo-specific guidance for AI agents and automation.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to run tests, commit conventions, PR expectations.

## Tech stack

- **Rust 1.95** (pinned by `rust-toolchain.toml`) for the backend: the sync
  server (`frick-server`), the `frick` CLI (`frick-cli`), the MCP bridge
  (`frick-mcp`), the schema/codegen pipeline (`frick-schema`, `frick-codegen`,
  `frick-protocol`), and storage (`frick-store`) — all under `crates/`.
- **Node 24+** and **pnpm 10+** for the web client workspace and the
  artifact-generation tooling.
- **TypeScript 5.9+** across `packages/protocol`, `packages/core`, `packages/react`, and the web apps.
- **Swift 5.10+ / Xcode 16+** for `packages/swift` and `apps/ios/FrickDemo` (optional).
- **JDK 17 + Android SDK 37 (AGP 9.2.x, Kotlin 2.3.x)** for `apps/android/frick` and `apps/android/app` (optional).
- **SQLite** for the active durable and cache stores (`frick-store` on the
  server via bundled `rusqlite`, system SQLite on iOS/Android). `frick-store`
  also ships a Postgres backend.

The Rust toolchain is required for the backend; the TypeScript stack is required
for the web client; Swift and Android tooling are only needed if you're working
on the native client SDKs or demo apps.

## Status

Pre-1.0. The backend (sync server, CLI, MCP) now runs on the Rust crates under
`crates/`; the web client, Swift SDK, and Kotlin SDK remain TypeScript/Swift/Kotlin.
The schema identity (`schemaId`, `schemaVersion`, `schemaRevision`, `schemaHash`)
and the structured error envelope are stable enough for clients and servers to
rely on. Storage layout, admin/inspection routes, and the CLI surface may still
shift between minor versions. Local SQLite databases should be considered
disposable. See [`docs/status.md`](./docs/status.md) for the current support
boundaries and known limitations.

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE).
