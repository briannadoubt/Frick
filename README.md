# Frick

Frick is a greenfield realtime data framework: one versioned schema, compact binary protocol frames, a SQLite-backed sync server, portable client cache/runtime code, and native demo apps that prove the same data contract across web, SwiftUI, and Android Compose.

This repository is in cutover posture. The old task/project prototype is intentionally gone, and local databases can be deleted when the schema changes.

## Foundation

- `packages/protocol`: canonical schema AST for objects, streams, events, presence, signals, blobs, jobs, and projections; compact record/event codecs; MessagePack realtime frames; Swift/Kotlin DTO artifact generation.
- `apps/server`: Node `node:sqlite` sync server with durable object storage, append-only stream events, presence leases, signal routing, blob/job metadata stores, REST bootstrap routes, and WebSocket sync at `/_frick/sync`.
- `packages/core`: UI-agnostic client runtime with local cache, subscriptions, append/presence/signal commands, cursors, and sync status.
- `packages/react`: React provider and hooks for objects, streams, presence, signals, appends, and sync status.
- `packages/swift`: reusable Swift package with generated DTOs, schema hash checks, SQLite storage, pending append replay, and typed APIs for the demo harness.
- `apps/android/frick`: reusable Android SDK module with generated Kotlin DTOs, Ktor Client 3.x, Android SQLite storage, pending append replay, and typed APIs for the demo harness.
- `apps/web`, `apps/ios`, `apps/android/app`: thin conformance apps that load `conversation-general`, render `MessageStream`, and append `MessageSent` events without becoming a chat product.
- `Tiltfile`: lightweight local dashboard for install, schema generation, server, and web.

## Local Ports

- Server: `http://127.0.0.1:4099`
- Schema: `http://127.0.0.1:4099/schema`
- Web: `http://127.0.0.1:5173`
- Sync WebSocket: `ws://127.0.0.1:4099/_frick/sync`

## Commands

```bash
pnpm install
pnpm schema:generate
pnpm test
pnpm typecheck
pnpm server
pnpm web
pnpm tilt
```

Native checks:

```bash
pnpm swift:test
pnpm ios:generate
pnpm ios:build
pnpm android:build
```

Native launch helpers:

```bash
pnpm android:emulator
pnpm android:install
```

The iOS simulator reads `http://127.0.0.1:4099`. The Android emulator reads `http://10.0.2.2:4099`.

## Local Data

The server database lives at `apps/server/data/frick.sqlite` by default. Because this branch is a greenfield cutover, reset local state with:

```bash
rm -f apps/server/data/frick.sqlite
```

Clients keep their own SQLite caches for objects, stream events, and pending appends. Those caches are development state, not migration targets.

## What The Harnesses Prove

- A single schema hash and DTO generation path is shared by TypeScript, Swift, and Kotlin.
- Server object snapshots and stream events can be read from browser and native clients.
- `MessageSent` appends flow through the same `/append` contract from web, iOS, and Android.
- React hooks exercise realtime WebSocket subscriptions, presence, and signals.
- Swift and Android clients use SQL-backed local state instead of toy preference storage.
- Android builds with AGP 9.2.x, API 37, JDK 17, Kotlin 2.3.x, Compose Compiler, lint warnings as errors, and Kotlin/Java compiler warnings as errors.
