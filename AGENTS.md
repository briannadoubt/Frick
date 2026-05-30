# Agent Guidance

Frick is a pre-1.0 fullstack realtime framework. The repo contains the canonical schema/protocol, a Node sync server, TypeScript runtime and React bindings, Swift and Kotlin SDKs, design-token packages, DevTools and MCP packages, Agent Kit guidance surfaces, and thin demo apps / harnesses that exercise the framework contract.

## First Reads

- Start with `README.md` and `docs/onboarding.md` for the repo shape and local loop.
- Use `docs/framework-boundaries.md` to decide whether code belongs in framework packages, server internals, or demo apps.
- Use `docs/cross-platform-client-contract.md` before changing protocol, cache, error, sync, or SDK behavior.
- Treat `internal/specs/` and `internal/plans/` as historical traceability. Public docs and code are the current-state source of truth.

## Commands

- Install: `pnpm install`
- Main TS tests: `pnpm test`
- Typecheck: `pnpm typecheck`
- Regenerate protocol artifacts: `pnpm schema:generate`
- Regenerate design artifacts: `pnpm design:generate`
- Generated drift check: `pnpm verify:generated`
- Server: `pnpm server` (`http://127.0.0.1:4099`)
- Web demo: `pnpm web` (`http://127.0.0.1:5173`)
- Local dashboard: `pnpm dashboard` (`http://127.0.0.1:4299`)
- Swift checks when touching `packages/swift` or `packages/design-swift`: `pnpm swift:test`
- Android checks when touching `apps/android`: `pnpm android:build`

## Project Constraints

- Do not hand-edit generated artifacts. Regenerate protocol outputs with `pnpm schema:generate` and design outputs with `pnpm design:generate`.
- Keep demo app logic thin. If a real app would need to copy behavior from `apps/web`, `apps/ios/FrickDemo`, or `apps/android/app`, promote it to a framework package or document an extension point.
- Treat `apps/rangercrm-server` as a private product-schema integration harness, not a public example or framework API surface.
- Keep `apps/dev-dashboard` static and framework-owned. Standalone mode is local-only; mounted mode is served by the Frick server at `/_frick/dashboard` and should read only documented dashboard/inspection APIs, not create a second operational API.
- When editing AI guidance, update the matching Agent Kit surfaces under `packages/agent-kit/skills`, `packages/agent-kit/agents`, adapter-specific rules/agents, and `packages/agent-kit/manifest.json` when the guidance applies to scaffolded apps.
- Preserve tenant isolation, schema compatibility checks, structured error envelopes, and cross-SDK parity when changing sync or storage paths.
- Server route/storage internals under `apps/server/src/*` are not public API unless documented in `docs/framework-boundaries.md` or exported from `apps/server/src/index.ts`.
- The worktree may contain unrelated user or automation edits. Inspect diffs before editing and do not revert changes you did not make.

## Documentation Rules

- Update the matching public doc when behavior changes: operations in `docs/operations.md`, authoring in `docs/authoring.md`, protocol/SDK semantics in `docs/cross-platform-client-contract.md`, release/version behavior in `docs/versioning.md` or `docs/release.md`.
- Keep `docs/status.md` factual and evidence-backed; do not move old internal plan text into public status unless the code or recent commits support it.
- Keep `CHANGELOG.md` current for user-visible framework changes.
