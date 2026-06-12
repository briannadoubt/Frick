# Map 04 — Core Primitive Semantics (objects, streams, presence, signals, sharing)

Implementation-grade specification for the Rust rewrite. Scope: the four sync
primitives + sharing grants/invitations as implemented in
`apps/server/src/**` with their wire surface in `packages/protocol/src/**`.
The Rust server must be byte-compatible on the MessagePack frame protocol,
the schema identity rules, and the error envelope.

All line numbers refer to the repo at commit `9f8652d` (v0.3.0).

> ⚠️ `apps/server/src/sync/gateway.ts` contains an intentional raw NUL byte
> (0x00) inside a template string (line 554). grep treats the file as binary —
> use `rg --text` or `grep -a`.

---

## 1. Wire fundamentals

### 1.1 Frame encoding

- Every WebSocket message is a **binary** frame containing one MessagePack
  value: a **2-element array** `[kind: int, payload]`
  (`packages/protocol/src/frame.ts:190-222`).
- Encode/decode use `@msgpack/msgpack` `encode`/`decode` with **default
  options** (frame.ts:215-222). Consequences for Rust:
  - JS objects encode as msgpack **maps with string keys in property
    insertion order**. Field order below is therefore normative for byte
    compatibility (decoders must not care, but emit in the listed order).
  - JS numbers encode as the smallest integer representation when integral,
    float64 otherwise. `Date.now()` values are uint64-range ints.
  - `undefined` properties are **omitted** (the code conditionally spreads
    optional fields, e.g. gateway.ts:1599).
  - Binary payloads (`packed` columns) are stored as msgpack-encoded
    `Uint8Array` buffers.
- WS endpoint path: **`/_frick/sync`**, `ws` `maxPayload` =
  `limits.maxWebSocketFrameBytes` (server.ts:759-762).
- `PROTOCOL_VERSION = 1` (frame.ts:13).

### 1.2 FrameKind enum (frame.ts:15-41) — values are wire-frozen

| Kind | Value | Direction |
|---|---|---|
| Hello | 0 | C→S |
| Schema | 1 | S→C (full `FrickSchema` object as payload) |
| Subscribe | 2 | C→S |
| Snapshot | 3 | S→C |
| StreamPage | 4 | S→C |
| Append | 5 | C→S |
| Ack | 6 | S→C |
| Nack | 7 | S→C |
| Delta | 8 | S→C |
| PresenceSet | 9 | C→S |
| PresenceClear | 10 | C→S |
| PresenceDelta | 11 | S→C |
| SignalSend | 12 | C→S |
| SignalDeliver | 13 | S→C |
| CursorCommit | 14 | C→S |
| Ping | 15 | both |
| Pong | 16 | both |
| SyncStatus | 17 | (client-internal; server never sends) |
| HelloAck | 18 | S→C |
| ProjectionDelta | 19 | S→C |
| ObjectUpsert | 20 | C→S |
| CallCommand | 21 | C→S (FR-15) |
| CallCommandResult | 22 | S→C (FR-15) |

`SubscriptionKind = "object" | "stream" | "presence" | "signal" | "projection"`
(frame.ts:43).

### 1.3 Frame payload shapes (field order = msgpack map order)

From frame.ts:45-188. All ids/keys/names are strings; cursors/sequences/
versions are integers.

- **HelloPayload**: `replicaId`, `deviceId`, `schemaHash`,
  `knownCursors: Record<string, number>`, `sessionToken?`,
  `clientCapabilities?`. **`knownCursors` is accepted and ignored by the
  server** (never read in gateway.ts).
- **SubscribePayload**: `subscriptionId`, `kind`, `name`, `key?`, `cursor?`.
- **SnapshotPayload**: `subscriptionId`, `objects: PackedRecord[]`, `cursor`.
- **StreamPagePayload**: `subscriptionId`, `events: PackedStreamEvent[]`,
  `cursor`, `hasMore: bool`.
- **AppendPayload**: `requestId`, `stream`, `key`, `event`,
  `payload: PlainObject`.
- **AckPayload**: `requestId`, `cursor?`, `version?`. `version` only on
  ObjectUpsert acks; `cursor` only on Append (= event sequence) and
  CursorCommit echoes; presence/signal acks carry `requestId` only.
- **ObjectUpsertPayload**: `requestId`, `objectType`, `objectId`,
  `value: PlainObject`, `expectedVersion?` (honored only for
  `versionPrecondition` schemas; ignored for lastWriteWins).
- **NackPayload**: `requestId`, `error: FrickErrorEnvelope`, `code?`,
  `message?` — the server **always** duplicates `code` and `message`
  top-level next to the envelope (every send site, e.g. gateway.ts:616,
  1106-1108).
- **HelloAckPayload**: `schemaHash`, `schemaId`, `schemaRevision`,
  `schemaCompatibility: SchemaCompatibilityResult`, `serverCapabilities`.
- **DeltaPayload**: `objects: PackedRecord[]`, `events: PackedStreamEvent[]`,
  `cursor`, `removed?: {type,id}[]` (FR-142; only present on delete deltas).
  NOTE: emit order in code for delete deltas is `{objects, events, removed,
  cursor}` (gateway.ts:798-801); for object/stream deltas `{objects, events,
  cursor}` (gateway.ts:818, 867-870).
- **PresenceSetPayload**: `requestId`, `name`, `key`, `value`.
- **PresenceClearPayload**: `requestId`, `name`, `key`.
- **PresenceDeltaPayload**: `subscriptionId`, `records:
  PackedPresenceRecord[]`, `cleared: string[]`.
- **SignalPayload** (SignalSend): `requestId`, `name`, `key`, `value`.
- **SignalDeliverPayload**: `{ envelope: PackedSignalEnvelope }` — no
  requestId.
- **CursorCommitPayload**: `subscriptionId`, `cursor`.
- **Ping**: `{ sentAt: number }`; **Pong**: `{ sentAt, receivedAt }`
  (receivedAt = server `Date.now()`).
- **ProjectionDeltaPayload**: `projection`, `changes: [{key, value|null}]`
  (null value = row delete).

### 1.4 Packed record encodings (codec.ts:21-163, schema.ts:182-184)

All packed forms are msgpack **arrays** (positional):

```
PackedField          = [fieldId: int, value: any]
PackedRecord         = [objectTypeId: int, recordId: string, fields: PackedField[]]
PackedStreamEvent    = [streamTypeId, streamKey: string, sequence: int,
                        eventId: string, eventTypeId: int, fields: PackedField[]]
PackedPresenceRecord = [presenceTypeId, presenceKey: string, fields: PackedField[]]
PackedSignalEnvelope = [signalTypeId, signalKey: string, fields: PackedField[]]
```

- `packFields` (codec.ts:149-154) maps **`Object.entries(value)` in insertion
  order** to `[field.id, value]` pairs; every key in `value` must resolve via
  `fieldByName` (throws `Unknown field <name>` otherwise — there is no
  unknown-field tolerance on pack). Field-id order on the wire is therefore
  the order of keys in the source object, NOT schema order.
- `unpackFields` (codec.ts:156-163) tolerates any order; unknown field ids
  throw `Unknown field id <id>`.
- `unpackObjectRecord` re-injects the record id:
  `value = { id: packed[1], ...unpackFields(...) }` (codec.ts:61-71). The
  stored packed record **never contains `id` as a field** — it is stripped
  before pack (`withoutRecordId`, object-store.ts:266-269; `packObjects`,
  gateway.ts:2359-2368).
- Object **tombstones** (FR-142) are packed records with an empty fields
  array: `packObjects(store, type, ids.map(id => ({id})))` →
  `[typeId, id, []]` (gateway.ts:780-784).

### 1.5 Error envelope (errors.ts)

```
FrickErrorEnvelope {
  code: FrickErrorCode;        // dotted string, see list
  message: string;
  requestId: string;
  retryable: boolean;
  details?: map;               // plain object, not array
  schemaHash?: string;
  schemaRevision?: int;
}
```

Canonical codes (errors.ts:12-29), **exhaustive**:
`auth.unauthenticated`, `auth.forbidden`, `auth.sessionExpired`,
`schema.incompatible`, `schema.migrationRequired`, `storage.conflict`,
`storage.notFound`, `stream.appendRejected`, `stream.invalidCursor`,
`sync.protocolError`, `sync.reconnectExhausted`, `blob.tooLarge`,
`blob.unsupportedContentType`, `blob.quotaExceeded`, `rateLimit.exceeded`,
`server.internal`.

`createFrickErrorEnvelope` is a shallow copy — emit fields in the literal
order: `code, message, requestId, retryable, details?, schemaHash?,
schemaRevision?`.

### 1.6 Schema model & identity (schema.ts)

- `FrickSchema` top-level fields (schema.ts:161-180): `name, schemaId,
  schemaVersion, schemaRevision, minimumClientRevision,
  minimumServerRevision, protocol: "frick.realtime", protocolVersion,
  compatibility: "greenfield-cutover", hash, objects, streams, events,
  presences, signals, blobs, jobs, projections`.
- **`hash` is an authored opaque string, not a computed digest.** Foundation
  schema uses `"frick-foundation-empty-0.1.0"` (foundation.ts:13). There is
  no canonical hash algorithm in the protocol; compatibility is decided by
  `schemaId` + revision bounds, with hash equality only distinguishing
  `exact` from `revisionCompatibleHashMismatch` (compatibility.ts:26-76).
  (SHA-256 appears only in the optional Ed25519 artifact-signing flow,
  signing.ts — not wire-relevant.)
- `validateSchema` (schema.ts:186-256) runs **`stableClone`**
  (schema.ts:494-514): recursively sorts all map keys alphabetically and
  drops `undefined`. The store keeps this normalized schema and the gateway
  sends it as the `Schema` frame — so **the Schema frame's msgpack maps have
  alphabetically-sorted keys**, unlike every other frame.
- Validation rules: protocol/compat literals must match; `schemaId`/
  `schemaVersion` non-empty strings; `schemaRevision`/`minimum*Revision`
  positive integers; per-type-set unique ids and case-insensitive unique
  names; enum fields require non-empty `enumValues`; `ref` targets must name
  an object or blob; index fields must exist; `sensitivity` ∈
  {public, private, pii, secret, content} (default `private`).
- `FieldKind = id|ref|string|bool|timestamp|int|bytes|enum|json`.
- `ObjectDef.mergePolicy?: "lastWriteWins" | "versionPrecondition"`,
  resolved by `resolveObjectMergePolicy` with fallback `lastWriteWins`,
  including for unknown type names (schema.ts:268-274).
- `PresenceDef`/`SignalDef` carry `ttlMs: number` (schema.ts:125-139).

### 1.7 Capabilities & compatibility

- `FrickClientCapabilities` / `FrickServerCapabilities`
  (capabilities.ts:23-49). Server always replies with
  `defaultServerCapabilities(schema)` (capabilities.ts:79-90):
  `{ schema:{schemaId,schemaRevision,schemaHash}, transports:["websocket",
  "http"], encodings:["msgpack","json"], primitives:["objects","streams",
  "presence","signals","blobs","jobs","projections"],
  blobUploads:["direct"], push:[], experimental:[], limits:{} }`.
- Required-capability check: client `required[]` names are matched against
  `serverCapabilityNames` = `transport.*`, `encoding.*`, `primitive.*`,
  `blobUpload.*`, `push.*`, `experimental.*` (capabilities.ts:92-109).
- `compareSchemaCompatibility(client, server)` (compatibility.ts:26-76),
  order of checks: (1) `schemaId` mismatch → incompatible
  `schemaIdMismatch`; (2) `client.schemaRevision <
  server.minimumClientRevision` → `clientTooOld`; (3)
  `server.schemaRevision < client.minimumServerRevision` → `serverTooOld`;
  (4) hash mismatch → compatible `revisionCompatibleHashMismatch` with
  message `"Schema revisions are compatible but hashes differ"`; (5) else
  compatible `exact` (no message field). Result fields: `compatible,
  reason, clientRevision, serverRevision, message?`.

---

## 2. Connection lifecycle (gateway.ts)

### 2.1 Connect

`SyncGateway#handleConnection` (gateway.ts:231-337):

1. Global cap: if `activeConnections >= limits.maxWebSocketConnections`
   (default 10_000), close `1013 "WebSocket connection limit exceeded"`; no
   Nack.
2. Optional connect-time auth: `Authorization: Bearer <token>` header on the
   upgrade request (`/^Bearer\s+(.+)$/i`, gateway.ts:2272-2276). A valid
   session yields a `Principal {userId, deviceId, replicaId, tenantId}` from
   the `auth_sessions` row.
3. Per-tenant limits resolved once per connection
   (`resolveTenantLimits`, tenant-config.ts:48-66 — shallow-merges the
   tenant_settings `limits` JSON over global defaults; only
   `maxBlobBytes, maxBlobBytesPerPrincipal, maxStreamAppendPayloadBytes,
   maxSubscriptionsPerConnection, maxPendingAppendsPerClient` are
   overridable). Cached for the connection lifetime.
4. Per-principal connection cap (default `maxConnectionsPerPrincipal = 64`),
   keyed by `` `${tenantId} ${userId}` `` — **literal NUL separator**
   (gateway.ts:553-555). Over cap → Nack `rateLimit.exceeded` with
   `requestId:"connect"`, `retryable:true`,
   `details:{limit:"maxConnectionsPerPrincipal", configuredMax}` then close
   `1013` (gateway.ts:603-623). In-process counters only — reset on restart.
5. Frame handling is **serialized per connection** through a promise chain
   (gateway.ts:304-310) so a client's frames are processed strictly in
   arrival order; concurrency exists only across connections.

### 2.2 Inbound frame guard (gateway.ts:1020-1087)

- Size check before decode: byte length > `maxWebSocketFrameBytes` (default
  524_288) → Nack `rateLimit.exceeded` `requestId:"frame"`,
  `retryable:false`, `details:{limit:"maxWebSocketFrameBytes",
  configuredMax}`, then close `1009 "frame too large"`.
- Any decode/handler throw → Nack `sync.protocolError`,
  `requestId:"unknown"`, message = error message.
- Metrics counter label = FrameKind enum **name** (`webSocketFrameKindLabel`),
  `"unknown"` for non-integer kinds.

### 2.3 Handshake gate (gateway.ts:1089-1110)

Before a successful Hello, every frame except `Hello` and `Ping` is Nacked
with `sync.protocolError`, message `"Hello handshake required before sync
frames"`, `details:{reason:"handshakeRequired"}`, plus `schemaHash` and
`schemaRevision` of the server schema. The Nack `requestId` is taken from
the frame: `subscriptionId` for Subscribe/CursorCommit, `requestId` for
Append/ObjectUpsert/PresenceSet/PresenceClear/SignalSend, else
`"pre-hello"` (gateway.ts:2278-2292).

### 2.4 Hello processing (gateway.ts:1113-1274)

Order of operations:

1. **Session auth** (`#authenticateHelloSession`, gateway.ts:2071-2123). No
   `sessionToken` in Hello → handshake proceeds unauthenticated (writes will
   later fail `auth.unauthenticated`). With a token:
   - invalid/expired → Nack `auth.unauthenticated` `"Invalid session token"`
     `details:{reason:"unauthenticated"}` + close `1008`;
   - device binding (opt-in `limits.bindSessionDevice`, FR-32): Hello
     `deviceId`+`replicaId` must equal the session row's; else Nack
     `auth.unauthenticated`, reason `sessionDeviceMismatch`, close 1008;
   - token resolving to a different principal than the connection's
     existing one → Nack `auth.forbidden`, reason
     `notAuthorizedForResource`, close 1008;
   - per-principal cap re-checked (idempotent for same key); over cap →
     Nack `rateLimit.exceeded` `requestId:"hello"` + close 1013.
2. **App routing** (FR-153): `clientCapabilities.schema.schemaId` is looked
   up in the app registry. On a genuine multi-app server (>1 registered
   apps), an advertised schemaId that matches no app and isn't the store
   schema's id → Nack `auth.forbidden` `"Advertised schemaId does not match
   any registered app"`, `details:{reason:"appNotAuthorized",
   knownAppIds:[...]}`. Connection `appId` is pinned to the matched app id
   (multi-app) or `"_default"` (gateway.ts:1140-1180).
3. **No clientCapabilities** (legacy): exact string equality of
   `hello.schemaHash` vs server schema hash (`rejectSchemaMismatch`,
   frame.ts:228-232). Mismatch → Nack `schema.incompatible`, message
   `"Schema mismatch: client=<h> server=<h>"`, with schemaHash/Revision.
   Match → success with `compareSchemaCompatibility(server, server)`
   (always `exact`).
4. **With clientCapabilities**: build a pseudo client schema = server schema
   with client's `schemaId/schemaRevision/hash` substituted
   (gateway.ts:2390-2397), run `compareSchemaCompatibility`. Incompatible →
   Nack `schema.incompatible` with the compatibility message and
   `details.appId` or `details.knownAppIds` when relevant.
5. **Required capabilities**: any unsupported → Nack `sync.protocolError`
   `"Client requires unsupported capabilities"`,
   `details:{unsupportedCapabilities:[...]}`.
6. **Success** (gateway.ts:1439-1456): send `HelloAck` then immediately a
   full `Schema` frame (the normalized, key-sorted schema). Handshake marked
   complete only here.

### 2.5 Per-frame principal re-validation (gateway.ts:2022-2069)

Every authenticated frame (Subscribe/Append/ObjectUpsert/PresenceSet/
PresenceClear/SignalSend/CallCommand) calls `#activePrincipalForFrame`:

- no principal → Nack `auth.unauthenticated` `"Missing session token"`;
- the session token is re-read from storage **on every frame**; expired →
  `SessionExpiredError` (maps to code `auth.unauthenticated` on WS — note:
  the WS Nack code for an expired session is `auth.unauthenticated`, not
  `auth.sessionExpired`; only HTTP distinguishes) + close 1008;
- principal changed under the token → Nack `auth.forbidden` `"Session
  principal changed"` + close 1008;
- archived tenant (tenantId starts with `"_archived_"`, unless
  `scope === "admin"`) → Nack `"Tenant is archived"` + close 1008.

Session revocation also live-closes sockets: `closeSession(token)` /
`closeSessionsForUser(userId, tenantId?)` close with `1008 "Session
revoked"` (gateway.ts:352-398).

### 2.6 Heartbeat (gateway.ts:692-711)

- Server sends `Ping {sentAt: Date.now()}` every
  `max(50ms, heartbeatIntervalSeconds*1000)` (default 25 s).
- If no inbound frame for `max(interval, heartbeatTimeoutSeconds*1000)`
  (default 60 s) → `socket.terminate()` (no close frame).
- Client `Ping` → `Pong {sentAt: <echo>, receivedAt: Date.now()}`
  (gateway.ts:1299-1301). Unknown frame kinds are silently ignored
  (gateway.ts:1302-1303).

### 2.7 Outbound backpressure (sync/wire.ts)

`sendFrame` drops the frame if `readyState !== 1`; if
`bufferedAmount + frame > maxWebSocketOutboundBufferedBytes` (default
1_048_576) **before or after** the send, close `1013 "WebSocket outbound
buffer exceeded"`.

---

## 3. Subscriptions (Subscribe frame; gateway.ts:1307-1437)

1. Re-auth principal (above).
2. Subscription cap: a **new** `subscriptionId` when
   `subscriptions.size >= maxSubscriptionsPerConnection` (default 256) →
   Nack `rateLimit.exceeded`, `details:{limit:
   "maxSubscriptionsPerConnection", configuredMax}`. Re-subscribing an
   existing id bypasses the cap (it overwrites the map entry).
3. `kind === "projection"`: unknown projection name → Nack `auth.forbidden`,
   `details:{reason:"projectionNotFound", projection}`.
4. **Authorization** via `assertCanSubscribe` (authz.ts:616-695) — maps kind
   to action: projection→`projection.read` (with cascade grants),
   signal→`signal.read` (+ WebRTC call-membership gate),
   presence→`presence.read`, stream→`stream.read` (with cascade grants).
   `kind === "object"` is **not checked at subscribe time** (falls through,
   authz.ts:682-684) — object visibility is enforced per record at
   snapshot/fan-out. Denial → Nack `auth.forbidden` or
   `auth.unauthenticated` with `message = decision.publicMessage`,
   `details:{reason: decision.reason}` (gateway.ts:2003-2020).
5. Register subscription (keyed by `subscriptionId` in a per-client map;
   registry matching is linear scan over all clients × subscriptions,
   sync/subscriptions.ts:20-79). Matching rules: stream/presence/signal
   match `(kind, name, key)`; object matches `(kind, name)` only;
   projection matches `(kind, name)` (key reserved, unenforced).
6. **Initial data**:
   - `projection`: a `ProjectionDelta` frame containing
     `snapshot(name, tenantId)` rows (upsert changes), filtered by
     `filterProjectionChangesForPrincipal` (currently identity,
     gateway.ts:2342-2350).
   - `stream`: requires `key` (missing → throws → generic
     `sync.protocolError` Nack via the outer catch; message
     `"stream subscription <name> requires key"`). Reads
     `cursor = payload.cursor ?? 0`, fetches `maxStreamPageSize + 1`
     events with `sequence > cursor`, replies `StreamPage
     {subscriptionId, events: first N packed, cursor: last
     event sequence ?? cursor, hasMore}` (gateway.ts:1390-1407). **One page
     only** — clients re-Subscribe (or use HTTP) to page further.
   - `object`: replies `Snapshot {subscriptionId, objects, cursor: 0}`.
     Rows = `listObjectsForUser(tenant, type, userId, appId)` (tenant+app
     scoped list, ordered by `object_id ASC`; `isObjectVisibleToUser` is
     allow-all today, store.ts:1160-1182) then per-record read filter
     (§9.4) when active.
   - `presence` / `signal`: **no reply frame at all** (no ack, no initial
     state). Presence state arrives only on subsequent set/clear; queued
     signals are not flushed on subscribe.
7. `CursorCommit` is a **no-op echo**: replies
   `Ack {requestId: subscriptionId, cursor}` without persisting anything
   (gateway.ts:1296-1298).

---

## 4. Objects

### 4.1 Persistence model (storage/object-store.ts, migrations 0003/0021)

Table `objects`:
`(app_id TEXT NOT NULL DEFAULT '_default', tenant_id, object_type,
object_id, version INTEGER NOT NULL, packed BLOB, updated_at TEXT)` —
**PRIMARY KEY (tenant_id, object_type, object_id)**; `app_id` is an
additive column, *not* part of the PK (migrations.ts:244-257, 0021).
`packed` = msgpack(`PackedRecord`) with the `id` field stripped from the
value. `updated_at` = `new Date().toISOString()`.

- Reads always filter `app_id = ? AND tenant_id = ? AND object_type = ? AND
  object_id = ?` (object-store.ts:141-148); list orders `object_id ASC`.
- **Cross-app write guard (FR-37)**: before any write, the row's owning
  `app_id` is read by PK; if the row exists with a different app id, throw
  `FrickCrossAppAccessError {code:"storage.crossAppDenied",
  reason:"appMismatch"}` (object-errors.ts:45-71; object-store.ts:231-243).
  HTTP maps this to 409. Reads from the wrong app simply see "not found".
- Upsert SQL: `INSERT ... ON CONFLICT(tenant_id, object_type, object_id) DO
  UPDATE SET app_id=excluded.app_id, version=excluded.version,
  packed=excluded.packed, updated_at=excluded.updated_at`
  (object-store.ts:246-256).

### 4.2 Versioning & merge policies

`upsertWithPolicy` (object-store.ts:82-133) runs inside a driver
transaction (SQLite `BEGIN IMMEDIATE`):

- Read current `version` (0 if absent), `exists` flag.
- `lastWriteWins` (default): unconditional; `nextVersion =
  previousVersion + 1`.
- `versionPrecondition`:
  - `expectedVersion === undefined` = **create intent**: if the row exists →
    `FrickObjectVersionConflictError{expectedVersion: undefined,
    actualVersion}`; else `nextVersion = 1`.
  - `expectedVersion` given: must equal on-disk version (0 means "expect
    absent"); mismatch → conflict error; else `nextVersion =
    expectedVersion + 1`.
- Result `{previousVersion, nextVersion, created}`.
- Conflict error message:
  `Version conflict on <type>/<id>: expected <n|create>, actual <m>`
  (object-errors.ts:22-25).
- **Legacy positional `upsert(tenant, type, id, value, version, appId)`**
  writes the supplied `version` **verbatim** (store facade defaults it to
  `0`) with no read-modify-write (object-store.ts:65-74; store.ts:953-1018)
  — used by projections/seeds/dev-login; not exposed to clients.
- `delete` is a hard DELETE; no soft-delete; a re-created id restarts at
  version 1 (object-store.ts:175-186).
- `readVersion` returns 0 for missing rows (used for HTTP ETags).

### 4.3 WS write flow — ObjectUpsert (gateway.ts:1542-1635)

1. Principal re-validation.
2. **Shared pending-write counter with Append**: if outstanding writes ≥
   `maxPendingAppendsPerClient` (default 1000) → Nack `rateLimit.exceeded`
   `"Pending write queue is full"`, `retryable:true`. (No payload-size check
   beyond the frame limit for object upserts.)
3. `assertCanWriteObject` (authz.ts:719-742): action `object.write`,
   resource `{kind:"object", name:type, key:id, tenantId:principal.tenant}`,
   context `{value}`; baseline ALLOW for authenticated tenant users
   (admin always; authz.ts:354-366); policy hooks may tighten; grants may
   relax a `notAuthorizedForResource`/`ownerMismatch` deny when an active
   grant with `write` permission exists (§9.3).
4. `store.upsertObjectWithPolicy({tenantId, appId, type, id, value,
   expectedVersion?})`. The schema-resolved merge policy is applied
   server-side; **client-sent `expectedVersion` is ignored for
   lastWriteWins types** (it is passed through but the store ignores it).
5. Ack `{requestId, version: nextVersion}`.
6. Version conflict → Nack `storage.conflict`, `retryable:false`,
   `details:{expectedVersion?, actualVersion, mergePolicy}` +
   schemaHash/Revision (gateway.ts:1610-1629).
7. **No inline broadcast** — fan-out happens via the store write listener
   (§8).

### 4.4 HTTP write flow (server.ts:1762-1860)

- Path `/objects/:type/:id` (regex `^\/objects\/([^/]+)\/([^/]+)$`,
  URL-decoded), methods POST or PUT (identical), DELETE.
- `If-Match` header → `expectedVersion`: absent/empty/`*` → undefined;
  accepts `"3"`, `3`, `W/"3"`; otherwise must parse to a non-negative
  integer or 400 (server.ts:3629-3644).
- Body = the object value (JSON object); a body `id` property is stripped
  before persisting/echoing (`withoutEnvelopeId`).
- Success: `ETag: <nextVersion>` header; status **201 if created else
  200**; JSON body `{schemaHash, object: {id, ...value}, version,
  previousVersion, mergePolicy}`.
- Conflict: 409, `ETag: <actualVersion>`, body `{error: envelope, code,
  message, requestId:"object_write_conflict", retryable:false}` with
  `details:{tenantId, objectType, objectId, expectedVersion?,
  actualVersion, mergePolicy}`.
- DELETE: write-authz first, then hard delete; always responds **200**
  (despite a comment claiming 204) with `{schemaHash, existed: bool}`
  (server.ts:1786-1789). Idempotent.
- List: `GET /objects?type=<T>` → 400 `{error:"type_required"}` if missing;
  else `{schemaHash, type, data: PlainObject[]}` (unpacked values incl.
  `id`). Tenant+app scoped; no per-record read filter on this route today
  (visibility hook is allow-all).
- There is **no HTTP GET-by-id object route**.

### 4.5 Object fan-out (gateway.ts:677-690, 733-803, 822-907)

On every successful upsert (any origin — WS, HTTP, server-side job):
`FrickStoreWriteEvent{kind:"objectUpsert"}` fires → `publishObjects(type,
[storedObject], tenantId, appId)`:

- Local fan-out to `objectSubscribers(type)` where: principal exists & is
  active; `principal.tenantId === tenantId`; subscriber `appId` matches.
- Per-record read authz applies only when `policyHooks.length > 0 ||
  grants table non-empty` (`#perRecordReadAuthzActive`, gateway.ts:882-884
  — `EXISTS` probe per fan-out batch). Filtered rows are dropped; empty
  result → no frame.
- Frame: `Delta {objects: [PackedRecord], events: [], cursor: Date.now()}`.
  **The object delta cursor is a wall-clock ms timestamp, not a sequence.**
- The broadcast value is the **stored, post-merge state re-read from disk**
  (store.ts:976, 1074), not the client's submitted value.
- Deletes (FR-142): `Delta {objects: [tombstone PackedRecord with empty
  fields], events: [], removed: [{type,id}], cursor: Date.now()}` to all
  tenant/app-matched subscribers — **no per-record authz on deletes** (row
  is gone; tenant scope is the boundary).
- Cluster bus: envelopes `{kind:"objects"|"objectDeletes", originNodeId,
  tenantId, appId, type, objects|ids}` are published after local fan-out;
  peer envelopes run the same local fan-out without re-publishing
  (gateway.ts:916-988).

---

## 5. Streams

### 5.1 Persistence (storage/stream-store.ts; migrations 0003/0021)

Table `stream_events`:
`(app_id DEFAULT '_default', tenant_id, stream_type, stream_id,
sequence INTEGER, event_id TEXT, event_type TEXT, packed BLOB,
replica_id TEXT, request_id TEXT, created_at TEXT)` —
**PRIMARY KEY (tenant_id, stream_type, stream_id, sequence)** (app_id not
in PK); unique index `(tenant_id, event_id)`.

Table `idempotency_keys`:
`(app_id, tenant_id, replica_id, request_id, result_event_id, created_at)`
— **PRIMARY KEY (app_id, tenant_id, replica_id, request_id)** (migration
0023).

### 5.2 Append algorithm (stream-store.ts:155-230)

Input `{appId='_default', tenantId, requestId, replicaId, stream, streamId,
event, payload}`:

1. **Idempotency lookup**, key `` `${appId}|${tenantId}|${replicaId}|${requestId}` ``
   (pipe-joined for the in-process LRU). LRU front-cache (default capacity
   10_000) → durable `idempotency_keys` row → resolve `result_event_id` to
   the stored event. A hit within the **replay window** (default 24 h,
   enforced at lookup against `created_at`; unparseable timestamps fail
   closed) returns `{event: original, created:false}` — the WS ack then
   carries the *original* sequence.
2. `sequence = COALESCE(MAX(sequence),0)+1` scoped to
   `(tenant_id, stream_type, stream_id)` — **across all app_ids** because
   the PK is tenant-scoped (stream-store.ts:394-411). Apps share the
   sequence space of an identical (tenant, stream, streamId).
3. `eventId = "event-" + randomUUID()` (UUIDv4).
4. Pack `PackedStreamEvent`, insert row with `created_at = ISO-8601 now`.
   ⚠️ `nextSequence` + INSERT are **not wrapped in a transaction**; the PK
   makes a concurrent duplicate fail with a constraint error (surfaced as a
   generic error; no retry loop). The single-writer SQLite + per-connection
   frame serialization makes this rare in practice.
5. Upsert the idempotency row
   (`ON CONFLICT(app_id,tenant_id,replica_id,request_id) DO UPDATE SET
   result_event_id, created_at`) — an out-of-window replay mints a fresh
   event and repoints the old row (stream-store.ts:205-225).
6. Cache `{event, createdAtMs}` and return `{event, created:true}`.

`StoredEvent = {stream, streamId, sequence, eventId, event, payload,
tenantId, appId}`.

### 5.3 WS append flow (gateway.ts:1458-1540)

1. Principal re-validation.
2. Pending cap (shared with ObjectUpsert): ≥ `maxPendingAppendsPerClient`
   → Nack `rateLimit.exceeded` `"Pending append queue is full"`,
   `retryable:true`.
3. **Payload size**: msgpack-encode `payload.payload`; if
   `> maxStreamAppendPayloadBytes` (default 256_000) → Nack
   `stream.appendRejected`, `retryable:false`,
   `details:{reason:"payloadTooLarge", configuredMax}`.
4. `assertCanAppend` — action `stream.append`, resource
   `{kind:"stream", name, key}`; baseline ALLOW; hooks tighten; **no grant
   relaxation for appends** (cascade is read-only).
5. `store.appendEvent({tenantId, appId, requestId, replicaId:
   principal.replicaId, stream, streamId:key, event, payload})`. Note the
   idempotency replicaId is the **session's** replicaId, not a frame field.
6. Ack `{requestId, cursor: result.event.sequence}` (replays ack the
   original sequence; `created` is not exposed on the wire).

### 5.4 Replay / cursors

- **WS Subscribe** (kind=stream): single forward `StreamPage` from
  `cursor ?? 0` (exclusive), page = `maxStreamPageSize` (500), `hasMore`
  via N+1 probe (§3.6).
- **Live deltas**: each created append fans out
  `Delta {objects:[], events:[packed], cursor: sequence}` to matching
  stream subscribers (tenant + app + exact key match)
  (gateway.ts:805-820).
- **HTTP `GET /streams/:stream/:key`** (server.ts:2636-2738), authz =
  `stream.read` incl. cascade grants:
  - `?since=<seq>`: strict integer ≥ 0 else 400 `stream.invalidCursor`;
    returns `{events}` ascending, limit `?limit` clamped to
    `[1, maxStreamPageSize]`.
  - default forward read `?after=<seq>` (default 0): returns
    `{schemaHash, stream, key, data, cursor, hasMore}` (N+1 probe; cursor =
    last sequence or `after`).
  - `?before=<seq>`: backwards page for scrollback, exclusive cutoff,
    default limit 50, clamp `[1, min(500, maxStreamPageSize)]`; events
    returned **oldest-first** (read DESC, then reversed;
    stream-store.ts:329-353); non-finite/≤0 `before` →
    `Number.MAX_SAFE_INTEGER`.
  - `GET /streams/:stream/:key/cursor`: `{headSequence, count}` —
    `COALESCE(MAX(sequence),0)` + `COUNT(*)` (FR-116). NOTE: this probe
    calls `store.streamHead` without the connection appId → **always
    `_default` app scope** (store.ts:1357-1363).
  - `GET /streams/:stream/:key/events`: SSE (`text/event-stream`), capped
    by `maxSseConnections` (else 429 `rateLimit.exceeded`). Initial event
    `stream-page` with `{schemaHash, stream, key, data, cursor, hasMore}`;
    live appends arrive as `delta` events `{schemaHash, stream, key,
    data:[event], cursor: sequence}`; keep-alive comments every 15 s;
    buffer cap 1 MiB → destroy (sync/sse.ts). Header
    `x-frick-schema-hash` on open.
- **HTTP `POST /append`** body `{stream, key, event, payload, requestId}`
  (all required; payload size-checked) → `{ok:true, event: StoredEvent}`
  (server.ts:2740-2776). Replays return the original event with `ok:true`.
- **CursorCommit is not persisted** — there is no server-side cursor store;
  cursors are client state.

### 5.5 Ordering guarantees

- Per `(tenant, stream, streamId)`: strictly increasing contiguous
  `sequence` starting at 1 (gaps only via retention pruning).
- Frames from one connection are processed in order (promise chain); acks
  are sent after the durable insert.
- Fan-out delivery order to a given subscriber follows the append commit
  order on a single node; cross-node ordering is whatever the cluster bus
  provides (no global ordering guarantee).
- Stream events are immutable; no update/delete API (only opt-in retention
  pruning, FR-145: per-stream-type `maxAgeMs`/`maxEvents` policies, default
  keep-forever; stream-store.ts:431-480).

---

## 6. Presence

### 6.1 Persistence (storage/presence-store.ts; migration 0023)

Table `presence_leases`:
`(app_id, tenant_id, presence_type, presence_key, packed BLOB,
expires_at INTEGER)` — **PRIMARY KEY (app_id, tenant_id, presence_type,
presence_key)**. `expires_at` is **epoch milliseconds** (integer), unlike
the ISO strings used elsewhere. `packed` = msgpack(`PackedPresenceRecord`).

- `set` = upsert with `expires_at = Date.now() + ttlMs`.
- `read` lazily deletes-and-returns-undefined when `expires_at <= now`
  (presence-store.ts:55-73). **There is no background expiry sweeper and no
  expiry broadcast** — subscribers never learn a peer expired unless an
  explicit PresenceClear arrives or they re-read.
- `clear` = hard DELETE.

### 6.2 Join/heartbeat = PresenceSet (gateway.ts:1637-1689)

1. Principal re-validation; `assertCanWritePresence` (action
   `presence.write`, resource `{kind:"presence", name, key}`, context
   `{value}`; baseline ALLOW; hooks tighten; no grant relaxation).
2. TTL: `presenceByName(schema, name).ttlMs / 1000` clamped to
   `[presenceTtlMinSeconds=5, presenceTtlMaxSeconds=600]` seconds
   (`clampTtlSeconds`, limits.ts:217-236; non-finite → max; clamping logs a
   console warning). The clamped value × 1000 is the lease ttlMs. Clients
   refresh by re-sending PresenceSet (heartbeat = repeated set).
3. `store.setPresence(tenant, name, key, value, ttlMs, appId)`.
4. Fan-out `PresenceDelta {subscriptionId, records:[packed(key,value)],
   cleared: []}` to presence subscribers matching `(name, key)` + tenant +
   app (gateway.ts:1733-1759). The packing fails (→ protocolError Nack) if
   `value` has fields unknown to the presence schema.
5. Cluster publish `{kind:"presenceDelta", ..., records:[{key,value}],
   cleared:[]}`.
6. Ack `{requestId}` (sent **after** fan-out).

### 6.3 Leave = PresenceClear (gateway.ts:1691-1725)

Same authz (without value); `clearPresence`; fan-out `PresenceDelta
{subscriptionId, records: [], cleared: [key]}`; cluster publish; Ack
`{requestId}`.

### 6.4 Notes

- No HTTP surface for presence (server.ts has no /presence routes).
- Presence subscribe returns no initial state (§3.6) — a new subscriber
  sees only future sets/clears.
- Per-key lease: one value per `(app, tenant, type, key)`; last write wins
  unconditionally; no versioning.

---

## 7. Signals

### 7.1 Persistence (storage/signal-store.ts; migration 0001/0021)

Table `signal_outbox`:
`(id INTEGER PRIMARY KEY AUTOINCREMENT, app_id, tenant_id, signal_type,
signal_key, packed BLOB, expires_at INTEGER-epoch-ms)`.

- `enqueue` inserts a row with `expires_at = Date.now() + ttlMs`.
  **ttlMs is always the store default 30_000 ms** — both the WS and HTTP
  paths pass `undefined` (gateway.ts:1782-1789; server.ts:2587-2594) and
  `store.enqueueSignal` defaults `?? 30_000` (store.ts:1406-1428).
  **`SignalDef.ttlMs` from the schema is never consulted**, and
  `signalTtlMinSeconds`/`signalTtlMaxSeconds` in FrickLimits are dead
  config (defined, never used).
- `drain` (signal-store.ts:46-73) is a single atomic
  `DELETE ... WHERE expires_at > now RETURNING id, packed`
  (at-most-once claim across concurrent drains), results re-sorted
  `id ASC` in process. Expired rows are not returned but **are deleted**
  by the same statement? — No: the WHERE excludes expired rows, so expired
  rows linger until... nothing deletes them except future drains never
  match them. (No sweeper; expired signal rows accumulate until a manual
  cleanup. Surprising but true — verify before "fixing".)

### 7.2 WS send flow — SignalSend (gateway.ts:1761-1799)

1. Principal re-validation; `assertCanSignal` (action `signal.send`,
   baseline ALLOW, hooks tighten, then the **WebRTC call-signal gate**:
   when calls are enabled and `name === callControlPlane.webrtcSignalName`,
   the sender must be a participant/invitee of call `key`, else deny
   `notMember`; missing key → deny `"WebRTC signals must target a call"`;
   authz.ts:399-420, 1023-1053).
2. `store.enqueueSignal(tenant, name, key, value, undefined, appId)` —
   durable 30 s outbox entry (delivery to currently-offline receivers via
   later HTTP drain).
3. `routeSignal` (sync/signal-router.ts): skip entirely if tenant is
   archived; pack envelope once; deliver `SignalDeliver {envelope}` to all
   signal subscribers matching `(name, key)` + tenant + app.
4. Ack `{requestId}`.
5. NOTE: the WS path does **not** publish to the cluster bus (only
   `publishSignal` — the HTTP path — does, gateway.ts:990-1018). WS-sent
   signals reach local subscribers only, plus the durable outbox.

### 7.3 HTTP surface (server.ts:2562-2634)

- `POST /signals/:name/:key` body = value object → authz `signal.send`
  (+call gate) → enqueue + `gateway.publishSignal(...)` (local fan-out +
  cluster publish, requestId `"http"`) → `{ok:true}`.
- `GET /signals/:name/:key` → authz `signal.read` (+call gate) → **drain**
  (destructive read) → `{schemaHash, name, key, data: PlainObject[]}`.

---

## 8. Single write funnel & ordering (FR-114)

`FrickStore` is the only emission point for change notifications
(store.ts:331-358, 1283-1311):

- `upsertObject` / `upsertObjectWithPolicy` → notify projections → notify
  search indexes → fire `#writeListener({kind:"objectUpsert", tenantId,
  appId, objectType, objectId, object: storedPostMergeState})`.
- `deleteObject` → `{kind:"objectDelete", ...}` only when a row was
  actually removed.
- `appendEvent` → notifications only when `created === true` (idempotent
  replays are silent).
- The **gateway is the sole registered listener** (gateway.ts:217) and the
  sole broadcaster: WS handlers and HTTP routes never broadcast inline, so
  one write → exactly one fan-out + one cluster publish + one SSE bridge
  push (`options.onStreamEvent`, gateway.ts:686-689 → `sse.
  publishStreamEvent`). Listener exceptions are swallowed and logged —
  fan-out failure never fails the write (store.ts:1299-1311).
- Projection deltas: handlers may declare changed rows; the registry's
  delta listener (set by the gateway) broadcasts
  `ProjectionDelta {projection, changes}` to tenant/app-matched
  subscribers and the cluster bus (gateway.ts:625-666).

Cluster envelopes (`cluster/bus.ts`) carry
`{kind, originNodeId, tenantId, appId, ...}` for kinds `streamEvent`,
`objects`, `objectDeletes`, `signal`, `projectionDelta`, `presenceDelta`;
receivers run the local-only fan-out paths and never re-publish
(gateway.ts:916-988). Missing `appId` from older peers defaults to
`_default`.

---

## 9. Authorization pipeline (authz.ts)

### 9.1 Principal

`Principal {userId, deviceId, replicaId, tenantId, scope?: "tenant"|
"admin"|"service", serviceScopes?}` (authz.ts:51-89). WS principals are
always derived from `auth_sessions` rows; HTTP additionally supports the
admin bearer (`scope:"admin"`, tenant `_default`) and service-principal
keys (`sk_<id>.<secret>`, `scope:"service"` with scope strings).

### 9.2 decide() baseline (authz.ts:298-380)

Order: (1) no principal → deny `unauthenticated`; (2) tenant boundary —
when `resource.tenantId` is supplied and differs from
`principal.tenantId` and scope ≠ admin → deny `tenantMismatch`
(callers whose storage lookups are already tenant-scoped omit
resource.tenantId and rely on not-found); (3) per-action:

| action | baseline |
|---|---|
| blob.read / blob.write | allow iff `resource.ownerId === principal.userId`, else deny `ownerMismatch` |
| signal.send / signal.read | ALLOW |
| presence.read / presence.write | ALLOW |
| projection.read | ALLOW |
| search.query | ALLOW (route layer adds explicit-opt-in for custom indexes) |
| object.write | admin → ALLOW; missing type name → deny; else ALLOW |
| stream.read / stream.append | ALLOW |
| call.create | ALLOW (tenant-membership of creator+invitees pre-checked) |
| anything else (incl. **object.read**) | deny `notAuthorizedForResource` "Action not authorized" |

Decision reasons: `allow, unauthenticated, notAuthorizedForResource,
notMember, ownerMismatch, schemaIncompatible, tenantMismatch`.

### 9.3 Hooks + grant relaxation (authz.ts:442-587)

`decideWithHooks` = `relaxWithCascadeGrants(relaxWithGrants(
applyPolicyHooks(decide(input))))`:

- **Policy hooks** (`FrickPolicyHook = (input) => FrickDecision | null`)
  are synchronous, run in registration order, and can only **tighten** an
  allow into a deny (first deny wins; `null` = no opinion; hooks are
  skipped entirely when the baseline already denied).
- **relaxWithGrants** (object records): eligible iff action ∈
  {object.read, object.write}, deny reason ∈ {notAuthorizedForResource,
  ownerMismatch}, resource is `{kind:"object", name, key}` — then
  `grantLookup({tenantId: principal.tenantId, granteeUserId:
  principal.userId, recordType: name, recordId: key, required:
  action==="object.write" ? "write" : "read"})`; true flips to ALLOW.
- **relaxWithCascadeGrants** (FR-70, derived primitives): eligible iff
  action ∈ {stream.read, projection.read}, deny reason ∈
  {notAuthorizedForResource, ownerMismatch, notMember}, resource kind ∈
  {stream, projection} **with a concrete `key`** (whole-projection
  subscribes fail closed) — then `cascadeGrantLookup({tenantId,
  granteeUserId, recordId: key})` which matches **any active grant whose
  record_id equals the stream's streamId / projection row key, regardless
  of recordType**, with permission satisfying `read` (`write` satisfies
  `read`; sharing.ts:129-137). Read-only — never relaxes appends/writes.
- Blob cascade (FR-71): `assertCanReadBlob` relaxes only `ownerMismatch`
  via the same record-id cascade with `recordId = blobId`
  (authz.ts:1069-1101).

### 9.4 Per-record subscription visibility (FR-116; authz.ts:803-819)

`canSubscriberReadObjectRecord` — used by object snapshot, live object
fan-out, and search-hit filtering — differs from `assertCanReadObject`:
the baseline is **ALLOW** (tenant-wide visibility, the historic behavior),
hooks may tighten per record, grants relax back. Objects lacking a string
`id` are treated as readable (gateway.ts:894-907). The whole layer is
skipped (allow-all) when there are no hooks and the grants table is empty.

### 9.5 Hook integration points (exact call sites)

| Path | assert | action |
|---|---|---|
| WS Subscribe | assertCanSubscribe | stream.read / presence.read / signal.read / projection.read (object: none) |
| WS Append, HTTP /append | assertCanAppend | stream.append |
| WS ObjectUpsert, HTTP object write/DELETE | assertCanWriteObject | object.write (+grants) |
| WS PresenceSet/Clear | assertCanWritePresence | presence.write |
| WS SignalSend, HTTP signal POST | assertCanSignal | signal.send (+call gate) |
| HTTP signal GET | assertCanReadSignal | signal.read (+call gate) |
| HTTP stream GET/SSE | assertCanSubscribe("stream") | stream.read (+cascade) |
| object snapshot / delta / search hits | canSubscriberReadObjectRecord | object.read (allow-baseline) |
| WS CallCommand create | assertCanCreateCall | call.create + tenant membership of creator & invitees |

`tenantMembershipReader(store, tenantId)` scopes `hasUser` to the
principal's tenant (authz.ts:153-162); membership = existence of an
`auth_accounts` row (`store.hasUser` → `accounts.readByIdentity`).

---

## 10. Sharing: invitations, grants, ACL semantics

### 10.1 Model (packages/protocol/src/sharing.ts)

Two-phase, deliberately separated so a recipient never sees the owner's
identity until redemption:

- **Invitation** (transient, single-use): `{id, tenantId, ownerUserId,
  recordType, recordId, permission: "read"|"write", token, createdAt,
  expiresAt, redeemedAt?, redeemedByUserId?}` — RFC 3339 timestamps.
- **Grant** (durable): `{id, tenantId, ownerUserId, recordType, recordId,
  granteeUserId, permission, createdAt, revokedAt?}`.
- Constants: `DEFAULT_FRICK_INVITATION_TTL_SECONDS = 14*24*3600` (14 d);
  `MAX_FRICK_INVITATION_TTL_SECONDS = 90*24*3600` (90 d, clamp).
- `frickSharingPermissionSatisfies(p, required)`: read ⇐ {read, write};
  write ⇐ {write}.

### 10.2 Storage

Tables (migration 0017, migrations.ts:785-820): `invitations` (PK id,
unique index on `token`, indexes `(tenant_id, owner_user_id, created_at
DESC)` and `(tenant_id, record_type, record_id)`); `grants` (PK id,
indexes on owner / grantee `(tenant, *, created_at DESC)` and
`(tenant_id, record_type, record_id, grantee_user_id)`). No app_id column
on either — **sharing is tenant-scoped, app-agnostic**.

### 10.3 HTTP routes (server.ts:1923-2126) — all require a session principal

- **`POST /share/invite`** body `{recordType, recordId, permission,
  expiresInSeconds?}` →
  - `permission` must be exactly `"read"` or `"write"` (else 400);
  - `expiresInSeconds`: omitted → 14 d; must be a positive finite number,
    floored, clamped to ≤ 90 d;
  - invitation `id = "inv-" + randomToken(12)`, `token = randomToken(32)`
    where `randomToken(n) = randomBytes(n).toString("base64url")` (12
    bytes → 16 chars; 32 bytes → 43 chars);
  - `ownerUserId = principal.userId`, `tenantId = principal.tenantId`;
  - **no ownership check on the record** — any tenant user can mint an
    invitation for any (recordType, recordId) string; authority comes from
    what the resulting grant can relax, not from invite issuance;
  - 201 `{invitation}` (token included — the only time it's returned).
- **`POST /share/accept`** body `{token}` → `invitations.redeem` outcomes
  (invitation-store.ts:92-125; checked in order notFound → tenantMismatch
  → alreadyRedeemed → expired):
  - notFound → 403 `auth.forbidden` "Invitation token is invalid"
    (reason `notAuthorizedForResource`);
  - tenantMismatch (redeemer's tenant ≠ invitation tenant) → 403, reason
    `tenantMismatch`;
  - expired (`expiresAt <= now`) → 403 "Invitation has expired";
  - alreadyRedeemed → 403 "Invitation has already been redeemed";
  - self-accept (`ownerUserId === principal.userId`) → 403 "Owners cannot
    accept their own invitations";
  - ok → stamp `redeemed_at`/`redeemed_by_user_id`
    (`UPDATE ... WHERE id=? AND redeemed_at IS NULL`) and create grant
    `{id:"grant-"+randomToken(12), tenantId/ownerUserId/recordType/
    recordId/permission copied from the invitation, granteeUserId:
    principal.userId, createdAt: now}` → 201 `{grant}`.
  - ⚠️ redeem is read-then-update without a wrapping transaction or
    affected-rows check — two concurrent accepts can both observe
    `redeemedAt == null` and both create grants (small race window).
- **`GET /share/grants?recordType=&recordId=&includeRevoked=`** → 200
  `{grants}`. Query (grant-store.ts:101-125):
  `tenant_id = ? AND (owner_user_id = ? OR grantee_user_id = ?)`
  [+ optional recordType/recordId filters] [+ `revoked_at IS NULL` unless
  `includeRevoked=true`], `ORDER BY created_at DESC, id ASC`. **This is
  the receiver-side query: a principal sees exactly the grants where they
  are owner OR grantee; there is no tenant-wide listing.**
- **`DELETE /share/grants/:id`** — owner-only revoke. Non-existent or
  not-owned → 404 `{error:"grant_not_found"}` (existence never leaked).
  Sets `revoked_at = now` (idempotent: an already-revoked grant returns as
  is) → 200 `{grant}`.
- **`POST /share/grants/:id/leave`** — grantee-only self-revocation; same
  404-hiding for non-grantees (including the owner); same revoke
  mechanics → 200 `{grant}`.

### 10.4 Enforcement points (what an active grant unlocks)

A non-revoked grant `(tenantId, granteeUserId, recordType, recordId,
permission)`:

1. `object.read`/`object.write` on exactly `(recordType=name,
   recordId=id)` — flips hook/ownership denies (§9.3); `hasActiveGrantFor`
   = `SELECT permission FROM grants WHERE tenant_id=? AND
   grantee_user_id=? AND record_type=? AND record_id=? AND revoked_at IS
   NULL` then permission-satisfies check in process
   (grant-store.ts:150-170).
2. Read cascade by **record id only** (`hasActiveGrantForRecordId`,
   grant-store.ts:185-203): streams with `streamId === recordId`,
   projection rows with `key === recordId`, blobs with
   `blobId === recordId`, and search hits resolving to those ids.
3. Object **subscription visibility**: grants make the granted record
   visible in snapshots and live deltas when hooks would otherwise hide it
   (§9.4).
4. Revocation (`revoked_at` set) takes effect on the next authz
   evaluation — fan-out and reads check live, so revoked grantees stop
   receiving new deltas immediately; nothing retracts already-delivered
   data.
- `grants.isEmptyAsync()` (EXISTS probe; revoked rows still count as
  present) gates the per-record fast path (§4.5, gateway.ts:882-884).

---

## 11. Tenancy & app partitioning summary

- `DEFAULT_TENANT_ID = "_default"`; `DEFAULT_APP_ID = "_default"`
  (tenant.ts:18, app-id.ts:37). Both ids: trimmed, ≤64 chars,
  `^[A-Za-z0-9_.:-]+$`; empty/missing collapse to default.
- Every primitive table carries `tenant_id` + `app_id`. PKs: objects and
  stream_events tenant-scoped (app additive, guarded on write / filtered
  on read); presence_leases and idempotency_keys app-scoped PKs
  (migration 0023).
- Tenant is pinned by the session; app is **client-selected** at the
  boundary (Hello schemaId / HTTP URL prefix) but must be registered; app
  is a namespacing axis within a tenant, NOT a trust boundary
  (app-id.ts:13-27).
- Fan-out filters, in order: principal active (not `_archived_` tenant) →
  tenant equality → app equality → (objects only) per-record authz.
- Tenant archival: `tenants.archivedAt` blocks session resolution
  (gateway.ts:2207-2209), `_archived_` tenant-id prefix blocks fan-out,
  and `routeSignal` drops signals to archived tenants.

---

## 12. Limits (defaults; limits.ts:88-118)

`maxHttpBodyBytes 5_000_000 · maxStreamAppendPayloadBytes 256_000 ·
maxBlobBytes 25_000_000 · maxBlobBytesPerPrincipal MAX_SAFE_INTEGER ·
maxSubscriptionsPerConnection 256 · maxStreamPageSize 500 ·
maxSearchQueryBytes 4096 · maxSearchFilterFields 16 ·
maxSearchFilterKeyBytes 128 · maxSearchFilterValueBytes 512 ·
maxPendingAppendsPerClient 1000 · maxWebSocketFrameBytes 524_288 ·
maxWebSocketConnections 10_000 · maxConnectionsPerPrincipal 64 ·
maxWebSocketOutboundBufferedBytes 1_048_576 · maxSseConnections 10_000 ·
maxSseOutboundBufferedBytes 1_048_576 · maxAuthAttemptsPerWindow 30 ·
authRateLimitWindowMs 300_000 · presenceTtl [5, 600] s ·
signalTtl [1, 120] s (unused) · heartbeatInterval 25 s ·
heartbeatTimeout 60 s · bindSessionDevice false`.

Env overrides: `FRICK_MAX_CONNECTIONS_PER_PRINCIPAL`,
`FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL`, `FRICK_BIND_SESSION_DEVICE`.

HTTP error mapping (server.ts:3266-3402): AuthenticationError→401
(`auth.unauthenticated`, or `auth.sessionExpired` for
SessionExpiredError), AuthorizationError→403 (`auth.forbidden`),
FrickLimitError→413 (429 for maxSseConnections/maxAuthAttemptsPerWindow)
with code blob.tooLarge / blob.quotaExceeded / stream.appendRejected /
rateLimit.exceeded by limit, InvalidStreamCursorError→`stream.invalidCursor`,
default 400 `sync.protocolError`. HTTP error bodies: `{error: envelope,
code, message, requestId, retryable}`; envelope `details.routeCode` =
route tag and `details.reason` = decision reason; **HTTP error envelopes
stamp the foundation schema's hash/revision, not the app schema's**
(server.ts:3341-3342).

---

## 13. Gotchas / surprising behaviors (checklist for parity)

1. **NUL byte in source** (gateway.ts:554) — in-process counter key only,
   not wire-visible, but tooling must handle the file.
2. Schema frame map keys are **alphabetically sorted** (stableClone);
   every other frame uses insertion order.
3. `schema.hash` is an authored string, no hash algorithm to port.
4. `knownCursors` in Hello and `CursorCommit` are accepted but never
   persisted; CursorCommit just echoes an Ack.
5. Presence/signal Subscribe sends **no response frame**; object snapshot
   cursor is always 0; object Delta cursor is `Date.now()` (ms), stream
   Delta cursor is the sequence.
6. Expired-session WS Nack uses `auth.unauthenticated`;
   `auth.sessionExpired` appears only on HTTP.
7. Idempotent append replays Ack the **original** sequence; dedupe key is
   `(appId, tenantId, session.replicaId, requestId)` with a 24 h replay
   window enforced at lookup; beyond-window replays mint a new event and
   rewrite the idempotency row.
8. Stream sequence allocation is MAX+1 **without a transaction**; PK
   collision on a concurrent same-stream append surfaces as a generic
   error (no retry).
9. Object writes via the legacy positional facade write the caller's
   version verbatim (default 0); only `upsertWithPolicy` increments.
10. DELETE /objects/:type/:id always returns 200 (never 204), body
    `{schemaHash, existed}`.
11. `SignalDef.ttlMs` and the signal TTL clamp limits are dead; signal
    outbox TTL is hard-coded 30 s; expired outbox rows are never swept.
12. Presence expiry is lazy (read-time delete); no expiry broadcasts.
13. WS-sent signals are not forwarded to the cluster bus (HTTP-sent ones
    are) — single-node delivery only for the WS path.
14. `GET /streams/:s/:k/cursor` ignores the connection's app id (always
    `_default` partition).
15. Object subscribe performs no subscribe-time authz; enforcement is
    per-record at snapshot/fan-out and only when hooks exist or any grant
    row exists.
16. Nack always duplicates `code`/`message` beside the envelope.
17. Invitation accept has a benign double-redeem race (no transaction);
    grant ids/invitation ids/tokens are base64url random bytes
    (12/12/32 bytes).
18. Object tombstone deltas carry both an id-only PackedRecord in
    `objects` and a `removed` list; no per-record authz on deletes.
19. Cross-app object writes throw `storage.crossAppDenied` (HTTP 409);
    cross-app reads are invisible (not-found).
20. `isObjectVisibleToUser` and presence/signal baseline policies are
    allow-all placeholders — all real tightening comes from policy hooks.
