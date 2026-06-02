# Versioning Policy

Frick is a multi-language framework. Each language package has its own version stream and its own source-of-truth file. The repository root carries no version — `package.json` at the root is private and exists only to host workspace scripts.

## Semantic Versioning

Framework packages follow [SemVer 2.0.0](https://semver.org/) with the following sharpened definitions:

- **Major (`X.0.0`)** — incompatible change. Triggered by either:
  - a breaking change to the public TypeScript/Swift/Kotlin surface, **or**
  - a `schemaRevision` bump in `@fricken/protocol` that older clients cannot decode (e.g. a removed frame kind, a renamed envelope field, or a changed wire encoding).
- **Minor (`0.Y.0`)** — additive, backwards-compatible change. New exports, new frame kinds that older servers ignore, new optional capability flags, new SQL migrations that are forward-compatible.
- **Patch (`0.0.Z`)** — bug fixes, documentation, internal refactors with no API or wire surface change.

A new framework version **does not** imply a new schema revision. A release that only fixes a server-side bug or adds a new TypeScript helper keeps `schemaRevision: 1` and bumps the package patch/minor only.

## Source of truth per package

| Package | Language | Version source |
| --- | --- | --- |
| `@fricken/protocol` | TypeScript | `packages/protocol/package.json` |
| `@fricken/core` | TypeScript | `packages/core/package.json` |
| `@fricken/react` | TypeScript | `packages/react/package.json` |
| `@fricken/design` | TypeScript | `packages/design/package.json` |
| `@fricken/design-web` | TypeScript | `packages/design-web/package.json` |
| `@fricken/devtools` | TypeScript | `packages/devtools/package.json` |
| `@fricken/agent-kit` | TypeScript | `packages/agent-kit/package.json` |
| `@fricken/mcp` | TypeScript | `packages/mcp/package.json` |
| `@fricken/server` | TypeScript | `apps/server/package.json` |
| `@fricken/web` | TypeScript | `apps/web/package.json` |
| `@fricken/cli` | TypeScript | `apps/cli/package.json` |
| `Frick` (Swift) | Swift | git tag (`swift-vX.Y.Z`) — `Package.swift` has no version field |
| `FrickDesign` (Swift) | Swift | git tag (`swift-design-vX.Y.Z`) |
| `dev.frick:frick` | Android (Kotlin) | `apps/android/frick/build.gradle.kts` (`version = "X.Y.Z"`) |
| `dev.frick:design` | Android (Kotlin) | `apps/android/design/build.gradle.kts` |

Future Rust crates would carry their version in `Cargo.toml` under `[package].version`. The root `package.json` never declares a framework version — the field is pinned to `0.0.0` and is private.

Packages are independent. A patch release of `@fricken/server` does not force a release of `@fricken/protocol`.

## Wire compatibility

The wire contract is governed by `schemaRevision` in `@fricken/protocol`, not by package versions. Two rules:

1. **Decoupled bumps.** A framework version may keep the existing `schemaRevision` if the wire format did not change. Conversely, a `schemaRevision` bump always travels with at least a minor bump of `@fricken/protocol`.
2. **Capability negotiation.** Clients and servers advertise capabilities during the hello handshake (see `packages/protocol/src/capabilities.ts`). Capability flags allow additive changes within the same revision.

## Compatibility windows

The server tolerates clients from the **last two minor versions** of the same major. For example, with `@fricken/server@1.4.x`:

- `@fricken/core@1.4.*` — fully supported (current).
- `@fricken/core@1.3.*` — fully supported (previous minor).
- `@fricken/core@1.2.*` — connections rejected with an `auth.versionUnsupported` envelope.

Major boundaries are hard: a `2.x` server refuses any `1.x` client unless capability negotiation explicitly opts in.

Clients are expected to reconnect on `auth.versionUnsupported` only after upgrading; do not retry blindly.

## Deprecation policy

Any export, frame kind, configuration option, or HTTP route marked deprecated must remain functional for **at least one full minor release** before removal in the following major. The minimum lifecycle is:

1. `1.4.0` — feature shipped.
2. `1.7.0` — feature marked `@deprecated` in the source, replacement documented.
3. `1.8.0` — feature still present, emits a one-time warning when first used.
4. `2.0.0` — feature may be removed.

Deprecations must be listed under the `Deprecated` section of `CHANGELOG.md` for the release that introduces them.

## Stable vs. unstable surfaces

### Stable (public API)

These are the exports an application author may depend on. Breaking changes require a major bump.

- `@fricken/protocol`:
  - `FrickSchema`, `FrickErrorEnvelope`, `FrickEnvelope`
  - `FrameKind` and the discriminated `Frame` union
  - `schemaRevision`, capability descriptors, hello-handshake types
  - generated native artifacts (Swift/Kotlin constants and types)
- `@fricken/core`:
  - `FrickClient`, `connectSync`, `upsertObject`, `subscribeStream`, `subscribeProjection`
  - error envelope decoding helpers
- `@fricken/react`:
  - `useProjection`, `useFrickClient`
- `@fricken/design`:
  - design token definition, resolver, validation, and generator exports
- `@fricken/design-web`:
  - exported React design primitives and generated CSS token contract
- `@fricken/devtools`:
  - `FrickDevtools` React component and documented props
- `@fricken/agent-kit`:
  - installer CLI, package manifest, Frick skills, subagent profiles, adapter manifests, and Cursor rules
- `@fricken/mcp`:
  - stdio MCP server, read-only runtime tools/resources/prompts, client config helper, and CLI launch helpers
- `@fricken/server`:
  - `createServer`, `FrickStore` constructor, runtime config types
  - HTTP route mounts under `/_frick/*` (admin routes excluded from compat — see below)
  - registered handler/projection/job/policy/blob/notification interfaces
- `@fricken/cli`:
  - documented commands (`init`, `schema`, `migrate`, `doctor`, `inspect`, `reset`, `tenants`, `verify`, `lint`, `backup`, `restore`, `dashboard`, `mcp`, scaffolders)

### Unstable / internal

Anything under these paths may change in any release, including patches. Do not import from these paths in application code.

- `@fricken/server`:
  - `apps/server/src/storage/*` — SQLite adapters and migration internals
  - `apps/server/src/sync/*` internals other than the documented gateway entry point
  - `apps/server/src/devtools/*` — DevTools event stream is for the inspector, not authoring
  - all admin routes under `/_frick/admin/*` — versioned independently and gated behind `FRICK_ADMIN_TOKEN`
- `@fricken/protocol`:
  - `packages/protocol/scripts/*` — generator scripts and fixture tooling
- `@fricken/core`:
  - any module path containing `/internal/`

If you need something internal to be stable, file an issue and we will decide whether to promote it.
