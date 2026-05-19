# Onboarding

Welcome. This guide is for someone seeing Frick for the first time. It explains the mental model, walks you through running the repo in about fifteen minutes, and points to the next thing to read for each common workflow.

## What is Frick?

Frick is a realtime sync framework. You write a single TypeScript **schema** that defines every piece of data your app exchanges — typed objects, append-only event streams, presence rooms, signal channels, and projections — and the framework turns that schema into:

- a compact wire protocol (MessagePack frames over a single WebSocket),
- a Node sync server backed by SQLite that durably stores objects and events,
- a TypeScript client runtime with a local SQLite-or-IndexedDB cache and React hooks,
- generated DTOs and a matching runtime for Swift and Kotlin clients,
- a `frick` CLI for scaffolding, linting, migrations, and operations.

The primitives the schema defines are:

- **Objects** — typed rows with a stable id and indexed fields. Mutations land on the server; clients see snapshots and field-level updates.
- **Streams** — keyed append-only logs of events. Clients subscribe to a key (e.g. one conversation id), receive a backlog, and then live tail.
- **Presence** — short-lived leases keyed by a room. Useful for "who is here" and "what are they doing right now."
- **Signals** — routed, fire-and-forget channels for things that don't deserve to be in a durable log (typing notifications, cursor pings).
- **Projections** — server-computed derived views over objects and streams; clients subscribe to the projection and receive deltas.
- **Jobs** and **Blobs** — durable background work and content-addressed binary storage, both with the same schema-driven shape.

Two properties tie it together. First, protocol artifacts (server tables, client cache, generated DTOs, fixtures) are derived from the same schema AST, and tracked design-token outputs are generated from the canonical design definition. `pnpm verify:generated` regenerates both families and fails CI if anything moved. Second, the schema carries an identity (`schemaId`, `schemaVersion`, `schemaRevision`, `schemaHash`) that clients send on every connection, so the server can reject incompatible clients before a single bad write hits storage.

## 15-minute tutorial

Prerequisites: Node 24+, pnpm 10+, git. No Xcode or Android SDK needed for this walkthrough.

```bash
git clone <this-repo> frick && cd frick
pnpm install
pnpm schema:generate
pnpm test                       # builds package entrypoints, then runs tests
```

Open three terminals. In the first, start the server:

```bash
pnpm server                     # listens on http://127.0.0.1:4099
```

In the second, start the web demo:

```bash
pnpm web                        # http://127.0.0.1:5173
```

In the third, open Fricken Dashboard, the local Firebase-style console for
health, schema, metrics, jobs, and DevTools events:

```bash
pnpm cli dashboard              # http://127.0.0.1:4299
```

Use the Auth page's Dev Login action to create a local session token, then
refresh the Overview page to unlock the inspection-backed panels.

For the default SQLite platform-event pipeline, the three commands above are
enough. To test the Kafka-compatible Redpanda profile locally, run
`pnpm cli dev --profile redpanda --dry-run` to inspect the env and Docker
Compose plan, or drop `--dry-run` to start the checked-in Redpanda service and
local OpenTelemetry Collector.

You can also watch the sync log directly:

```bash
TOKEN="$(curl -s -X POST http://127.0.0.1:4099/auth/dev-login \
  -H 'content-type: application/json' \
  -d '{"userId":"user-ada"}' | jq -r .sessionToken)"
curl -s http://127.0.0.1:4099/_frick/inspect/server \
  -H "Authorization: Bearer $TOKEN" | jq
```

Now open `http://127.0.0.1:5173` in **two browser tabs**. The web app is a product demo layered on top of the generic framework primitives. Frick itself ships an empty foundation schema; real apps define their own objects, streams, projections, and policy hooks before building product-specific flows.

To prove the round-trip durability, kill the server (`Ctrl-C` in terminal 1), restart it (`pnpm server`), and reload both tabs. The history is still there, replayed from `apps/server/data/frick.sqlite`.

When you want a clean slate:

```bash
rm -f apps/server/data/frick.sqlite
```

## Common workflows

Most day-to-day work is one of these. Each links to the canonical reference.

- **Add a new object type.** Edit `packages/protocol/src/foundation.ts` (or your app's `src/schema.ts`), add the `objects[]` entry with a stable id and stable field ids, run `pnpm schema:generate`, then add server handlers if you need custom mutation logic. See [Schema author tutorial](./schema-author-tutorial.md).
- **Add a new stream event.** Add an entry to `events[]` and reference it from the relevant `streams[].events` array. Events are immutable — once shipped, never change a field id or type.
- **Add a projection.** Run `pnpm cli scaffold projection <Name>` inside a scaffolded app. It creates `src/projections/<name>.ts` and wires it into `src/server.ts` via the marker comments. See [`docs/authoring.md`](./authoring.md).
- **Add a search index.** Declare an `indexes[]` entry on the object. Indexes are framework-managed; you don't write the migration. Custom app-source search indexes require a `search.query` policy hook allow before tenant users can query them.
- **Register a push adapter.** Push transports plug into the server's extension registry. See `apps/server/src/extensions/` and [`docs/operations.md`](./operations.md) for the registration contract.
- **Write a custom job.** Add a `jobs[]` entry to the schema. The server framework gives you a typed handler signature and durable retry semantics.

## Troubleshooting

- **"Schema hash mismatch" on client connect.** Your client cache was built against a different schema. Either regenerate with `pnpm schema:generate` (development), or bump `schemaRevision` so the client knows to discard and re-snapshot.
- **`pnpm verify:generated` fails.** Generated artifacts have drifted. Run `pnpm schema:generate && pnpm fixtures:generate && pnpm design:generate` and commit the regenerated tracked files.
- **`frick migrate status` shows pending migrations after a pull.** Run `pnpm cli migrate up`. In production this requires `--confirm-prod`; see [`docs/operations.md`](./operations.md).
- **"Why can't I see this row I just wrote?"** Tenant boundary. The server scopes objects and streams by tenant id; a subscription with a different tenant context will never see the write. Check the connection's tenant header and verify the row's `tenantId` column.
- **401 on `/_frick/inspect/*`.** Inspection routes require auth. In development, pass a normal session bearer from `/auth/dev-login`; in production, enable inspection deliberately and pass `FRICK_ADMIN_TOKEN` via `Authorization: Bearer …`.
- **CLI says `init refused: target directory not empty`.** `frick init` is for fresh scaffolds only. Choose a new directory or remove the conflicting files; the CLI will list which ones it found.

## Where things live

```
.
├── apps/
│   ├── cli/         # the `frick` operational + scaffolding CLI
│   ├── server/      # Node sync server (HTTP + WebSocket, SQLite-backed)
│   ├── dev-dashboard/  # static local console for health, inspection, metrics, jobs, and events
│   ├── web/         # browser demo app — conformance harness, not a chat product
│   ├── ios/         # SwiftUI demo app (FrickDemo.xcodeproj)
│   └── android/     # Android demo app (`app/`) and the reusable `frick/` SDK module
├── packages/
│   ├── protocol/    # canonical schema AST, codec, frame format, lint, fixtures, native DTO generation
│   ├── core/        # UI-agnostic TypeScript client runtime (cache, sync, commands)
│   ├── react/       # React provider + hooks built on @frick/core
│   ├── swift/       # reusable Swift package (generated DTOs + runtime)
│   ├── design/      # design tokens (shared)
│   ├── design-web/  # web binding for design tokens
│   └── design-swift/# Swift binding for design tokens
├── docs/            # public guides and runbooks
├── internal/        # specs, delivery plans, and maintainer-only notes
├── scripts/         # repo-wide tooling (artifact verification, emulator launchers)
└── Tiltfile         # one-command local dev (install, schema:generate, server, web)
```

The demo apps under `apps/web`, `apps/ios/FrickDemo`, and `apps/android/app` are the canonical end-to-end examples for now — there is no separate `examples/` directory. They intentionally stay thin so they document the contract rather than becoming products.

## Next steps

- Add your first object: [Schema author tutorial](./schema-author-tutorial.md).
- Operate the server: [Operations runbook](./operations.md).
- Contribute back: [CONTRIBUTING](../CONTRIBUTING.md).
