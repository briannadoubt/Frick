# Frick Framework Boundaries

Status: Contract baseline audit.

## Public Framework Packages

- `@fricken/protocol`: canonical schema types, codecs, frame types, generated artifact helpers, schema compatibility helpers, shared error envelopes, capability metadata, and protocol fixtures.
- `@fricken/core`: UI-agnostic TypeScript runtime for cache, subscriptions, sync status, offline appends, presence, signals, and schema compatibility behavior.
- `@fricken/react`: React provider and hooks over `@fricken/core`.
- `@fricken/devtools`: embeddable React DevTools widgets for client sync status,
  pending mutations, optimistic overlays, and runtime diagnostics.
- `@fricken/mcp`: read-only MCP server for inspecting a running Frick app's
  schema, health, resources, and runtime metadata from agent harnesses.
- `@fricken/agent-kit`: portable guidance pack that installs Frick skills,
  agent profiles, Cursor rules, and shared spine references into scaffolded
  apps.
- `@fricken/design`: canonical design-token authoring and generation.
- `@fricken/design-web`: reusable React design primitives and workspace shell components.
- `packages/swift`: Swift client SDK package.
- `packages/design-swift`: Swift design package.
- `apps/android/frick`: Android/Kotlin client SDK module.
- `apps/android/frick-compose`: Android Compose helpers over the Kotlin SDK.
- `apps/android/design`: Android/Kotlin design module.
- `apps/server`: Frick server runtime. Public baseline API is the
  `@fricken/server` package entrypoint: `createFrickServer`, documented server
  options, telemetry types, project/module helpers, reset/migration helpers,
  job handler types, the documented cluster bus, outbound email types/router
  helpers, and test/reference email adapters. Production push and Resend email
  adapters are exported through documented package subpaths. Route and storage
  internals remain private.
- Mounted dashboard routes under `/_frick/dashboard` and documented
  `/_frick/dashboard/api/*` responses are operator-facing surfaces. Internal
  route helper modules under `apps/server/src/dashboard/*` remain private
  implementation unless exported from `apps/server/src/index.ts`.

## Rust Rewrite Workspace

- `crates/frick-protocol`: Rust wire protocol, schema identity, structured
  error envelope, and fixture-pinned codecs that must match `@fricken/protocol`.
- `crates/frick-schema`: Rust schema authoring DSL and breaking-change lint.
- `crates/frick-codegen`: Rust code generation for Swift, Kotlin, and
  TypeScript DTO outputs.
- `crates/frick-store`: Rust SQL driver seam, migrations, and durable/cache
  store facade.
- `crates/frick-server`: Rust tokio/axum server runtime.
- `crates/frick-cli`: future Rust `frick` binary.

These crates are active FR-236 rewrite work, not the production framework
surface yet. Public package compatibility remains defined by the TypeScript,
Swift, and Android surfaces until the v0.4.0 cutover.

## Internal Framework Modules

- Server storage implementations under `apps/server/src/storage/*`.
- Server route handlers inside `apps/server/src/server.ts`.
- Server email implementation details that are not exported from
  `@fricken/server` or `@fricken/server/email/resend-adapter`. Apps should use
  the exported `FrickEmailAdapter`, `createFrickEmailRouter`,
  `createFrickTestEmailAdapter`, and Resend reference adapter instead of
  deep-importing files from `apps/server/src/email/*`.
- Sync gateway internals under `apps/server/src/sync/*`.
- Protocol generator scripts under `packages/protocol/scripts/*`.
- Design generator scripts under `packages/design/src/scripts/*`.

Internal modules may change while public package entry points stay stable.

## Demo App Code

- `apps/web`
- `apps/ios/FrickDemo`
- `apps/android/app`

Demo apps prove framework behavior. They must not contain protocol, auth/session, schema compatibility, storage, or generated artifact behavior that real apps would need to copy. Downstream product apps (e.g. RangerCRM) live in their own repositories and consume Frick as a dependency — they are not part of this repo.

## Local Tooling

- `apps/cli`: operational and scaffolding CLI. Command behavior is public only
  when documented in `apps/cli/README.md` or `docs/operations.md`.
  Implementation may still import selected server internals for operations that
  do not yet have package-level helpers; those imports remain internal and
  should not be copied by apps.
- `apps/dev-dashboard`: static dashboard app served locally by `frick dashboard`
  and mountable by the server at `/_frick/dashboard`. It may read documented
  `/health`, `/ready`, `/_frick/inspect/*`, and `/_frick/dashboard/api/*`
  endpoints, but it must not create an alternate operational API or become the
  only way to operate a Frick deployment.
- `packages/agent-kit/adapters/*`: generated or projected harness surfaces
  for Codex, Claude Code, and Cursor. Update the canonical skills, agents,
  references, and manifest first when changing guidance, then refresh adapter
  files consistently.

## Generated Files

Generated files must not be hand-edited:

- `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift`
- `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt`
- `packages/design-web/src/generated/*`
- `packages/design-swift/Sources/FrickDesign/Generated/*`
- `apps/android/design/src/main/java/dev/frick/design/generated/*`

Regenerate protocol artifacts with `pnpm schema:generate`.
Regenerate design artifacts with `pnpm design:generate`.

## Current Contract Rule

If a real app would need to import code from a demo app or deep internal path, that behavior belongs in a framework package or a documented extension point before release.
