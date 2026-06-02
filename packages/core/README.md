# @fricken/core

UI-agnostic TypeScript runtime for the Frick framework. Provides the `FrickClient` WebSocket runtime, signal-based subscriptions, local caches, offline-append queues, and sync-status diagnostics.

Pair with [`@fricken/react`](../react) for React hooks, or consume directly from any TS runtime.

## Install

```sh
pnpm add @fricken/core @fricken/protocol
```

## What's in here

- `FrickClient` — opens a sync WebSocket, sends Hello with capabilities, handles Delta/Ack/Nack frames, manages reconnect with exponential backoff
- `Signal<T>` primitive with `value` + `subscribe`
- `MemoryFrickCache` with schema-identity compatibility enforcement (throws `FrickCacheIncompatibleError` on schema-id mismatch or revision rollback)
- `client.objects(type)`, `client.stream(name, key)`, `client.presence(name, key)`, `client.signalChannel(name, key)`, `client.projection(name)`
- Append/upsert APIs with bounded pending queue and reconnect flush
- `client.track(...)` plus `trackAnalyticsEvent(...)` for authenticated product analytics
- `SyncStatus` with `serverCapabilities`, `schemaCompatibility`, `lastError`
- OpenTelemetry-compatible client telemetry for analytics requests and sync WebSocket transport. The default bridge is a no-op until the host app installs an OTel provider; pass `telemetry: false` to `FrickClient` to disable it.
- Generated error-code constants and guards exported from `@fricken/core/errors`

## Public subpaths

- `@fricken/core` — client runtime, cache, sync, auth, analytics, and telemetry defaults.
- `@fricken/core/analytics` — standalone analytics posting helpers.
- `@fricken/core/telemetry` — telemetry runtime types and OTel bridge helpers.
- `@fricken/core/errors` — generated error-code constants and guards for structured envelopes.

See [`docs/cross-platform-client-contract.md`](../../docs/cross-platform-client-contract.md) for the wire contract every client implements.

## License

See repository root.
