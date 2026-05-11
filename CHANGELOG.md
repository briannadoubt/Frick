# Changelog

All notable changes to Frick framework packages are recorded here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/) and the versioning policy lives in [`docs/versioning.md`](docs/versioning.md).

Each package version is independent — a release header documents which packages moved and by how much.

## Unreleased

_Nothing yet._

## 0.1.0 - 2026-05-11

First public scaffolding pass. Establishes the wire contract, server, native clients, demo apps, CLI, and operational documentation. All framework packages start at `0.1.0` after this entry.

### Protocol

- Frame kinds: `hello`, `hello-ack`, `subscribe`, `unsubscribe`, `append`, `signal`, `object-upsert`, `projection-delta`, plus heartbeat and error envelopes.
- `schemaRevision: 1` baseline with capability negotiation in the hello handshake.
- Shared `FrickErrorEnvelope` over HTTP and WebSocket paths.
- Native schema artifact generator emits Swift and Kotlin constants from the TS source of truth.
- Baseline fixtures plus a drift check (`pnpm verify:generated`) guard the generated outputs.
- Schema linter module surfaces shape violations for app authors.

### Server (`@frick/server`)

- Migration runner with checksum-pinned `frick_migrations` table; refuses to boot on drift or unknown future revisions.
- Sync gateway with hello handshake, capability negotiation, frame-size caps, per-tenant limits, heartbeat, presence TTL, and bounded subscription/pending-append queues.
- Multi-tenant isolation threaded through every storage method, request path, and admin route.
- Authorization decisions with typed reason codes; deny-by-default for unknown actions; tenant-scope checks on writes; conversation-membership and blob-ownership enforcement.
- Object versioning with `versionPrecondition` enforcement and `ObjectUpsert` conflict envelopes over the sync socket.
- Typed projection registry with delta broadcasting; conversation inbox re-expressed as a projection.
- Job worker with backoff, dead-letter queue, lifecycle inspect routes, and admin trigger endpoint.
- Push notification router as a job handler with device registrations and admin delivery.
- SQLite FTS5 search adapter wired into store writes with an admin rebuild route.
- Blob derivative storage, synchronous upload validators, and a `blob.process` job handler.
- Backup and restore: NDJSON dump generator with schema-tagged header; restore reader refuses schema drift.
- Per-tenant settings store with admin routes; HTTP and WS paths resolve limits per request.
- DevTools event store with retention pruning; emits events on HTTP, WS, and job lifecycle.
- Compliance: data-subject export and erase endpoints, hash-chained admin audit log with `verifyChain`.
- App registry and hello-driven app routing; `/_frick/inspect/apps` and admin schema-lint route.
- Operational surface: graceful shutdown with in-flight tracking, health/ready/inspect routes, structured logger with redaction defaults, child loggers, per-request log lines, metrics module, idempotency cache with retention and row caps, CORS enforcement, admin bearer auth.

### Swift (`Frick`, `FrickDesign`)

- `FrickSyncSocket` WebSocket transport with hello handshake, append/subscribe/object-upsert send paths, and reconnect handling.
- `FrickClient.connectSync` entry point.
- Shared error envelope parsing over HTTP responses.
- Cache schema compatibility enforced on load.
- Protocol fixture decode tests against generated constants.

### Android (`dev.frick:frick`, `dev.frick:design`)

- `FrickSyncSocket` WebSocket transport scaffolding, hello handshake, status flow, append/subscribe/object-upsert send paths.
- Inbound delta and projection-delta handling.
- Reconnect with backoff plus pending append flush.
- Shared error envelope parsing.
- Cache schema compatibility enforced on load.
- Protocol fixture decode tests against generated constants.
- `mockwebserver3` based sync socket tests.

### Web (`@frick/core`, `@frick/react`, `@frick/web`)

- `@frick/core` runtime with bounded pending append queue, reconnect backoff, projection-delta receive path, `upsertObject` with conflict typing, and cache schema compatibility.
- `@frick/react` `useProjection` hook.
- Web demo wired to the runtime contract.

### CLI (`@frick/cli`)

- Commands: `init`, `schema`, `migrate`, `doctor`, `inspect`, `reset`, `tenants`, `verify`, `lint`, `backup`, `restore`, plus object/stream/projection scaffolders.
- Templates module backing `init` and the scaffolders.

### Docs

- Framework boundaries, threat model, operations runbook, cross-platform client contract.
- App authoring guide, server operations notes (idempotency cache, frame-size cap, per-request logging, metrics snapshot, backup and restore, tenant boundary, CORS).
- Framework hardening spec and plan.
- Versioning policy and release runbook (this round).

### Deprecated

- _None._

### Removed

- _None._

### Security

- Admin routes gated behind `FRICK_ADMIN_TOKEN`.
- Logger redacts secrets by default; CORS enforced on HTTP and WS; deny-by-default authorization; tenant isolation tests across object/stream/blob/inbox paths.
