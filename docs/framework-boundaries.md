# Frick Framework Boundaries

Status: Contract baseline audit.

## Public Framework Packages

- `@frick/protocol`: canonical schema types, codecs, frame types, generated artifact helpers, schema compatibility helpers, shared error envelopes, capability metadata, and protocol fixtures.
- `@frick/core`: UI-agnostic TypeScript runtime for cache, subscriptions, sync status, offline appends, presence, signals, and schema compatibility behavior.
- `@frick/react`: React provider and hooks over `@frick/core`.
- `@frick/design`: canonical design-token authoring and generation.
- `@frick/design-web`: reusable React design primitives and workspace shell components.
- `packages/swift`: Swift client SDK package.
- `packages/design-swift`: Swift design package.
- `apps/android/frick`: Android/Kotlin client SDK module.
- `apps/android/design`: Android/Kotlin design module.
- `apps/server`: Frick server runtime. Intended public baseline API is `createFrickServer` plus documented server options; route internals are not public API. A package entry point/export map still needs to formalize this before release.

## Internal Framework Modules

- Server storage implementations under `apps/server/src/storage/*`.
- Server route handlers inside `apps/server/src/server.ts`.
- Sync gateway internals under `apps/server/src/sync/*`.
- Protocol generator scripts under `packages/protocol/scripts/*`.
- Design generator scripts under `packages/design/src/scripts/*`.

Internal modules may change while public package entry points stay stable.

## Demo App Code

- `apps/web`
- `apps/ios/FrickDemo`
- `apps/android/app`

Demo apps prove framework behavior. They must not contain protocol, auth/session, schema compatibility, storage, or generated artifact behavior that real apps would need to copy.

## Local Tooling

- `apps/cli`: operational and scaffolding CLI. Command behavior is public only when documented in `apps/cli/README.md` or `docs/operations.md`; implementation imports from `apps/server/src/*` remain internal until the server package has a formal exported API.
- `apps/dev-dashboard`: static local dashboard served by `frick dashboard`. It may read documented `/health`, `/ready`, and `/_frick/inspect/*` endpoints, but it must not create an alternate operational API or become a required production component.

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
