# Map 01 — `packages/protocol` Wire Protocol Specification (Rust-rewrite reference)

Status: complete survey of `/Users/bri/dev/Frick/packages/protocol` at v0.3.0 (commit 9f8652d era).
Goal: everything a Rust server needs to be **byte-level wire-compatible** with the TS server:
MessagePack frame protocol, schema identity, error envelope, handshake, capabilities, calls
control-plane, signing, plus the package's full public API and its consumers.

---

## 1. Package overview

- Package: `@fricken/protocol` v0.3.0, ESM only (`"type": "module"`), entry `dist/index.js`
  (`packages/protocol/package.json:1-27`).
- **Single runtime dependency: `@msgpack/msgpack` `^3.1.2`** — lockfile resolves to
  **3.1.3** (`pnpm-lock.yaml:753`, vendored at
  `node_modules/.pnpm/@msgpack+msgpack@3.1.3/node_modules/@msgpack/msgpack`).
- Published with `fixtures/` included (`package.json` `"files": ["dist", "fixtures", "README.md"]`)
  — the JSON fixtures are the cross-SDK conformance corpus (README.md:15).
- Source modules (`src/`): `frame.ts`, `codec.ts`, `schema.ts`, `errors.ts`, `compatibility.ts`,
  `capabilities.ts`, `calls.ts`, `signing.ts`, `sharing.ts`, `sensitivity.ts`, `diagnostics.ts`,
  `localization.ts`, `fixtures.ts`, `foundation.ts`, `artifacts.ts`, `lint.ts`,
  `fixtures/product-test-schema.ts`, `generators/typescript.ts`, `generators/error-enums.ts`.

### Consumers (workspace `package.json` deps on `@fricken/protocol`)

| Consumer | Path | Notes |
|---|---|---|
| `@fricken/server` | `apps/server` | gateway decodes/encodes frames (`apps/server/src/sync/gateway.ts:9`, `apps/server/src/sync/wire.ts:2`); store validates schema (`apps/server/src/store.ts:453`) |
| `@fricken/core` (TS client SDK) | `packages/core` | `encodeFrame`/`decodeFrame` in `packages/core/src/runtime.ts:3-5,860,972` |
| `@fricken/react` | `packages/react` | via core |
| `@fricken/cli` | `apps/cli` | `validateSchema`, diagnostics, lint (`apps/cli/src/commands/schema.ts:29`) |
| `@fricken/devtools` | `packages/devtools` | frame kind labels, error shapes |
| `apps/web` | demo web app | |
| `apps/rangercrm-server` | second app server | |
| `bench` | benchmark harness | |
| Swift / Kotlin clients | `packages/swift`, `apps/android` | consume **generated artifacts** (§12) and the JSON fixtures via conformance tests (`apps/android/frick/src/test/java/dev/frick/client/FrickProtocolFixturesTest.kt`, `packages/swift/Tests/FrickSwiftTests/`), not the npm package |

(`packages/mcp` mentions error-code strings but does NOT depend on the package.)

---

## 2. MessagePack library & encoding quirks (`@msgpack/msgpack` 3.1.3)

`encodeFrame`/`decodeFrame` call the library's top-level `encode`/`decode` with **no options**
(`src/frame.ts:215-222`), so all defaults apply (verified against vendored
`src/Encoder.ts` / `src/Decoder.ts` of 3.1.3):

### Encoder defaults (Encoder.ts constructor)
- `sortKeys: false` → **map keys are emitted in JS object insertion order**. Field order on the
  wire is therefore the *call-site object-literal order*, documented per-frame below.
- `ignoreUndefined: false` → **a property explicitly set to `undefined` is ENCODED as nil
  (`0xc0`) under its key**, not omitted (Encoder `encodeMap`: size counts all keys; `doEncode`
  encodes `object == null` as nil). TS code mostly *omits* optional keys via conditional spread
  (e.g. `...(cond ? { sessionToken } : {})`, `packages/core/src/runtime.ts:344`), but a Rust
  decoder MUST treat `key: nil` and key-absent as equivalent for every optional field.
- `forceFloat32: false`, `forceIntegerToFloat: false`, `useBigInt64: false`.
- Integers: smallest-width encoding. `Number.isSafeInteger` → positive fixint (`< 0x80`),
  uint8/16/32, uint64 (`0xcf`) above 2^32; negative fixint (≥ −32), int8/16/32/64. Non-integers
  and unsafe integers → **float64 (`0xcb`)**; float32 never emitted by default.
- Strings: UTF-8, fixstr/str8/str16/str32 by byte length.
- **Any `ArrayBufferView` (e.g. `Uint8Array`) → bin8/16/32 (`0xc4`/`0xc5`/`0xc6`)** (Encoder
  `encodeBinary`). This is how `bytes` schema fields (e.g. `WebRTCSignal.payload`) travel.
- Arrays → fixarray/array16/array32. Maps → fixmap/map16/map32.
- `maxDepth: 100`, `initialBufferSize: 2048`.
- Extension types: default `ExtensionCodec` registers only the msgpack **timestamp extension
  (ext type −1)** which encodes JS `Date` instances. **Frick never puts `Date` on the wire** —
  schema `timestamp` fields are ISO-8601/RFC-3339 *strings* (see generators §12: Swift maps
  `timestamp`→`Date` only via Codable on the JSON side; TS binding type is `string`,
  `generators/typescript.ts:150`). A Rust implementation should never emit ext types; it should
  tolerate ext −1 on decode for robustness (decodes to a timestamp) but nothing produces it.
- `bigint` is only encodable with `useBigInt64: true`, which is not used anywhere → no int64
  beyond `Number.MAX_SAFE_INTEGER` ever encodes from TS; values > 2^53−1 would encode as
  float64. Cursors/sequences are JS numbers — keep them ≤ 2^53−1.

### Decoder defaults (Decoder.ts constructor)
- `useBigInt64: false` → uint64/int64 decode to JS `number` (lossy above 2^53−1).
- `rawStrings: false`; map keys must be string or number else `DecodeError`
  (Decoder.ts:89-94); cached key decoder enabled.
- `maxStrLength`/`maxBinLength`/`maxArrayLength`/`maxMapLength`/`maxExtLength` all
  `UINT32_MAX` (no practical limit — the server applies its own byte-size limits before decode).
- `decodeBinary` returns a `Uint8Array` **subarray view** into the input buffer (no copy).

### decodeFrame is unvalidated
`decodeFrame` is just `decode(bytes) as FrickFrame` (`src/frame.ts:219-222`) — **no runtime
shape validation**. The server wraps it in try/catch and Nacks `sync.protocolError` with
`requestId: "unknown"` on any decode error (`apps/server/src/sync/gateway.ts:1049-1086`).
`isBinaryFrame(payload)` (`frame.ts:224-226`) gates `ArrayBuffer | Uint8Array` input.

---

## 3. Frame protocol (`src/frame.ts`)

### 3.1 Constants

- `PROTOCOL_VERSION = 1` (`frame.ts:13`). Also stamped as `protocolVersion: 1` inside every
  schema and as `protocol: "frick.realtime"` (literal type, `schema.ts:168-169`).

### 3.2 Top-level framing

Every frame is a **msgpack 2-element array**: `[kind: int, payload]`
(`FrickFrame` union, `frame.ts:190-213`). `kind` is a `FrameKind` numeric enum value
(positive fixint on the wire). `payload` is a msgpack **map** (string keys) for every kind.

### 3.3 `FrameKind` enum — exact integer values (`frame.ts:15-41`)

| Value | Name | Direction | Payload type |
|---|---|---|---|
| 0 | `Hello` | client→server | `HelloPayload` |
| 1 | `Schema` | server→client | full `FrickSchema` |
| 2 | `Subscribe` | client→server | `SubscribePayload` |
| 3 | `Snapshot` | server→client | `SnapshotPayload` |
| 4 | `StreamPage` | server→client | `StreamPagePayload` |
| 5 | `Append` | client→server | `AppendPayload` |
| 6 | `Ack` | server→client | `AckPayload` |
| 7 | `Nack` | server→client | `NackPayload` |
| 8 | `Delta` | server→client | `DeltaPayload` |
| 9 | `PresenceSet` | client→server | `PresenceSetPayload` |
| 10 | `PresenceClear` | client→server | `PresenceClearPayload` |
| 11 | `PresenceDelta` | server→client | `PresenceDeltaPayload` |
| 12 | `SignalSend` | client→server | `SignalPayload` |
| 13 | `SignalDeliver` | server→client | `SignalDeliverPayload` |
| 14 | `CursorCommit` | client→server | `CursorCommitPayload` |
| 15 | `Ping` | both | `{ sentAt: number }` |
| 16 | `Pong` | both | `{ sentAt: number; receivedAt: number }` |
| 17 | `SyncStatus` | (client-local/devtools) | `{ connected: boolean; cursors: Record<string,number>; inFlight: number }` |
| 18 | `HelloAck` | server→client | `HelloAckPayload` |
| 19 | `ProjectionDelta` | server→client | `ProjectionDeltaPayload` |
| 20 | `ObjectUpsert` | client→server | `ObjectUpsertPayload` |
| 21 | `CallCommand` (FR-15) | client→server | `CallCommandPayload` |
| 22 | `CallCommandResult` (FR-15) | server→client | `CallCommandResultPayload` |

`SubscriptionKind = "object" | "stream" | "presence" | "signal" | "projection"` (`frame.ts:43`).

### 3.4 Payload shapes — fields, types, optionality, observed key order

Optional = key may be absent (or nil, see §2). "Order" = object-literal order at the canonical
producer call site; receivers must NOT depend on order, but a Rust encoder should reproduce it
for byte-identical fixtures.

**`HelloPayload`** (`frame.ts:45-52`); client emit order (`packages/core/src/runtime.ts:338-350`):
1. `replicaId: string`
2. `deviceId: string`
3. `schemaHash: string`
4. `knownCursors: Record<string, number>` (map subscriptionId→cursor; `{}` allowed)
5. `sessionToken?: string` — omitted (not nil) when absent
6. `clientCapabilities?: FrickClientCapabilities` (§6)

**`SubscribePayload`** (`frame.ts:54-60`): `subscriptionId: string`, `kind: SubscriptionKind`,
`name: string`, `key?: string`, `cursor?: number`.

**`SnapshotPayload`** (`frame.ts:62-66`): `subscriptionId: string`,
`objects: PackedRecord[]` (§4), `cursor: number`.

**`StreamPagePayload`** (`frame.ts:68-73`): `subscriptionId: string`,
`events: PackedStreamEvent[]`, `cursor: number`, `hasMore: boolean`.

**`AppendPayload`** (`frame.ts:75-81`): `requestId: string`, `stream: string`, `key: string`,
`event: string`, `payload: PlainObject` (named-field map — packing happens server-side).

**`AckPayload`** (`frame.ts:83-91`): `requestId: string`, `cursor?: number`,
`version?: number`. `version` only on ObjectUpsert acks (the new on-disk version);
omitted for stream-append/presence/signal acks. CursorCommit is acked with
`{ requestId: subscriptionId, cursor }` (`gateway.ts:1296-1297`).

**`ObjectUpsertPayload`** (`frame.ts:93-105`): `requestId: string`, `objectType: string`,
`objectId: string`, `value: PlainObject`, `expectedVersion?: number`. `expectedVersion`
honored only when the object's `mergePolicy === "versionPrecondition"`; omit on create-intent;
ignored entirely for `lastWriteWins` schemas (doc comment `frame.ts:99-104`).

**`NackPayload`** (`frame.ts:107-112`): `requestId: string`, `error: FrickErrorEnvelope` (§5),
`code?: FrickErrorCode`, `message?: string`. **`code`/`message` are legacy duplicates** —
the server always sends all four keys in order `requestId, error, code, message`
(e.g. `gateway.ts:1077-1085`).

**`HelloAckPayload`** (`frame.ts:114-120`); server emit order (`gateway.ts:1444-1452`):
1. `schemaHash: string`
2. `schemaId: string`
3. `schemaRevision: number` (positive int)
4. `schemaCompatibility: SchemaCompatibilityResult` (§7)
5. `serverCapabilities: FrickServerCapabilities` (§6)

**`DeltaPayload`** (`frame.ts:128-140`): `objects: PackedRecord[]`,
`events: PackedStreamEvent[]`, `cursor: number`, `removed?: ObjectRemoval[]` (FR-142,
additive; absent when no deletions; `ObjectRemoval = { type: string; id: string }`
`frame.ts:123-126`). Server emits e.g. `{ objects: [], events: [packed], cursor: seq }`
(`gateway.ts:818`).

**`PresenceSetPayload`** (`frame.ts:142-147`): `requestId`, `name`, `key`,
`value: PlainObject`.

**`PresenceClearPayload`** (`frame.ts:149-153`): `requestId`, `name`, `key`.

**`PresenceDeltaPayload`** (`frame.ts:155-159`): `subscriptionId: string`,
`records: PackedPresenceRecord[]`, `cleared: string[]` (presence keys removed).

**`SignalPayload`** (`frame.ts:161-166`): `requestId`, `name`, `key`, `value: PlainObject`.

**`SignalDeliverPayload`** (`frame.ts:168-170`): `envelope: PackedSignalEnvelope`.

**`CursorCommitPayload`** (`frame.ts:172-175`): `subscriptionId: string`, `cursor: number`.

**`ProjectionDeltaPayload`** (`frame.ts:177-188`): `projection: string` (registered name,
e.g. `"activity-feed"`), `changes: ProjectionDeltaChange[]` where each change is
`{ key: string; value: PlainObject | null }` — **`value: null` means row delete** (an actual
msgpack nil, intentionally, distinct from the undefined-handling caveat).

**`Ping`/`Pong`**: `sentAt`/`receivedAt` are **epoch milliseconds as JS numbers**
(`Date.now()`, `gateway.ts:704,1299-1301`) → encode as uint64 (`0xcf`) since `Date.now()`
> 2^32.

**`SyncStatus` (17)**: defined in the union (`frame.ts:208`) but the server gateway never
sends it; it is a client/devtools-side status frame shape. Keep it decodable.

### 3.5 `rejectSchemaMismatch(clientHash, serverHash)` (`frame.ts:228-232`)
Throws `Error("Schema mismatch: client=<h> server=<h>")` when hashes differ. Used by the server
only for **capability-less Hello** (legacy path, `gateway.ts:1182-1206`).

---

## 4. Packed record codecs (`src/codec.ts`)

All schema-typed data inside Snapshot/Delta/StreamPage/PresenceDelta/SignalDeliver travels as
**positional msgpack arrays** ("packed tuples"), NOT maps. Numeric type/field ids come from the
schema (§8). Exact tuple layouts:

- **`PackedRecord`** (objects; `schema.ts:184`):
  `[typeId: int, recordId: string, fields: PackedField[]]`
- **`PackedField`** (`schema.ts:183`): `[fieldId: int, value: any]` — value encoded by its
  natural JS type (string/bool/number/Uint8Array→bin/nested map for json).
- **`PackedStreamEvent`** (`codec.ts:21-28`):
  `[streamTypeId: int, streamKey: string, sequence: int, eventId: string, eventTypeId: int, fields: PackedField[]]`
- **`PackedPresenceRecord`** (`codec.ts:30-34`):
  `[presenceTypeId: int, presenceKey: string, fields: PackedField[]]`
- **`PackedSignalEnvelope`** (`codec.ts:36-40`):
  `[signalTypeId: int, signalKey: string, fields: PackedField[]]`

### Pack/unpack semantics (`codec.ts:51-163`)

- `packFields` iterates **`Object.entries(value)` in the value's own insertion order** —
  packed-field order on the wire is the caller's property order, NOT sorted by field id
  (`codec.ts:149-154`). Unknown field name → throws `Unknown field <name>`.
- `unpackFields` resolves each `[fieldId, value]` via `fieldById` (throws
  `Unknown field id <id>` on miss) and builds a named map (`codec.ts:156-163`).
- `unpackObjectRecord` **injects `id: recordId` as the first key** of the unpacked value:
  `{ id: packed[1], ...unpackFields(...) }` (`codec.ts:61-71`). So object DTO values always
  carry `id` even though it's not a packed field. (Matches the generators' implicit-id rule,
  §12.)
- `packObjectRecord(schema, objectName, objectId, value)` → looks up `objectByName` (throws
  `Unknown object: <name>`), result `[object.id, objectId, packFields(object.fields, value)]`
  (`codec.ts:51-59`).
- `packStreamEvent(schema, input: StreamEventInput)` where `StreamEventInput =
  { stream, streamId, sequence, eventId, event, payload }` (`codec.ts:42-49,73-87`).
- Presence/signal pack/unpack mirror objects, keyed by `presenceKey`/`signalKey` strings.

Golden codec example (test `tests/codec.test.ts`): packing `User` `"user-1"`
`{ displayName: "Ada", avatarBlobId: "blob-1" }` against `productTestSchema` yields exactly
`[1, "user-1", [[1, "Ada"], [2, "blob-1"]]]`.

---

## 5. Structured error envelope (`src/errors.ts`)

### 5.1 Error codes — exact strings (`errors.ts:12-29`)

`FRICK_ERROR_CODES` (a `const` array; order matters only for codegen output):

```
auth.unauthenticated
auth.forbidden
auth.sessionExpired
schema.incompatible
schema.migrationRequired
storage.conflict
storage.notFound
stream.appendRejected
stream.invalidCursor
sync.protocolError
sync.reconnectExhausted
blob.tooLarge
blob.unsupportedContentType
blob.quotaExceeded
rateLimit.exceeded
server.internal
```

16 codes; dotted namespace, first segment = subsystem, second = failure. Codegen
(`generators/error-enums.ts`) derives Swift camelCase cases (`authSessionExpired`),
Kotlin SCREAMING_SNAKE (`AUTH_SESSION_EXPIRED` — camelCase humps split:
`sessionExpired` → `SESSION_EXPIRED`), and a TS const-array clone for `@fricken/core`.

### 5.2 `FrickErrorEnvelope` shape (`errors.ts:35-43`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string (one of above) | yes | |
| `message` | string | yes | human text, never localized on the wire |
| `requestId` | string | yes | `"unknown"` for undecodable frames; `"hello"` for handshake errors |
| `retryable` | boolean | yes | |
| `details` | map (string→any) | no | must be a non-array object when present |
| `schemaHash` | string | no | |
| `schemaRevision` | int | no | validated with `Number.isInteger` (may be any integer here, unlike schema identity) |

Producer key order (server call sites, e.g. `gateway.ts:1071-1076,1186-1194`):
`code, message, requestId, retryable, [details], [schemaHash], [schemaRevision]` —
optional keys conditionally spread in that position.

- `createFrickErrorEnvelope(input)` is just `{ ...input }` (`errors.ts:45-47`) — preserves the
  caller's key order; an explicitly-undefined optional would be msgpack-encoded as nil (§2).
- `isFrickErrorEnvelope(value)` (`errors.ts:49-75`): structural guard — code must be in the
  16-code set; details must be non-null non-array object; schemaHash string; schemaRevision
  `Number.isInteger`. Used by tests and SDKs to validate fixtures.

### 5.3 Where envelopes appear on the wire
Inside `NackPayload.error` (plus duplicated top-level `code`/`message`). HTTP routes reuse the
same JSON shape (out of scope for this map; see server map).

---

## 6. Capabilities (`src/capabilities.ts`)

### Enumerated string values (`capabilities.ts:3-15`)
- `FrickClientPlatform`: `"web" | "node" | "ios" | "macos" | "android" | "test" | "service"`
- `FrickTransportCapability`: `"websocket" | "http" | "sse"`
- `FrickEncodingCapability`: `"msgpack" | "json"`
- `FrickPrimitiveCapability`: `"objects" | "streams" | "presence" | "signals" | "blobs" | "jobs" | "projections"`
- `FrickBlobUploadCapability`: `"direct" | "resumable" | "signedUrl" | "localOnly"`
- `FrickPushCapability`: `"apns" | "fcm" | "webPush" | "test"`

### `FrickSchemaCapability` (`capabilities.ts:17-21`) — key order from `schemaCapability()`
(`:51-57`): `schemaId: string`, `schemaRevision: number`, `schemaHash: string`.

### `FrickClientCapabilities` (`capabilities.ts:23-38`) — all fields required; emit order from
`defaultClientCapabilities` (`:59-77`):
`platform, sdkVersion, schema, transports, encodings, primitives, offline, blobUploads, push, experimental, required`.
- `offline: { cache: boolean; pendingAppends: boolean }` (nested map, key order `cache, pendingAppends`).
- Defaults: `transports: ["websocket"]`, `encodings: ["msgpack"]`,
  `primitives: ["objects","streams","presence","signals"]`,
  `offline: { cache: true, pendingAppends: true }`, `blobUploads: ["direct"]`,
  `push: []`, `experimental: []`, `required: []`.

### `FrickServerCapabilities` (`capabilities.ts:40-49`) — emit order from
`defaultServerCapabilities` (`:79-90`):
`schema, transports, encodings, primitives, blobUploads, push, experimental, limits`.
- Defaults: `transports: ["websocket","http"]`, `encodings: ["msgpack","json"]`,
  `primitives:` all seven, `blobUploads: ["direct"]`, `push: []`, `experimental: []`,
  `limits: {}` (`Record<string, number>`). The gateway sends exactly
  `defaultServerCapabilities(targetSchema)` (`gateway.ts:1451`).

### Required-capability negotiation
`serverCapabilityNames(server)` flattens to dotted names —
`transport.<x>`, `encoding.<x>`, `primitive.<x>`, `blobUpload.<x>`, `push.<x>`,
`experimental.<x>` (`capabilities.ts:92-101`; note singular `transport`/`encoding`/`primitive`
prefixes). `unsupportedRequiredCapabilities(client, server)` = client `required[]` entries not
in that set (`:103-109`). Server Nacks `sync.protocolError` with
`details.unsupportedCapabilities: string[]` when non-empty (`gateway.ts:1246-1270`).

---

## 7. Handshake & schema negotiation

Sequence (authoritative implementation `apps/server/src/sync/gateway.ts:1089-1273`):

1. Client connects WebSocket, sends `Hello` (kind 0). **Any other frame except `Ping` before a
   completed handshake** → Nack `sync.protocolError`, message
   `"Hello handshake required before sync frames"`, `details: { reason: "handshakeRequired" }`,
   with server `schemaHash`/`schemaRevision` attached (`gateway.ts:1090-1109`).
2. Server authenticates `sessionToken` (binding `deviceId`/`replicaId`).
3. Multi-app routing: `clientCapabilities.schema.schemaId` selects a registered app's schema;
   unknown id on a genuine multi-app server → Nack `auth.forbidden`,
   `details: { reason: "appNotAuthorized", knownAppIds: [...] }` (`gateway.ts:1140-1173`).
4. Compatibility:
   - **No `clientCapabilities`** (legacy): bare string compare
     `rejectSchemaMismatch(hello.schemaHash, serverSchema.hash)`; mismatch → Nack
     `schema.incompatible` (`gateway.ts:1182-1205`).
   - **With capabilities**: synthesize a client schema =
     `{ ...serverSchema, schemaId, schemaRevision, hash }` from the capability
     (`schemaFromClientCapabilities`, `gateway.ts:2390-2397`) and run
     `compareSchemaCompatibility(clientSchema, serverSchema)` (§7.1). Incompatible → Nack
     `schema.incompatible` with `compatibility.message` and optional
     `details.appId`/`details.knownAppIds`.
5. Required-capability check (§6) → Nack `sync.protocolError` if unsupported.
6. Success: server sends **`HelloAck` (18)** then immediately **`Schema` (1)** carrying the
   full `FrickSchema` object (`#sendHelloSuccess`, `gateway.ts:1439-1456`). Handshake marked
   complete between the two sends.

### 7.1 `compareSchemaCompatibility` (`src/compatibility.ts:26-76`)

`SchemaCompatibilityResult` is a discriminated union (`compatibility.ts:10-24`):
- compatible: `{ compatible: true, reason: "exact" | "revisionCompatibleHashMismatch",
  clientRevision, serverRevision, message? }` (message present only for hash-mismatch:
  `"Schema revisions are compatible but hashes differ"`).
- incompatible: `{ compatible: false, reason: "schemaIdMismatch" | "clientTooOld" |
  "serverTooOld", clientRevision, serverRevision, message }` (message required).

Decision order (exact):
1. `client.schemaId !== server.schemaId` → `schemaIdMismatch`,
   message `` `Schema id mismatch: client=${...} server=${...}` ``.
2. `client.schemaRevision < server.minimumClientRevision` → `clientTooOld`,
   `` `Client schema revision ${r} is below server minimum ${m}` ``.
3. `server.schemaRevision < client.minimumServerRevision` → `serverTooOld`,
   `` `Server schema revision ${r} is below client minimum ${m}` ``.
4. `client.hash !== server.hash` → compatible, `revisionCompatibleHashMismatch`.
5. else → compatible, `exact` (no `message` key).

Result key order as constructed: `compatible, reason, clientRevision, serverRevision[, message]`.
`requireSchemaCompatibility` throws `Error(result.message)` when incompatible
(`compatibility.ts:78-84`).

NOTE (gateway quirk): because the synthesized client schema copies the *server's*
`minimumServerRevision`, step 3 can only trip if the server's own revision violates its own
minimum — effectively the WS handshake enforces schemaId + minimumClientRevision + hash.

---

## 8. Schema model & identity (`src/schema.ts`)

### 8.1 `FrickSchema` — full shape (`schema.ts:161-180`)

```
name: string
schemaId: string                  // identity, never changes for an app
schemaVersion: string             // semverish display string
schemaRevision: number            // positive integer, monotonically increases
minimumClientRevision: number     // positive integer
minimumServerRevision: number     // positive integer
protocol: "frick.realtime"        // literal; validateSchema rejects others
protocolVersion: number           // 1
compatibility: "greenfield-cutover" // literal; validateSchema rejects others
hash: string                      // see 8.3 — a HUMAN-MAINTAINED label, not a digest!
objects: ObjectDef[]; streams: StreamDef[]; events: EventDef[];
presences: PresenceDef[]; signals: SignalDef[]; blobs: BlobDef[];
jobs: JobDef[]; projections: ProjectionDef[]
```

Type defs (`schema.ts:40-159`):
- `FieldDef { id: number; name: string; kind: FieldKind; required: boolean; ref?: string;
  enumValues?: string[]; sensitivity?: FieldSensitivity }`
- `FieldKind = "id" | "ref" | "string" | "bool" | "timestamp" | "int" | "bytes" | "enum" | "json"`
  (`schema.ts:1-10`). On the wire all of `id/ref/string/timestamp/enum` are msgpack strings;
  `int` → int; `bool` → bool; `bytes` → bin; `json` → any nested msgpack value.
  **Enums are encoded as their string value** (the lint rule about "ordinal-encoded enums",
  `lint.ts:470-472`, is forward-looking; nothing ordinal-encodes today — see generators where
  enum → string-literal union, `generators/typescript.ts:143-146`).
- `IndexDef { id, name, fields: string[] }`
- `ObjectDef { id, name, fields, indexes, mergePolicy? }`;
  `FrickObjectMergePolicy = "lastWriteWins" | "versionPrecondition"`, default
  `lastWriteWins` (`resolveObjectMergePolicy`, `schema.ts:268-274`; unknown object names also
  fall back to lastWriteWins). **`mergePolicy` is server-only metadata, never in generated
  artifacts** (`schema.ts:91-96`).
- `StreamDef { id, name, keyFields: FieldDef[], events: string[] }` (event *names*)
- `EventDef { id, name, fields }`
- `PresenceDef { id, name, keyFields, fields, ttlMs: number }`
- `SignalDef { id, name, keyFields, fields, ttlMs: number }`
- `BlobDef { id, name, metadataFields }`
- `JobDef { id, name, fields }`
- `ProjectionDef { id, name, source: string, fields, indexes }` (source = stream OR object name)

### 8.2 `validateSchema` (`schema.ts:186-256`) — also a NORMALIZER

- **First step is `stableClone(schema)`** (`schema.ts:494-514`): recursively clones with
  **object keys sorted alphabetically** and **`undefined`-valued properties dropped**; arrays
  keep order. The server stores the normalized schema (`apps/server/src/store.ts:453`), so the
  **`Schema` frame (kind 1) payload has alphabetically-sorted map keys throughout** —
  byte-compatible Rust must replicate that sort for the Schema frame.
- Checks: `protocol === "frick.realtime"`, `compatibility === "greenfield-cutover"`,
  identity fields (non-empty `schemaId`/`schemaVersion`, positive-int revisions),
  per-collection unique ids and **case-insensitively unique names** (`validateTypeSet`,
  `schema.ts:377-393`), per-field unique ids and case-insensitive names, `ref` targets must be
  declared objects or blobs, `enum` requires non-empty `enumValues`, `sensitivity` must be one
  of the five values; stream `events[]` must name declared events; projection `source` must be
  a declared stream or object; index fields must exist.
- Lookup helpers throw on miss: `objectByName/Id`, `streamByName/Id`, `eventByName/Id`,
  `presenceByName/Id`, `signalByName/Id`, `blobByName`, `jobByName`, `projectionByName`,
  `fieldByName/Id` (`schema.ts:258-375`).
- `blobRefFields(schema)` (FR-57 GC reference set): all object fields of `kind:"ref"` whose
  `ref` names a blob (`schema.ts:340-351`).

### 8.3 Schema identity & "hash" — SURPRISING: no hashing algorithm exists

**`FrickSchema.hash` is a hand-maintained opaque string label, NOT a computed digest.**
There is no canonicalization-and-digest step anywhere in the repo for the schema hash:
- foundation: `hash: "frick-foundation-empty-0.1.0"` (`src/foundation.ts:13`)
- product test fixture: `hash: "frick-product-test-0.2.0"` (`src/fixtures/product-test-schema.ts:19`)
- server calls schema: `hash: "frick-calls-0.1.0"` (`apps/server/src/calls/call-schema.ts:283`)

All comparisons are exact string equality (`rejectSchemaMismatch`, `compareSchemaCompatibility`
step 4). A Rust implementation must treat `hash` as an opaque string and never derive it.
The quadruple `{schemaId, schemaVersion, schemaRevision, hash}` plus
`minimumClientRevision`/`minimumServerRevision` is the complete identity surface
(diagnostics uses `schemaId/schemaVersion/schemaRevision/schemaHash`, `diagnostics.ts:26-31`).

### 8.4 Field sensitivity (`schema.ts:27-71`, `src/sensitivity.ts`)

- `FieldSensitivity = "public" | "private" | "pii" | "secret" | "content"`;
  `DEFAULT_FIELD_SENSITIVITY = "private"` when omitted (`schema.ts:38`). Server-only metadata;
  not propagated to native artifacts; no wire effect.
- `sensitivity.ts`: `REDACTED_FIELD_VALUE = "<redacted>"`;
  `DEFAULT_REDACTED_SENSITIVITIES = ["pii", "secret", "content"]` (`sensitivity.ts:25,34-38`).
  `redactRecord(record, fields, {redact?, placeholder?})` shallow-copies, masking declared-
  sensitive fields; **unknown field names keep their value** (they default to "private", which
  is NOT redacted by default) (`sensitivity.ts:84-101`). `"placeholder" in options` check lets
  `null`/`undefined` be valid placeholders (`:92`). `redactRecords` maps the list version.

---

## 9. Foundation schema (`src/foundation.ts`)

The production foundation schema is **intentionally empty**: all eight collections `[]`,
`name/schemaId: "frick-foundation"`, `schemaVersion: "0.1.0"`, `schemaRevision: 1`,
`minimumClientRevision: 1`, `minimumServerRevision: 1`, `protocolVersion: 1`,
`hash: "frick-foundation-empty-0.1.0"` (`foundation.ts:3-22`). Apps register their own schemas;
`productTestSchema` (`src/fixtures/product-test-schema.ts`) is the non-trivial chat-shaped test
fixture (8 objects, 2 streams, 9 events, 1 presence `TypingState` ttl 5000ms, 1 signal
`WebRTCSignal` ttl 30000ms, 1 blob, 1 job, 1 projection) — **never imported by runtime code**.

---

## 10. Calls control-plane (`src/calls.ts`, FR-15/FR-78/FR-79/FR-82/FR-155/FR-156)

Call *records* sync as ordinary objects; SDP/ICE rides `SignalSend`/`SignalDeliver` with signal
type `WEBRTC_SIGNAL_TYPE = "WebRTCSignal"` (`calls.ts:332`); only lifecycle *commands* use the
dedicated frame pair 21/22.

### String enums (exact values)
- `CallTransport = "p2p" | "sfu"`; `CallKind = "audio" | "video"`
- `CallRoomState = "ringing" | "active" | "ended"`
- `CallInviteState = "ringing" | "accepted" | "declined" | "cancelled"`
- `CallParticipantState = "joined" | "left"`
- `WebRTCSignalKind = "offer" | "answer" | "ice" | "renegotiate" | "sfuToken" | "keyEpoch"`
  (`keyEpoch` = FR-156 E2EE key-epoch announcement; relayed opaque) (`calls.ts:49-55`)
- `CallNetworkQuality = "unknown" | "poor" | "fair" | "good" | "excellent"`
- `CallSfuMediaKind = "audio" | "video"`

### Records (all timestamps RFC-3339 strings)
- `CallRoomRecord { id, conversationId, state, createdBy, kind, createdAt, startedAt?,
  endedAt?, mediaSessionId?, transport? }` (`calls.ts:63-74`; note `transport` typed plain
  `string`, not `CallTransport`).
- `CallInviteRecord { id, callId, inviteeUserId, status: CallInviteState, invitedBy,
  invitedAt, respondedAt? }` (`:77-85`) — note the state field is named **`status`**.
- `CallParticipantRecord { id, callId, userId, deviceId, state, joinedAt, leftAt?,
  micEnabled: bool, cameraEnabled: bool, screenSharing: bool, speaking?: bool,
  networkQuality?: CallNetworkQuality }` (`:94-109`).
- `CallMediaGrant { callId, mediaSessionId, userId, deviceId, token, expiresAt,
  connection?: Record<string,string> }` (`:120-128`).
- `CallMediaStatePatch { micEnabled?, cameraEnabled?, screenSharing? }` (`:131-135`).

### `CallCommandPayload` (frame 21): `{ requestId: string, command: CallCommandOp }`
(`calls.ts:268-271`). `command` is a map discriminated by **`op`** (string):

| `op` | extra fields (declaration order) |
|---|---|
| `"create"` | `conversationId`, `inviteeUserIds: string[]` (non-empty, excludes caller), `kind?: CallKind`, `regionHint?: string` |
| `"join"` | `callId` |
| `"accept"` | `callId` |
| `"leave"` | `callId` |
| `"end"` | `callId` |
| `"setMediaState"` | `callId`, `media: CallMediaStatePatch` |
| `"sfuConnectTransport"` (FR-155) | `callId`, `token` (join nonce from grant, server re-verifies sig+expiry+identity), `transportId`, `dtlsParameters: map` (opaque) |
| `"sfuProduce"` | `callId`, `token`, `transportId`, `kind: CallSfuMediaKind`, `rtpParameters: map` |
| `"sfuConsume"` | `callId`, `token`, `transportId`, `producerId`, `rtpCapabilities: map` |

SFU ops are Nacked by a P2P media plane. `dtlsParameters`/`rtpParameters`/`rtpCapabilities`
are opaque JSON-serializable maps (mediasoup shapes) (`calls.ts:175-196`).

### `CallCommandResultPayload` (frame 22) (`calls.ts:291-303`)
`{ requestId, op: CallCommandName, room?, invites?: CallInviteRecord[], participant?,
mediaGrant?, invite?, producer?: CallSfuProduceResult, consumer?: CallSfuConsumeResult }`.
Population per op (doc `calls.ts:277-289`): create→`room`+`invites`; join→`room`+`participant`
+`mediaGrant`; accept→`invite`; leave/end→`room`; setMediaState→`participant`;
sfuConnectTransport→nothing (success = no Nack); sfuProduce→`producer`; sfuConsume→`consumer`.
**Failures are plain `Nack` frames keyed by the same `requestId`** — no separate error channel.
- `CallSfuProduceResult { producerId, kind }` (`:306-309`)
- `CallSfuConsumeResult { consumerId, producerId, kind, rtpParameters }` (`:312-317`)

### `WebRTCSignalValue` (`calls.ts:324-329`)
`{ senderDeviceId: string, recipientDeviceId?: string, kind: WebRTCSignalKind,
payload: Uint8Array }` — the named-field map handed to `SignalSend.value`; `payload` is
**msgpack bin** relayed byte-for-byte.

---

## 11. Schema-artifact signing (`src/signing.ts`, FR-45, opt-in)

- Constants: `SCHEMA_SIGNATURE_VERSION = 1`, `SCHEMA_SIGNATURE_ALGORITHM = "ed25519"`
  (`signing.ts:30-31`).
- `sha256Hex(data)` = lowercase-hex SHA-256 (node:crypto) (`signing.ts:81-83`) — used ONLY for
  artifact-manifest entries, never for schema identity.
- `SchemaArtifactManifestEntry { path, sha256 }`;
  `SchemaArtifactIdentity { schemaId, schemaHash, schemaRevision, manifest }`.
- **Canonicalization (`canonicalizeSchemaIdentity`, `signing.ts:119-136`)** — the exact signed
  preimage: UTF-8 bytes of `JSON.stringify` of an object built with **fixed key order**
  `version, algorithm, schemaId, schemaHash, schemaRevision, manifest`, where `manifest` is
  re-mapped to `{path, sha256}` (that key order) and **sorted ascending by `path`**
  (plain `<`/`>` string compare). No whitespace (default JSON.stringify).
- `signSchemaArtifact(identity, privateKey)` → Ed25519 (`crypto.sign(null, preimage, key)`),
  signature emitted **base64** in `SchemaSignatureArtifact { version, algorithm, identity,
  signature }` (`signing.ts:143-166`). Keys accepted as `KeyObject`, PEM string/Buffer
  (detected by `-----BEGIN` substring), or base64 DER (private=PKCS#8, public=SPKI)
  (`:271-317`); a private KeyObject is auto-converted to its public half for verify (`:286`).
- `verifySchemaArtifact` returns `{ valid, reason?, message? }` with reasons
  `"signatureMismatch" | "unsupportedVersion" | "unsupportedAlgorithm" |
  "malformedSignature" | "keyError"`; empty signature → malformedSignature; verify exceptions
  map to signatureMismatch (`signing.ts:176-234`).
- `verifySchemaArtifactForSchema` additionally requires identity triple equality
  (id+hash+revision) → otherwise signatureMismatch (`:243-269`).
- Driver: `scripts/generate-native-artifacts.ts` signs only when env
  `FRICK_SCHEMA_SIGNING_KEY` is set; output
  `packages/protocol/generated/schema-signature.json` (pretty-printed, trailing newline).

---

## 12. Generated artifacts (`src/artifacts.ts`, `src/generators/*`)

Generation driver `scripts/generate-native-artifacts.ts` writes (from `foundationSchema`):
- Swift → `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift`
- Kotlin → `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt`
- TS bindings → `packages/core/src/generated/bindings.ts`
- TS error enum → `packages/core/src/generated/errors.ts`

Wire-relevant invariants encoded in the generators:
- Generated constants embed the full identity: `protocolVersion`, `schemaId`, `schemaVersion`,
  `schemaRevision`, `minimumClientRevision`, `minimumServerRevision`, `schemaHash`
  (`artifacts.ts:20-30`, Kotlin `:102-107`).
- Descriptor tables map `typeId → name` and `typeId → (fieldId → fieldName)` for objects,
  streams, events — used by native sync sockets to translate packed tuples
  (`artifacts.ts:41-86,117-151`).
- **Implicit `id` field**: object DTOs get `{ id: 0, name: "id", kind: "id", required: true }`
  prepended when the schema omits an `id` field (`artifacts.ts:201-206`,
  `generators/typescript.ts:128-131`) — matches `unpackObjectRecord` injecting `id`.
- Type maps: Swift `bool→Bool, int→Int, timestamp→Date, bytes→Data, json→FrickJSONValue,
  else String` (`artifacts.ts:208-217`); Kotlin `bool→Boolean, int→Int, bytes→ByteArray,
  json→JsonElement, else String` — **Kotlin maps `timestamp` to String** (`:219-227`);
  TS `bool→boolean, int→number, bytes→Uint8Array, json→unknown, enum→string-literal union,
  id/ref/string/timestamp→string` (`generators/typescript.ts:133-154`).
- Kotlin type names replace `"RTC"`→`"Rtc"` (`artifacts.ts:233-235`); Swift escapes
  `class/struct/enum` identifiers with backticks (`:229-231`).
- Swift gains a `FrickJSONValue` indirect enum only when the schema has `json` fields
  (`:237-246,248-304`).

---

## 13. Diagnostics (`src/diagnostics.ts`, FR-76) — not on the msgpack wire (JSON snapshot)

- `DIAGNOSTICS_VERSION = 1`; `DiagnosticsSnapshot { diagnosticsVersion: 1, source: "cli" |
  "server", env?, schema: DiagnosticsSchemaIdentity, compatibility?, subscriptions?, cursors?,
  pendingAppends?, recentAcks?, recentErrors (required), connection?, caches (required),
  syncTiming (required), capabilities? }` (`diagnostics.ts:149-172`).
- `DiagnosticsSchemaIdentity { schemaId, schemaVersion, schemaRevision, schemaHash }`.
- `DiagnosticsPendingAppendState = "queued" | "inflight" | "acked" | "nacked"`;
  ack outcome `"ack" | "nack"`; connection status `"connected" | "connecting" |
  "disconnected" | "closed"`; transport `"websocket" | "http" | "sse"`.
- Semantics: `undefined` = "not observed here", distinct from `[]` = "observed, empty"
  (`diagnostics.ts:17-20`).
- `REDACTED_DIAGNOSTICS_VALUE = "<redacted>"`; `redactDiagnosticsContext` masks values whose
  KEY matches `/(token|password|secret|api[-_]?key|authorization|cookie|bearer|credential)/i`
  (`diagnostics.ts:174-197`).

## 14. Localization (`src/localization.ts`, FR-103) — client-side only

Error *codes* are never translated on the wire. `defaultErrorMessages` covers all 16 codes
(exact English strings at `localization.ts:39-56`; invariant-proving helper
`defaultMessagesCoverAllCodes`). `ErrorLocalizer.localize` fallback chain: active locale table
(region tag `fr-CA` → base `fr` via first `-` split) → English defaults → envelope `message` →
`"[<code>]"` (`localization.ts:110-157`). Template interpolation replaces `{token}` from
envelope `details` (primitives only, flattened) merged with `{ code, requestId }`; unknown
tokens left intact (`:63-67,165-176`).

## 15. Sharing (`src/sharing.ts`) — HTTP wire shapes (not msgpack frames)

- `FrickSharingPermission = "read" | "write"`.
- `FrickInvitation { id, tenantId, ownerUserId, recordType, recordId, permission, token
  (opaque base64url, single-use), createdAt, expiresAt, redeemedAt?, redeemedByUserId? }`
  (RFC-3339 timestamps) (`sharing.ts:25-46`).
- `FrickGrant { id, tenantId, ownerUserId, recordType, recordId, granteeUserId, permission,
  createdAt, revokedAt? }` (`:49-63`).
- Request/response DTOs: `CreateInvitationRequest { recordType, recordId, permission,
  expiresInSeconds? }` / `{ invitation }`; `AcceptInvitationRequest { token }` / `{ grant }`;
  `ListGrantsRequest { recordType?, recordId?, includeRevoked? (default false) }` /
  `{ grants }`; `RevokeGrantRequest { grantId }` / `{ grant }` (`:68-115`).
- Constants: `DEFAULT_FRICK_INVITATION_TTL_SECONDS = 14*24*60*60` (= 1,209,600);
  `MAX_FRICK_INVITATION_TTL_SECONDS = 90*24*60*60` (= 7,776,000) — server clamps
  (`:119-123`).
- `frickSharingPermissionSatisfies(permission, required)`: read ⟸ {read, write};
  write ⟸ {write} (`:129-137`).

## 16. Schema linter (`src/lint.ts`) — tooling, not wire

`lintSchema` (single snapshot) + `lintSchemaChange` (diff). Findings
`{ severity: "info"|"warn"|"breaking", path, message, ruleId }`; result carries
`breakingCount`. Stable ruleIds (complete list): `schema.identity.missing`,
`schema.revision.invalid`, `schema.id.changed`, `schema.revision.decreased`,
`schema.minimumClientRevision.raised` (warn), `<label>.removed` / `<label>.added` /
`<label>.renamed` per collection label (object/stream/event/presence/signal/blob/job/
projection), `stream.event.removed`/`stream.event.added`, `projection.source.changed`,
`field.removed`, `field.required.added` (breaking) / `field.optional.added` (info),
`field.renamed`, `field.kind.changed`, `field.required.toggled`/`field.optional.toggled`,
`field.ref.changed`, `enum.value.removed` (breaking), `enum.value.added.trailing` (warn),
`enum.value.inserted` (breaking — guards hypothetical ordinal encodings),
`index.removed`, `<label>.duplicate.name`, `field.duplicate.name`. Identity is tracked by
numeric `id`; rename-at-same-id is breaking.

## 17. Fixtures (`src/fixtures.ts`, `fixtures/`, `scripts/generate-fixtures.ts`)

Three golden JSON fixtures regenerated by `scripts/generate-fixtures.ts` (pretty-printed,
2-space, trailing newline), validated by `tests/fixtures.test.ts` and consumed by every SDK's
conformance suite:

1. **`fixtures/foundation-schema.json`** — the empty foundation schema verbatim
   (declaration key order, NOT stableClone-sorted, since `foundationSchemaFixture()` returns
   the raw object).
2. **`fixtures/error-envelope.json`** — exact content:
   `{ "code": "schema.incompatible", "message": "Fixture schema mismatch",
   "requestId": "fixture-error", "retryable": false, "details": { "reason": "fixture" },
   "schemaHash": "frick-foundation-empty-0.1.0", "schemaRevision": 1 }`.
3. **`fixtures/hello-frame.json`** — a full `Hello` frame as JSON:
   `[0, { replicaId: "fixture-replica", deviceId: "fixture-device",
   schemaHash: "frick-foundation-empty-0.1.0", knownCursors: {},
   clientCapabilities: <defaultClientCapabilities(platform "test",
   sdkVersion "0.0.0-fixture", foundation schema)> }]` — note `sessionToken` absent.
   Key order in the file = the literal order in `fixtures.ts:22-37` and
   `capabilities.ts:64-76`.

These are JSON renderings of frame payloads (no msgpack golden bytes exist in-repo).
A Rust conformance test should encode these JSON shapes through its msgpack encoder and
round-trip them; byte-equality with the TS encoder requires matching key order (§3.4).

## 18. Public API surface (`src/index.ts:1-23`)

Star re-exports: `artifacts`, `calls`, `capabilities`, `codec`, `compatibility`,
`diagnostics`, `errors`, `fixtures`, `frame`, `foundation`, `fixtures/product-test-schema`,
`lint`, `localization`, `schema`, `sensitivity`, `sharing`, `signing` — plus named exports
`generateSwiftErrorEnum`, `generateKotlinErrorEnum`, `generateTypeScriptErrorEnum`
(`generators/error-enums`), `generateTypeScriptBindings` (`generators/typescript`).
**Everything in §3–§17 above is public API.**

---

## 19. Surprises / undocumented gotchas (checklist for the Rust port)

1. **`schema.hash` is NOT a hash.** Opaque hand-bumped label compared by string equality
   (§8.3). Do not invent a digest.
2. **`stableClone` inside `validateSchema` sorts keys and strips `undefined`** — the `Schema`
   frame the server emits has alphabetized keys; the JSON fixture of the same schema does not.
3. **msgpack `ignoreUndefined: false`**: explicitly-undefined optionals encode as nil under
   their key. Decoders must treat nil ≡ absent for all optional fields.
4. **Packed field order = `Object.entries` insertion order of the value being packed**, not
   field-id order. Decode must accept any order; ids may also be sparse/unsorted.
5. **`NackPayload` duplicates `code`/`message`** outside the envelope; the server always sends
   both.
6. **`unpackObjectRecord` injects `id`** as a value property from the tuple's `recordId`; `id`
   is not a packed field (field id 0 is reserved for the implicit id in generated DTOs only).
7. Pre-handshake frames other than Hello/Ping are Nacked with
   `details.reason = "handshakeRequired"`; undecodable frames are Nacked with
   `requestId: "unknown"`; handshake errors use `requestId: "hello"`.
8. **HelloAck is immediately followed by a full `Schema` frame** — two frames per successful
   handshake.
9. Capability-less Hello falls back to bare hash equality (legacy path) — must be kept for
   wire compat.
10. The `"json"` server encoding capability refers to the HTTP/SSE surface
    (`apps/server/src/sync/sse.ts:113` sends JSON frames over SSE); the WS gateway is
    msgpack-only.
11. Cursor/sequence/`sentAt` values are JS numbers — uint64 on the wire but must stay
    ≤ 2^53−1 (decoder gives lossy numbers above that).
12. `CallInviteRecord` uses `status` (not `state`) for its lifecycle field.
13. The fixture `WebRTCSignal` enum in `productTestSchema` lacks `"keyEpoch"`
    (`product-test-schema.ts:233`) while `calls.ts` includes it — the relay treats `kind` as
    schema-enum-validated per app schema.
14. `FrameKind.SyncStatus (17)` and `FrameKind.Schema (1)` appear in the union but only
    `Schema` is server-emitted; nothing currently parses an inbound `Schema`/`SyncStatus`
    on the server.
15. Ed25519 signing canonical preimage is compact `JSON.stringify` with the fixed key order
    `version, algorithm, schemaId, schemaHash, schemaRevision, manifest` and path-sorted
    manifest (§11) — reproduce exactly.
16. Wire-adjacent WebSocket close codes the TS server uses: **1009** ("frame too large") when
    an inbound frame exceeds the configured byte limit (Nack `sync.protocolError` is sent
    first, `gateway.ts:1030-1048`), and **1013** ("WebSocket outbound buffer exceeded") when
    `bufferedAmount` would exceed `maxBufferedAmount` (`apps/server/src/sync/wire.ts:8-37`).

---

## Appendix: Rust crate accepted deviations (FR-238, decided 2026-06-10)

The adversarial parity review (24 findings) drove fixes in `crates/frick-protocol`
(duplicate-key unpack now mirrors JS last-write-wins, integer msgpack map keys
stringify in `pack_fields`, `sensitivity` decodes as a raw string and is
validated with the exact TS message, empty-string `ref` skips the
unknown-target check, `is_envelope_value` mirrors the TS `typeof`/`Number.isInteger`
guards) and in the TS server (`gateway.ts` Delta literal now orders
`cursor` before `removed`, matching the interface). The following remain as
**deliberate deviations**, all unreachable from typed TS apps:

1. **Unknown `FieldKind`/`mergePolicy` strings and fractional ids fail Rust
   decode** but pass TS `validateSchema` (it never checks them). Close the TS
   gap at cutover by adding membership checks rather than loosening Rust.
2. **Unknown extra map keys are dropped by Rust typed decode** (TS
   `stableClone` preserves them). Out-of-interface schema keys are out of
   contract; the golden `typed round-trip` assertion would catch any fixture
   that carries them.
3. **`pack_fields` non-map scalars**: numbers/booleans pack zero fields (TS
   parity); strings/arrays/nil error with `"expected an object value"` where
   TS would produce char-index entries / index entries / a bare `TypeError`.
4. **JS integer-like key hoisting and `-0`**: Rust-originated maps keep
   insertion order and must not use integer-like string keys or negative-zero
   floats (see `value.rs` module docs). TS-decoded frames are unaffected.
5. **Explicit `undefined` optionals** (`key→nil` on the wire): Rust decodes
   them to `None` and re-encodes without the key — pinned by the lossy
   `ack-explicit-undefined-cursor` fixture.
6. **Explicit `null` sensitivity**: TS `validateSchema` rejects it with
   `Unknown sensitivity "null"`; Rust decodes nil→None and validation passes.
7. **`FrickServerCapabilities.limits` is `i64`** (TS: `number`). Limits are
   counts/byte sizes; enforce integer limits TS-side at cutover.
8. **Unknown frame kinds**: TS `decodeFrame` blindly casts and the gateway's
   switch silently drops unknown kinds; Rust `decode_frame` errors. The Rust
   gateway port must pre-read the kind and drop unknowns to preserve the
   observable ignore-behavior (tracked on FR-243).

Server-side literal-order debt for byte-parity (tracked on FR-243):
`call-control-plane.ts` builds active/ended room records via object spread,
appending `startedAt`/`endedAt`/`leftAt` after `mediaSessionId`/`transport` —
pinned decode-only by the `call-command-result-join-production-order` fixture
until those literals are rewritten in interface order.
