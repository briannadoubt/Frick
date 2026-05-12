# Frick

Frick is a fullstack realtime framework: one versioned schema drives a Node sync server, a TypeScript client runtime (with React bindings), and reusable Swift and Kotlin client SDKs. Objects, streams, presence, signals, projections, jobs, and blobs are all first-class primitives; the wire format is a compact MessagePack frame protocol; and DTOs for every supported client language are generated from the same canonical schema AST.

## Quickstart

```bash
pnpm install
pnpm cli init my-app          # scaffolds package.json, schema.ts, server.ts
cd my-app
pnpm install                  # if you passed --no-install
pnpm dev                      # boots the scaffolded Frick server
```

`pnpm cli init` is the development invocation; once published the same command will be `pnpm exec frick init my-app`. See [`apps/cli/README.md`](./apps/cli/README.md) for the full CLI surface.

To explore the repo itself instead of scaffolding a fresh app:

```bash
pnpm install
pnpm schema:generate          # regenerate Swift + Kotlin DTOs from the foundation schema
pnpm server                   # http://127.0.0.1:4099
pnpm web                      # http://127.0.0.1:5173
```

## Where to go next

- [`docs/onboarding.md`](./docs/onboarding.md) — "what is Frick" plus a 15-minute hands-on tutorial.
- [`docs/schema-author-tutorial.md`](./docs/schema-author-tutorial.md) — add an object type end-to-end, regenerate native DTOs, lint for breaking changes.
- [`docs/authoring.md`](./docs/authoring.md) — full app authoring reference (init flags, scaffold commands, server wiring).
- [`docs/operations.md`](./docs/operations.md) — runtime modes, environment variables, admin routes, shutdown contract.
- [`docs/threat-model.md`](./docs/threat-model.md) — trust boundaries and the auth/permissions story.
- [`docs/push-adapters.md`](./docs/push-adapters.md) — wire up the APNs and FCM adapters, set per-tenant credentials via the CLI, and read back delivery telemetry.
- [`docs/push-receive.md`](./docs/push-receive.md) — typed `FrickPushPayload` + `FrickDeepLinkRouter` for iOS / Android / web push receive.
- [`docs/horizontal-scale.md`](./docs/horizontal-scale.md) — running multiple server nodes behind a load balancer; cluster-bus contract + Redis adapter skeleton.
- [`docs/cross-platform-client-contract.md`](./docs/cross-platform-client-contract.md) — what every client SDK must implement.
- [`docs/versioning.md`](./docs/versioning.md) — schema-identity stability, when to bump revision vs hash, breaking-change policy.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to run tests, commit conventions, PR expectations.

## Tech stack

- **Node 24+** and **pnpm 10+** for the workspace, server, and CLI.
- **TypeScript 5.9+** across `packages/protocol`, `packages/core`, `packages/react`, and the apps.
- **Swift 5.10+ / Xcode 16+** for `packages/swift` and `apps/ios/FrickDemo` (optional).
- **JDK 17 + Android SDK 37 (AGP 9.2.x, Kotlin 2.3.x)** for `apps/android/frick` and `apps/android/app` (optional).
- **SQLite** (via `node:sqlite` on the server, system SQLite on iOS/Android) for durable and cache storage.

The TypeScript stack is required; Swift and Android tooling are only needed if you're working on the native client SDKs or demo apps.

## Status

Pre-1.0. The schema identity (`schemaId`, `protocolVersion`, `schemaRevision`, `hash`) and the structured error envelope are stable — clients and servers in the wild can rely on those. Storage layout, admin/inspection routes, and the CLI surface may still shift between minor versions. Local SQLite databases should be considered disposable while the framework is in cutover posture.

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE).
