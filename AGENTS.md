# Agent Guidance

Frick is a pre-1.0 fullstack realtime framework. The backend — the canonical schema/protocol, sync server, CLI, and MCP bridge — is a set of Rust crates under `crates/`. The web client (TypeScript runtime and React bindings), Swift and Kotlin SDKs, design-token packages, DevTools, and thin demo apps / harnesses that exercise the framework contract live under `packages/` and `apps/`.

## First Reads

- Start with `README.md` and `docs/onboarding.md` for the repo shape and local loop.
- Use `docs/framework-boundaries.md` to decide whether code belongs in framework packages, server internals, or demo apps.
- Use `docs/cross-platform-client-contract.md` before changing protocol, cache, error, sync, or SDK behavior.
- The backend lives in `crates/` (`frick-protocol`, `frick-schema`, `frick-codegen`, `frick-store`, `frick-server`, `frick-cli`, `frick-mcp`, `frick-conformance`); read the relevant crate's `lib.rs`/`main.rs` before changing server, CLI, or protocol behavior.
- Treat `internal/specs/`, `internal/plans/`, and `internal/rust-rewrite/maps/` as historical traceability. Public docs and code are the current-state source of truth.

## Commands

### Backend (Rust, `crates/`)

Run from the repo root; the toolchain is pinned by `rust-toolchain.toml`.

- Build: `cargo build --workspace`
- Tests: `cargo test --workspace`
- Lint: `cargo clippy --workspace --all-targets -- -D warnings`
- Format: `cargo fmt --all` (`cargo fmt --all --check` to verify)
- `frick` CLI: `cargo run -p frick-cli -- <command>` (e.g.
  `schema check`, `lint`, `migrate status`, `doctor`, `inspect server`,
  `tenants list`, `reset`, `init`, `scaffold`, `dashboard`). The dashboard
  serves Fricken Dashboard at `http://127.0.0.1:4299`.
- MCP stdio bridge: `cargo run -p frick-mcp` (or `cargo run -p frick-cli -- mcp`).
- The sync server (`frick-server`) is an embeddable library with no standalone
  binary; tests and the conformance harness boot it via `create_frick_server(...)`
  + `.listen()`.

### Web client + artifacts (TypeScript)

- Install: `pnpm install`
- Web-client tests: `pnpm test`
- Typecheck: `pnpm typecheck`
- Regenerate protocol artifacts: `pnpm schema:generate`
- Regenerate design artifacts: `pnpm design:generate`
- Generated drift check: `pnpm verify:generated`
- Web demo: `pnpm web` (`http://127.0.0.1:5173`)
- Swift checks when touching `packages/swift` or `packages/design-swift`: `pnpm swift:test`
- Android SDK/design checks when touching Android framework modules: generate
  schema/design artifacts, then run the Gradle module set used by CI
  (`:frick`, `:frick-compose`, `:design`). `pnpm android:build` is a stricter
  local full-demo check and still includes `:app`.

## Rust Workspace

The backend is the Rust framework (scope epic FR-236; cutover landed in
FR-255). The Cargo workspace lives at the repo root with crates under
`crates/`, named `frick-<area>`:

- `crates/frick-protocol` — wire frames, schema identity, error envelope
  (byte-compatible with `packages/protocol`; pinned by golden fixtures under
  `conformance/`).
- `crates/frick-schema` — Rust schema DSL, canonical AST, identity hashing,
  breaking-change lint.
- `crates/frick-codegen` — Swift, Kotlin, and TypeScript DTO generators for
  the Rust schema pipeline. Not yet wired as the canonical artifact generator —
  `pnpm schema:generate` is still the source of truth for regenerated DTOs.
- `crates/frick-store` — store port traits + SQLite/Postgres backends.
- `crates/frick-server` — tokio/axum sync server runtime (embeddable library,
  no standalone binary).
- `crates/frick-cli` — the `frick` binary (schema/lint/migrate/doctor/inspect/
  tenants/init/scaffold/dev/deploy/dashboard/mcp). `verify`/`backup`/`restore`
  are listed for parity but currently return `cli.unsupported`.
- `crates/frick-mcp` — the `frick-mcp` stdio JSON-RPC bridge.
- `crates/frick-conformance` — black-box scenario harness over the in-process
  server.

The wire contract stays compatible with the TypeScript client runtime under
`packages/protocol`; conformance is pinned by the shared fixtures under
`conformance/`. Implementation-grade specs extracted from the prior TS code
live in `internal/rust-rewrite/maps/`.

## Project Constraints

- Do not hand-edit generated artifacts. Regenerate protocol outputs with `pnpm schema:generate` and design outputs with `pnpm design:generate`.
- Keep demo app logic thin. If a real app would need to copy behavior from `apps/web`, `apps/ios/FrickDemo`, or `apps/android/app`, promote it to a framework package or document an extension point.
- Downstream product apps that consume Frick (e.g. RangerCRM) live in their own repositories, not here. Do not add product-schema servers or app code to this repo; keep it framework-only.
- **The Swift SDK lives at `packages/swift` (and `packages/design-swift`) — develop there.** `briannadoubt/FrickSwift` is generated, publish-only release output (SwiftPM needs a root-level `Package.swift`, so releases mirror the subtree there). **Never clone, edit, or open the FrickSwift mirror** — it has no source of truth, only published tags.
- Keep `apps/dev-dashboard` static and framework-owned. Standalone mode is local-only; mounted mode is served by the Frick server at `/_frick/dashboard` and should read only documented dashboard/inspection APIs, not create a second operational API.
- Preserve tenant isolation, schema compatibility checks, structured error envelopes, and cross-SDK parity when changing sync or storage paths. `frick-store` ships both SQLite and Postgres backends; keep existing behavior intact unless a ticket explicitly targets one backend.
- Server route/storage internals under `crates/frick-server/src/*` and `crates/frick-store/src/*` are not public API unless documented in `docs/framework-boundaries.md` or re-exported from the crate's `lib.rs`.
- The worktree may contain unrelated user or automation edits. Inspect diffs before editing and do not revert changes you did not make.

## Documentation Rules

- Update the matching public doc when behavior changes: operations in `docs/operations.md`, authoring in `docs/authoring.md`, protocol/SDK semantics in `docs/cross-platform-client-contract.md`, release/version behavior in `docs/versioning.md` or `docs/release.md`.
- Keep `docs/status.md` factual and evidence-backed; do not move old internal plan text into public status unless the code or recent commits support it.
- Keep `CHANGELOG.md` current for user-visible framework changes.
