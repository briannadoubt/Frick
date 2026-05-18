# Cross-Platform Client Contract

Status: Contract baseline for Slice 11 (Client Runtime Contract Alignment).

This document records the behavior every Frick client SDK (TypeScript, Swift, Android/Kotlin) is expected to share. Concrete API shapes vary per language; the semantics below do not.

## Schema Identity

Every generated artifact carries the same schema identity:

| Field | Source | Purpose |
| --- | --- | --- |
| `schemaId` | `frick-foundation` for the foundation schema | Stable application schema name |
| `schemaVersion` | Semantic version string, e.g. `0.1.0` | Human-readable version |
| `schemaRevision` | Monotonic positive integer | Migration ordering and compatibility checks |
| `schemaHash` | Content hash of the canonical schema | Strict equality check for "exact same schema" |
| `minimumClientRevision` | Positive integer | Lowest generated client revision a server can accept |
| `minimumServerRevision` | Positive integer | Lowest server revision a generated client can talk to |

All four supported platforms expose these constants via generated code (`FrickSchema.schemaId` in TS, `FrickSchema.schemaId` in Swift, `FRICK_SCHEMA_ID` in Kotlin).

## Shared Error Envelope

Every framework-visible error carries the same shape across HTTP responses, WebSocket nacks, and client-side typed errors:

```
{
  code: string,          // stable machine-readable code (see Error Codes)
  message: string,       // safe human-readable summary
  requestId: string,     // per-request or per-frame correlation id
  retryable: boolean,    // whether the client should auto-retry
  details?: object,      // optional structured metadata
  schemaHash?: string,   // present when the error involves schema state
  schemaRevision?: int,  // ditto
}
```

HTTP errors serialize the envelope as JSON under both `error` (the canonical location) and mirrored at the top level (`code`, `message`, `requestId`, `retryable`) for legacy compatibility. Clients should prefer the `error` field when present.

### Error Codes

Initial code families, in stable wire form:

- `auth.unauthenticated`
- `auth.forbidden`
- `auth.sessionExpired`
- `schema.incompatible`
- `schema.migrationRequired`
- `storage.conflict`
- `storage.notFound`
- `stream.appendRejected`
- `sync.protocolError`
- `sync.reconnectExhausted`
- `blob.tooLarge`
- `blob.unsupportedContentType`
- `rateLimit.exceeded`
- `server.internal`

Clients should treat unknown codes as opaque strings rather than failing decode. The TypeScript SDK uses a union type for compile-time exhaustiveness, while Swift and Kotlin use `RawRepresentable` / string constants so new codes parse without code changes.

### Typed Error Surface

| Platform | Type | Notes |
| --- | --- | --- |
| TypeScript | `FrickErrorEnvelope` (interface) | Returned in HTTP error bodies; appears on `SyncStatus.lastError`; isFrickErrorEnvelope guard for runtime checks |
| Swift | `FrickServerError(httpStatusCode, envelope?, body)` | `validate(response, data:)` parses both wrapped and direct envelope shapes |
| Kotlin | `FrickHttpException(statusCode, envelope?, responseBody, message)` | `parseFrickErrorEnvelope(body)` decodes both shapes |

## Capability Negotiation

Clients announce their capabilities during the WebSocket handshake (`Hello` frame) and the server replies with `HelloAck` before sending the schema snapshot:

- Client `clientCapabilities` field on `HelloPayload` (currently optional during the rollout slice).
- Server returns `HelloAckPayload` with the resolved `schemaCompatibility` result and the active `serverCapabilities`.

TypeScript, Swift, and Android clients all open WebSocket sync connections and participate in the Hello/HelloAck capability handshake. HTTP routes still exist for auth, initial REST helpers, blob/search operations, and some native client convenience methods.

### Capability Names

Server capabilities are reported as a flat list using these prefixes:

- `transport.<name>` — `websocket`, `http`, `sse`
- `encoding.<name>` — `msgpack`, `json`
- `primitive.<name>` — `objects`, `streams`, `presence`, `signals`, `blobs`, `jobs`, `projections`
- `blobUpload.<name>` — `direct`, `resumable`, `signedUrl`, `localOnly`
- `push.<name>` — `apns`, `fcm`, `webPush`, `test`
- `experimental.<name>` — arbitrary feature flags

A client lists names it strictly *requires* in `clientCapabilities.required`. The server rejects the handshake with a `sync.protocolError` nack carrying `details.unsupportedCapabilities` if any required capability isn't supported.

### WebSocket Session Credentials

`HelloPayload` carries an optional `sessionToken`. Clients authenticate WebSocket sessions by sending that Hello token or by using an `Authorization: Bearer ...` header on the upgrade request. The server does not authenticate `sessionToken` values from the WebSocket URL query string.

After the WebSocket upgrade, the server accepts only `Hello` and `Ping` until it has sent a compatible `HelloAck`. Any other pre-handshake frame is rejected with a structured `Nack` using `code: "sync.protocolError"` and `details.reason: "handshakeRequired"`; write frames rejected this way are not persisted.

Authenticated WebSocket sessions are tied back to the server session row. Logout closes active sockets for that session with policy close code `1008`, and every privileged WebSocket frame revalidates the session before authorization and persistence.

Forward stream pages are bounded by the server's `maxStreamPageSize` limit. HTTP stream reads, SSE initial pages, and WebSocket `StreamPage` frames include `cursor` and `hasMore`; clients should request the next page from the returned cursor when `hasMore` is true.

## Sync Diagnostics

Each client runtime exposes diagnostic fields covering the same observable state. The TypeScript runtime surfaces them on `SyncStatus`; Swift exposes `FrickSyncStatus` plus an async status stream; Android exposes `FrickSyncStatus` through a `StateFlow`.

| Field | Type | Meaning |
| --- | --- | --- |
| `connected` | boolean | Transport is live |
| `cursors` | record<string, number> | Last seen sequence per subscription |
| `pendingMutations` | number | Pending appends queued locally |
| `authenticated` | boolean | Session resolved |
| `userId` / `deviceId` | string? | Resolved identity |
| `serverCapabilities` | object? | Last `HelloAck` payload from the server |
| `schemaCompatibility` | object? | Result of `compareSchemaCompatibility` on `HelloAck` |
| `lastError` | `FrickErrorEnvelope`? | Last nack envelope the server returned |

The exact field names vary by language, but reconnect state, schema/capability handshake results, pending work, and last framework-visible errors should stay observable.

## Local Cache Compatibility

Every persistent local cache stores schema identity metadata so the SDK can refuse to load incompatible state.

### Stored Fields

Each cache persists a single-row table (or in-memory record) of:

- `schemaId`
- `schemaVersion`
- `schemaRevision`
- `schemaHash`
- `tenantId`
- `userId`

### Compatibility Rules

On load (TS) or via `verifyCacheCompatibility()` (Swift / Android), the SDK compares cached metadata to the current schema:

| Outcome | Reason | SDK behavior |
| --- | --- | --- |
| No cached metadata | (first run) | Stamp current schema, return empty state |
| Cached id matches, hash matches | exact | Use cache as-is |
| Cached id matches, revision ≥ minimum, hash differs | revision-compatible | Use cache; clients may surface a warning |
| Cached session scope differs | session-scope-mismatch | Refuse to load; clear or partition the cache before reconnecting |
| Cached id differs from current id | `schemaIdMismatch` | Throw typed incompatible-cache error |
| Cached revision < `minimumClientRevision` | `cacheTooOld` | Throw typed incompatible-cache error |

The typed error carries:

- The cached `FrickCacheMetadata` snapshot
- The current `FrickCacheMetadata` snapshot
- The `minimumClientRevision` that was applied
- The current `pendingAppendCount` so apps can warn before discarding queued mutations

### Reset

Each cache exposes a destructive `clear()` / `clearCache()` / `resetCache()` operation that wipes all framework tables (objects, stream events, pending appends, metadata) but leaves caller-owned state untouched. Apps in development mode are expected to call this in response to an incompatible-cache error; production apps surface the error and ask the user.

### Pending Appends

Pending appends are preserved across compatible reloads. When an incompatible-cache error is thrown, the typed error reports the queued count so apps can give the user an informed choice (drain by reset, or stay offline until a compatible build ships).

## Cross-SDK Invariants

| Invariant | TS | Swift | Android |
| --- | --- | --- | --- |
| `FrickSchema.schemaId/Version/Revision/Hash` constants | ✓ | ✓ | ✓ |
| Parses shared HTTP error envelope (wrapped + top-level shapes) | ✓ | ✓ | ✓ |
| Typed error surface for server-emitted errors | `FrickErrorEnvelope` | `FrickServerError` | `FrickHttpException` |
| Distinguishes server errors from network errors in retry predicates | ✓ | ✓ | ✓ |
| Local cache stamps schema identity on save | ✓ | ✓ (via `verifyCacheCompatibility`) | ✓ (via `verifyCacheCompatibility`) |
| Throws typed incompatible-cache error on schema-id or revision mismatch | `FrickCacheIncompatibleError` | `FrickCacheIncompatibleError` | `FrickCacheIncompatibleException` |
| Destructive cache reset entry point | `cache.clear()` | `FrickClient.resetCache()` | `FrickClient.resetCache()` |
| Capability negotiation in handshake | ✓ (WebSocket) | ✓ (WebSocket) | ✓ (WebSocket) |

## Client Telemetry

Client telemetry must observe framework behavior without changing it.
Telemetry failures are isolated from sync, writes, cache, and analytics
requests. Metric labels stay bounded; user, tenant, and app-provided values are
span attributes or analytics payload fields, not framework metric labels.

The TypeScript runtime currently provides the first implementation:

- `FrickClient` accepts `telemetry?: FrickClientTelemetryRuntime | false` and
  defaults to an OpenTelemetry API bridge. With no app-installed OTel provider,
  the bridge is a no-op. `setDefaultClientTelemetryRuntime(...)` can replace
  the process default for standalone helpers or host adapters.
- Analytics posts create `frick.analytics.track` client spans and
  `frick.client.analytics.events.total{status}` /
  `frick.client.analytics.duration_ms{status}` metrics. If the app does not
  supply `traceId`, the active telemetry span trace id is copied into the
  analytics event so server-side aggregates can correlate back to traces.
- Sync sockets create `WebSocket /_frick/sync` client spans plus sent/received
  frame counters and connection duration histograms. Frame `kind` labels are
  bounded to known protocol frame names or `unknown`, and close telemetry uses
  close code/category rather than raw close reason text.
  Analytics header injection sends `traceparent` only; app-defined OTel baggage
  is not forwarded by the default bridge.

Swift and Android should follow these semantics when their telemetry capture
surfaces land.

## Object Upserts Over the Sync Socket

Object upserts flow over the sync WebSocket via `FrameKind.ObjectUpsert`. The server honors the schema's `mergePolicy`: `lastWriteWins` accepts any write and increments the version, `versionPrecondition` requires `expectedVersion` to match the on-disk row and Nacks with `storage.conflict` otherwise. Successful upserts reply with an `Ack` carrying the new version. TypeScript exposes `FrickClient.upsertObject`, Swift exposes `FrickSyncSocket.upsertObject`, and Android exposes `FrickSyncSocket.upsertObject`; each queues or buffers writes while disconnected and flushes on reconnect.

## Presence Authorization

Presence subscriptions and writes over the sync WebSocket require an authenticated, active principal and run through the same structured authz envelope path as streams, objects, and signals. Foundation `TypingState` rows use the key shape `conversationId:userId:deviceId`; when the conversation is known locally, the server enforces conversation membership, and any user id present in the key or value must match the session principal. Failures Nack with `auth.forbidden` and `details.reason` such as `notMember` or `ownerMismatch`.

## Versioning

This contract document evolves alongside `packages/protocol` and is regenerated together with the schema artifacts. Any change that adds a new error code, capability prefix, sync diagnostic field, or cache state should land here in the same change as the protocol/SDK update.
