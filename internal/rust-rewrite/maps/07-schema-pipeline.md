# 07 — Schema Pipeline (authoring → AST → hash/revision → lint → codegen)

Implementation-grade map for the Rust rewrite. Everything here is sourced from the
TypeScript tree at the cited file:line locations. The Rust server must reproduce the
schema AST shape, identity semantics, compatibility algorithm, linter rule ids, and
(if it owns codegen/signing) the byte-exact canonicalization in §6.

Source-of-truth files:

| Concern | File |
| --- | --- |
| Schema AST + `validateSchema` + lookup helpers | `packages/protocol/src/schema.ts` |
| Foundation (framework) schema | `packages/protocol/src/foundation.ts` |
| Compatibility algorithm | `packages/protocol/src/compatibility.ts` |
| Breaking-change linter | `packages/protocol/src/lint.ts` |
| Swift + Kotlin DTO generators | `packages/protocol/src/artifacts.ts` |
| TypeScript bindings generator | `packages/protocol/src/generators/typescript.ts` |
| Error-enum generators (Swift/Kotlin/TS) | `packages/protocol/src/generators/error-enums.ts` |
| Artifact signing (SHA-256 manifest + Ed25519) | `packages/protocol/src/signing.ts` |
| Generation driver (`pnpm schema:generate`) | `packages/protocol/scripts/generate-native-artifacts.ts` |
| Fixture driver (`pnpm fixtures:generate`) | `packages/protocol/scripts/generate-fixtures.ts` + `packages/protocol/src/fixtures.ts` |
| Drift gate (`pnpm verify:generated`) | `scripts/check-generated-artifacts.ts` |
| Field-sensitivity redaction | `packages/protocol/src/sensitivity.ts` |
| Versioning policy | `docs/versioning.md` |
| Author-facing tutorial (partially stale — see §10) | `docs/schema-author-tutorial.md` |

---

## 1. How schemas are authored

**There is no builder DSL.** A schema is a plain TypeScript object literal typed as
`FrickSchema` (`packages/protocol/src/schema.ts:161-180`). Authoring locations:

1. **Framework foundation schema** — `packages/protocol/src/foundation.ts:3-22`,
   exported as `foundationSchema`. It is **intentionally empty** (all eight collection
   arrays are `[]`); see §9 for the full literal.
2. **App schemas** — a scaffolded app gets `src/schema.ts` from the CLI template
   `apps/cli/src/templates/schema.ts.ts:14-40` (markers `// frick:objects` /
   `// frick:streams` are append points for `frick scaffold object|stream`).
   A real production example: `apps/rangercrm-server/src/schema.ts:15-201`.
3. **Splice-in def factories** — the calls control plane exposes
   `callObjectDefs(idBase)`, `callStreamDefs(idBase)`, `callEventDefs(idBase)`,
   `callSignalDefs(idBase)` plus a self-contained `buildCallSchema()`
   (`apps/server/src/calls/call-schema.ts:243-294`). Hosts that also run chat splice
   the `call*Defs(idBase)` arrays into their own schema with an id offset.
4. **Test fixture** — `productTestSchema`
   (`packages/protocol/src/fixtures/product-test-schema.ts:9-286`) is a full-featured
   chat-product schema (objects, streams, events, presences, signals, blobs, jobs,
   projections) kept only for exercising framework primitives in tests. It is exported
   from the package index (`packages/protocol/src/index.ts`) but must not be used at
   runtime.

Schemas enter the server through:
- `new FrickStore({ schema })` → `validateSchema(options.schema ?? foundationSchema)`
  (`apps/server/src/store.ts:453`);
- `createFrickServer` picks `runtimeSchema = options.schema ?? (options.apps === undefined ? project?.schema : undefined) ?? foundationSchema`
  (`apps/server/src/server.ts:526-527`);
- project modules run `validateSchema(input.schema)` (`apps/server/src/platform/project.ts:26`);
- multi-app servers register one `FrickAppDefinition { id, schema, basePath, projections?, jobs? }`
  per app (`apps/server/src/apps/registry.ts:20-41`); the registry resolves apps by
  `schemaId` for WebSocket hello routing (`findBySchemaId`, registry.ts:103-105) and by
  longest `basePath` prefix for HTTP. **Note:** app schemas in `options.apps` are *not*
  passed through `validateSchema` by the registry itself — only the store's own schema
  and project-module schemas are validated.

---

## 2. The canonical schema AST — every node type and field

All numeric fields are JS `number`s holding integers. In Rust use `u32` for all `id`
fields, `ttlMs`, `protocolVersion`, and the revision fields (validation requires
revisions be **positive**, i.e. ≥ 1). Field declaration order below matters: object
literals are msgpack/JSON-encoded in **insertion order** (but see the §3 canonicalization
caveat: a `validateSchema`d schema has *alphabetically sorted* keys).

### 2.1 `FieldKind` (schema.ts:1-10) — exact enum strings

```
"id" | "ref" | "string" | "bool" | "timestamp" | "int" | "bytes" | "enum" | "json"
```

(Beware: docs/schema-author-tutorial.md uses `"boolean"` in an example — that is wrong;
the wire/AST value is `"bool"`.)

### 2.2 `FieldSensitivity` (schema.ts:27) and default (schema.ts:38)

```
"public" | "private" | "pii" | "secret" | "content"
DEFAULT_FIELD_SENSITIVITY = "private"   // applied when `sensitivity` is omitted
```

`resolveFieldSensitivity(field) = field.sensitivity ?? "private"` (schema.ts:69-71).
Sensitivity is **server-only metadata**: never emitted into Swift/Kotlin/TS artifacts
(schema.ts:47-54). Redaction policy lives in `packages/protocol/src/sensitivity.ts`:
`REDACTED_FIELD_VALUE = "<redacted>"`, default redacted set = `["pii","secret","content"]`.

### 2.3 `FieldDef` (schema.ts:40-55)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | number (u32, ≥1 by convention; the implicit DTO id uses 0) | yes | unique within the owning field list |
| `name` | string | yes | unique (case-insensitive) within the owning field list |
| `kind` | `FieldKind` | yes | |
| `required` | boolean | yes | |
| `ref` | string | no | target object **or blob** type name; only meaningful for `kind:"ref"` |
| `enumValues` | string[] | no | mandatory non-empty for `kind:"enum"`; order is wire-significant (see lint §5.2) |
| `sensitivity` | `FieldSensitivity` | no | server-only; default `"private"` |

### 2.4 `IndexDef` (schema.ts:73-77)

`{ id: number; name: string; fields: string[] }` — `fields` are field *names* of the
owning type; ids/names unique per owner.

### 2.5 `FrickObjectMergePolicy` (schema.ts:97)

```
"lastWriteWins" | "versionPrecondition"
```
Default when omitted: `"lastWriteWins"` (`resolveObjectMergePolicy`, schema.ts:268-274 —
also falls back to `"lastWriteWins"` for *unknown object names*). Server-only for v1;
intentionally **not** emitted into generated artifacts (schema.ts:91-96).

### 2.6 Type defs (schema.ts:99-159)

```ts
ObjectDef     { id, name, fields: FieldDef[], indexes: IndexDef[], mergePolicy?: FrickObjectMergePolicy }
StreamDef     { id, name, keyFields: FieldDef[], events: string[] }      // events = EventDef names
EventDef      { id, name, fields: FieldDef[] }
PresenceDef   { id, name, keyFields: FieldDef[], fields: FieldDef[], ttlMs: number }
SignalDef     { id, name, keyFields: FieldDef[], fields: FieldDef[], ttlMs: number }
BlobDef       { id, name, metadataFields: FieldDef[] }
JobDef        { id, name, fields: FieldDef[] }
ProjectionDef { id, name, source: string, fields: FieldDef[], indexes: IndexDef[] }   // source = stream OR object name
```

ttlMs examples in fixtures: `5000` (TypingState presence), `30000` (WebRTCSignal).

### 2.7 `FrickSchema` root (schema.ts:161-180) — field order as authored

| # | Field | Type | Constraint |
| --- | --- | --- | --- |
| 1 | `name` | string | not validated (display only) |
| 2 | `schemaId` | string | non-empty after trim (schema.ts:396-398) |
| 3 | `schemaVersion` | string | non-empty after trim (schema.ts:399-401) |
| 4 | `schemaRevision` | number | integer > 0 (schema.ts:402-404) |
| 5 | `minimumClientRevision` | number | integer > 0 |
| 6 | `minimumServerRevision` | number | integer > 0 |
| 7 | `protocol` | literal `"frick.realtime"` | else throw `Unsupported protocol: …` (schema.ts:189-191) |
| 8 | `protocolVersion` | number | `1` everywhere today; not range-validated |
| 9 | `compatibility` | literal `"greenfield-cutover"` | else throw `Unsupported compatibility mode: …` (schema.ts:192-194) |
| 10 | `hash` | string | **opaque, hand-authored** — see §4 |
| 11 | `objects` | ObjectDef[] | |
| 12 | `streams` | StreamDef[] | |
| 13 | `events` | EventDef[] | |
| 14 | `presences` | PresenceDef[] | |
| 15 | `signals` | SignalDef[] | |
| 16 | `blobs` | BlobDef[] | |
| 17 | `jobs` | JobDef[] | |
| 18 | `projections` | ProjectionDef[] | |

All eight collections are **mandatory** (use `[]`, never omit).

### 2.8 Packed wire shapes derived from the schema (schema.ts:182-184, codec.ts:21-40)

```ts
PackedField          = [fieldId: number, value: unknown]
PackedRecord         = [typeId: number, recordId: string, fields: PackedField[]]
PackedStreamEvent    = [streamTypeId, streamKey: string, sequence: number, eventId: string, eventTypeId, fields]
PackedPresenceRecord = [presenceTypeId, presenceKey: string, fields]
PackedSignalEnvelope = [signalTypeId, signalKey: string, fields]
```

Packing (`codec.ts:149-154`) iterates `Object.entries(value)` — i.e. fields are packed in
the **caller's property insertion order**, not schema order — and resolves names → ids via
the schema; unknown names throw `Unknown field {name}`. Unpacking object records re-adds
`id: packed[1]` as a named property (codec.ts:69). The numeric ids in these tuples are why
"stable ids matter more than names" — the wire never carries field names.

---

## 3. `validateSchema` — rules and canonicalization

`validateSchema(schema)` (schema.ts:186-256) returns a **normalized clone**, then checks:

1. `stableClone` (schema.ts:494-514): deep-clones the input; for every plain object it
   **sorts keys with `Object.keys(...).sort()`** (lexicographic UTF-16 code-unit order)
   and **drops `undefined`-valued properties**; arrays keep their order. ⚠️ Consequence:
   the runtime schema held by the server (`store.schema`) has *alphabetically sorted map
   keys* at every level. This is the object that gets:
   - JSON-serialized by `GET /schema` (`apps/server/src/server.ts:1438-1441`), and
   - msgpack-encoded into the `schema_versions.manifest` BLOB
     (`apps/server/src/store.ts:1603-1620`; SQLite: `INSERT OR IGNORE INTO schema_versions
     (schema_hash, manifest, created_at)`, created_at = `new Date().toISOString()`;
     Postgres path uses `ON CONFLICT (schema_hash) DO NOTHING`).
   By contrast, `packages/protocol/fixtures/foundation-schema.json` is written from the
   *unvalidated* literal and keeps authored order. A Rust port that wants byte-identical
   `GET /schema` / manifest bytes must reproduce the sorted-key form.
2. `protocol` / `compatibility` literal checks (errors quoted in §2.7).
3. Identity checks (schema.ts:395-411): `schemaId`/`schemaVersion` non-empty strings,
   the three revision fields positive integers. (`hash` is **not** checked at all.)
4. `validateTypeSet` per collection (schema.ts:377-393): duplicate numeric `id` →
   `Duplicate {label} id {id}`; duplicate **lower-cased** name → `Duplicate {label} name {name}`.
   Labels: `object`, `stream`, `event`, `presence`, `signal`, `blob`, `job`, `projection`.
5. Field validation `validateFields(owner, fields, {objectNames, blobNames})`
   (schema.ts:421-455): duplicate field id (`Duplicate field id {id} in {owner}`),
   duplicate case-insensitive field name (`Duplicate field name {owner}.{name}`); a
   `kind:"ref"` field with a `ref` value must target an existing **object or blob** name
   (`Unknown ref target {ref} in {owner}.{name}`) — note a `ref` field with `ref`
   undefined passes; `kind:"enum"` must have non-empty `enumValues`
   (`Enum field {owner}.{name} must declare enumValues`); a present `sensitivity` must be
   one of the five values (`Unknown sensitivity "{v}" for field {owner}.{name}`).
   Owners checked: every object (`{name}`), stream keys (`{name}.key`), events, presence
   keys + fields, signal keys + fields, blob `metadataFields`, job fields, projection
   fields.
6. Stream `events` entries must name declared events (`Unknown stream event {e} in {s}`,
   schema.ts:218-222).
7. Projection `source` must name a declared stream **or** object
   (`Unknown projection source {src} in {name}`, schema.ts:248-250).
8. Index validation (schema.ts:457-468): index ids/names unique per owner (label
   `"{owner} index"`), and every `index.fields` entry must be a declared field name
   (`Unknown index field {owner}.{index}.{field}`).

Lookup helpers (`objectByName/objectById/...`, schema.ts:258-375) throw
`Unknown {label}: {name}` / `Unknown {label} id: {id}` / `Unknown field {name}` /
`Unknown field id {id}`.

`blobRefFields(schema)` (schema.ts:340-351) enumerates declared object fields of
`kind:"ref"` whose `ref` names a blob — the authoritative reference set for orphaned-blob
GC (FR-57). Blob ids stashed in `string`/`json` fields are invisible to it by design.

---

## 4. `schemaHash` and `schemaRevision` — exactly how identity works

### 4.1 ⚠️ The hash is NOT computed. Anywhere.

This is the single most important (and surprising) finding for the rewrite:

- `FrickSchema.hash` is a **hand-authored opaque string**. Examples:
  `"frick-foundation-empty-0.1.0"` (foundation.ts:13), `"rangercrm-0.1.0"`
  (rangercrm schema.ts:25), `"frick-product-test-0.2.0"` (fixture:19),
  `"frick-calls-0.1.0"` (call-schema.ts), `"scaffold"` (CLI template:27).
- There is **no content-hash function over the schema AST** in the repo. The only
  hashing in the pipeline is SHA-256 over generated *artifact file bytes* and Ed25519
  over the signing identity (§6). Verified by exhaustive search: `createHash` appears
  only in `signing.ts`.
- Two pieces of documentation claim otherwise and are **stale/aspirational**:
  - `apps/cli/src/templates/schema.ts.ts:10-12` — "`hash` is recomputed by the framework
    on validate" (it is not; `validateSchema` never touches `hash`).
  - `docs/schema-author-tutorial.md:112,144` — "the hash will change automatically
    because the AST changed — it's a content hash" (no code implements this; authors must
    bump the string manually).
- Therefore the **only operation ever performed on `hash` is string equality**. For the
  Rust port: model it as an opaque `String`; do not derive it. If the rewrite chooses to
  implement the documented content hash, that is a *new* design decision that must keep
  byte-equality with whatever TS clients ship — the safe wire-compatible choice is to
  keep it authored/opaque.

### 4.2 `schemaRevision` family

All three are authored positive integers (validated `> 0`):
- `schemaRevision` — the wire-contract generation counter (`1` everywhere today).
- `minimumClientRevision` — oldest client revision the server accepts.
- `minimumServerRevision` — oldest server revision the client accepts.

Policy (docs/versioning.md:46-51): the wire contract is governed by `schemaRevision`,
not package versions; a revision bump always travels with ≥ a minor bump of
`@fricken/protocol`; capability flags allow additive change within a revision.
docs/schema-author-tutorial.md:131-144 gives the bump matrix (additive ⇒ no bump;
required-field add / removal / kind-or-ref change / enum-value removal ⇒ bump, removal
and in-place type change also raise `minimumClientRevision`).

### 4.3 Where hash/revision appear on the wire

- **Hello** (`packages/protocol/src/frame.ts:46-53`): `HelloPayload.schemaHash: string`
  (plus optional `clientCapabilities.schema = { schemaId, schemaRevision, schemaHash }`,
  `capabilities.ts:17-21,51-57`).
- **HelloAck** (frame.ts:113-119): `{ schemaHash, schemaId, schemaRevision, schemaCompatibility: SchemaCompatibilityResult, serverCapabilities }`.
- **Error envelope** (`errors.ts:35-43`): optional `schemaHash?: string`,
  `schemaRevision?: number` (validated `Number.isInteger`).
- **Legacy strict check** — when the client sends no capabilities, the gateway calls
  `rejectSchemaMismatch(clientHash, serverHash)` (frame.ts:228-232): plain `!==` throws
  `Schema mismatch: client={h} server={h}`; gateway converts to a Nack with code
  `schema.incompatible` (`apps/server/src/sync/gateway.ts:1182-1207`).
- **Capability path** — gateway builds a pseudo client schema via
  `schemaFromClientCapabilities` (gateway.ts:2390-2397): `{ ...serverSchema,
  schemaId: caps.schema.schemaId, schemaRevision: caps.schema.schemaRevision,
  hash: caps.schema.schemaHash }`. ⚠️ Because it spreads the *server* schema, the
  client's `minimumServerRevision` used in the check below is actually the server's own
  value — `serverTooOld` can effectively only fire on a self-inconsistent server schema.
- **HTTP**: every CORS-touched response carries `X-Frick-Schema-Hash`
  (server.ts:3220) and the header is CORS-exposed as `x-frick-schema-hash`
  (server.ts:3246-3249). SSE streams set the same header (`apps/server/src/sync/sse.ts:49`).
  `GET /schema` (and `GET <basePath>/schema` per app) returns the active schema as JSON
  (server.ts:1438-1441).
- **Persistence**: `schema_versions(schema_hash TEXT PRIMARY KEY, manifest BLOB, created_at)`
  — manifest is the msgpack-encoded (sorted-key) schema (store.ts:1603-1620; DDL at
  `apps/server/src/storage/migrations.ts:101`, `apps/server/src/storage/pg-framework-migrations.ts:44`).
- **Multi-app hello routing**: an advertised `schemaId` that matches no registered app
  and isn't the store's own ⇒ Nack `auth.forbidden` with
  `details: { reason: "appNotAuthorized", knownAppIds }` (gateway.ts:1148-1172).

### 4.4 `compareSchemaCompatibility(client, server)` — exact algorithm

(`packages/protocol/src/compatibility.ts:26-76`; checks run in this order, first match wins)

1. `client.schemaId !== server.schemaId` ⇒ `{compatible:false, reason:"schemaIdMismatch",
   message: "Schema id mismatch: client={id} server={id}"}`.
2. `client.schemaRevision < server.minimumClientRevision` ⇒ `clientTooOld`,
   message `"Client schema revision {r} is below server minimum {m}"`.
3. `server.schemaRevision < client.minimumServerRevision` ⇒ `serverTooOld`,
   message `"Server schema revision {r} is below client minimum {m}"`.
4. `client.hash !== server.hash` ⇒ `{compatible:true, reason:"revisionCompatibleHashMismatch",
   message:"Schema revisions are compatible but hashes differ"}`.
5. otherwise `{compatible:true, reason:"exact"}` (no message).

Every result carries `clientRevision` and `serverRevision`. `requireSchemaCompatibility`
throws `Error(result.message)` on incompatible. Incompatible hello ⇒ Nack with code
`schema.incompatible` and `details.appId` / `details.knownAppIds` (gateway.ts:1210-1245);
required-capability misses ⇒ `sync.protocolError` with `details.unsupportedCapabilities`.

---

## 5. The breaking-change linter (`packages/protocol/src/lint.ts`)

Severities: `"info" | "warn" | "breaking"` (lint.ts:31). Finding shape (lint.ts:33-40):
`{ severity, path, message, ruleId }`; result `{ findings, breakingCount }` where
`breakingCount` counts `severity === "breaking"` (lint.ts:52-57). The linter never throws
on schema content.

### 5.1 `lintSchema(schema)` — single-snapshot validity (lint.ts:60-97)

| ruleId | severity | trigger | path |
| --- | --- | --- | --- |
| `schema.identity.missing` | breaking | `schemaId` not a non-empty string | `schemaId` |
| `schema.revision.invalid` | breaking | `schemaRevision` not a positive integer | `schemaRevision` |
| `{label}.duplicate.name` | breaking | case-insensitive duplicate type name in any of the 8 collections (labels: object/stream/event/presence/signal/blob/job/projection) | `{collection}[{lowercased name}]` |
| `field.duplicate.name` | breaking | case-insensitive duplicate field name — checked for **objects and events only** (lint.ts:89-94) | `objects[{N}].fields[{name}]` / `events[{N}].fields[{name}]` |

### 5.2 `lintSchemaChange(current, previous)` — diff lint (lint.ts:100-167)

Argument order gotcha: **current first, previous second** (CLI: `lintSchemaChange(foundationSchema, previous)`).

Identity rules:

| ruleId | severity | trigger |
| --- | --- | --- |
| `schema.id.changed` | breaking | `previous.schemaId !== current.schemaId` |
| `schema.revision.decreased` | breaking | `current.schemaRevision < previous.schemaRevision` |
| `schema.minimumClientRevision.raised` | warn | `current.minimumClientRevision > previous.minimumClientRevision` |

Type-set rules (applied to all 8 collections; matching is **by numeric id**, lint.ts:171-213):

| ruleId | severity | trigger | path |
| --- | --- | --- | --- |
| `{label}.removed` | breaking | id present in prev, absent in curr | `{collection}[{prevName}]` |
| `{label}.added` | info | id present in curr, absent in prev | `{collection}[{currName}]` |
| `{label}.renamed` | breaking | same id, `name` differs | `{collection}[{currName}]` |

Per-type member diffs run only for **id pairs present in both** snapshots:
- objects: fields + indexes (`objects[{name}]`)
- events: fields (`events[{name}]`)
- streams: keyFields at `streams[{name}].key`; event-name set diff —
  `stream.event.removed` (breaking) / `stream.event.added` (info), path
  `streams[{name}].events[{event}]` (lint.ts:251-274)
- presences/signals: keyFields at `…[{name}].key` + fields at `…[{name}]`
- blobs: metadataFields at `blobs[{name}].metadata`
- jobs: fields
- projections: `projection.source.changed` (breaking) when `source` differs, path
  `projections[{name}].source`; then fields + indexes

Field diff (`diffFields`, lint.ts:355-444), matching **by field id**:

| ruleId | severity | trigger |
| --- | --- | --- |
| `field.removed` | breaking | field id gone |
| `field.required.added` | breaking | new field id with `required: true` |
| `field.optional.added` | info | new field id with `required: false` |
| `field.renamed` | breaking | same id, name changed |
| `field.kind.changed` | breaking | same id, `kind` changed |
| `field.required.toggled` | breaking | `required` flipped false→true |
| `field.optional.toggled` | breaking | `required` flipped true→false (both directions are breaking; only ruleId differs) |
| `field.ref.changed` | breaking | `(p.ref ?? "") !== (c.ref ?? "")` — message uses `<none>` for missing |

Path for all field findings: `{ownerPath}.fields[{currentName}]`.

Enum-value diff (`diffEnumValues`, lint.ts:446-497) — only when **both** prev and curr
have `kind === "enum"`; `enumValues ?? []`:

| ruleId | severity | trigger |
| --- | --- | --- |
| `enum.value.removed` | breaking | value present in prev, absent in curr |
| `enum.value.added.trailing` | warn | new value at index `i >= prevTail` where `prevTail` starts at `prevValues.length` and is advanced to `max(prevTail, i+1)` after each new value — i.e. appended values, and anything following an appended value, are "trailing" |
| `enum.value.inserted` | breaking | new value at an index `< prevTail` (mid-list insertion shifts ordinal encodings) |

Index diff (`diffIndexes`, lint.ts:499-516): **only removals** are reported —
`index.removed` (breaking), path `{ownerPath}.indexes[{name}]`. Index additions and
field-list changes within an index produce no finding.

### 5.3 Linter consumers

- **CLI**: `frick lint [--against <previous-schema.json>]`
  (`apps/cli/src/commands/lint.ts:25-67`). Without `--against`: `lintSchema(foundationSchema)`.
  With it: reads/parses the JSON file (failure ⇒ CLI error `lint.previous_unreadable`),
  runs `lintSchemaChange(foundationSchema, previous)`. Emits one JSON-Lines record per
  finding, then a summary `{ ok, findings, breaking }`. Exit code 1 iff `breakingCount > 0`.
- **Admin HTTP route**: `POST …/schema/lint` under the admin surface
  (`apps/server/src/server.ts:5035-5062`): body `{ previous? }`; without `previous` runs
  `lintSchema(store.schema)`, with it `lintSchemaChange(store.schema, previous)`;
  responds 200 with the `FrickLintResult` JSON; audit action `schema.lint`.

### 5.4 docs/versioning.md semantics (policy layer above the linter)

- One stack version: `pnpm release:bump X.Y.Z` fans a single bare semver tag out to npm,
  the `FrickSwift` mirror, and GitHub Packages for Android (versioning.md:3-7).
- Major = breaking public-surface change **or** a `schemaRevision` bump older clients
  can't decode; minor = additive; patch = no API/wire change (versioning.md:13-17).
- A framework release does **not** imply a revision bump (versioning.md:19).
- Compatibility window: server tolerates clients from the **last two minor versions** of
  the same major; older ⇒ rejected with an `auth.versionUnsupported` envelope
  (versioning.md:55-61). ⚠️ Note: `auth.versionUnsupported` is *not* in
  `FRICK_ERROR_CODES` (errors.ts:12-29) — doc/code mismatch worth resolving in the rewrite.
- Deprecations live ≥ one full minor before removal at the next major (versioning.md:65-74).
- Stable surfaces include "generated native artifacts (Swift/Kotlin constants and
  types)" (versioning.md:86); `packages/protocol/scripts/*` is explicitly unstable.

---

## 6. Artifact signing & the only bit-reproducible hashing in the pipeline

(`packages/protocol/src/signing.ts` — optional, FR-45; a no-op unless
`FRICK_SCHEMA_SIGNING_KEY` is set during generation.)

Constants: `SCHEMA_SIGNATURE_VERSION = 1`, `SCHEMA_SIGNATURE_ALGORITHM = "ed25519"`
(signing.ts:30-31).

1. **Manifest entry** per generated file: `{ path, sha256 }` where `path` is the
   repo-relative path and `sha256` is the **lowercase hex SHA-256 of the file bytes**
   (`sha256Hex`, signing.ts:81-83; driver passes content *including* the trailing
   newline it appends — generate-native-artifacts.ts:39-42).
2. **Identity** (`schemaArtifactIdentity`, signing.ts:100-110):
   `{ schemaId, schemaHash: schema.hash, schemaRevision, manifest }`.
3. **Canonical preimage** (`canonicalizeSchemaIdentity`, signing.ts:119-136) — must be
   byte-identical from Rust:
   - sort manifest entries by `path` ascending using JS `<`/`>` string comparison
     (UTF-16 code-unit order; identical to byte order for ASCII paths);
   - each manifest entry serialized with key order `path`, then `sha256`;
   - build object with key order exactly: `version`, `algorithm`, `schemaId`,
     `schemaHash`, `schemaRevision`, `manifest`;
   - `JSON.stringify` with **no whitespace** (default), UTF-8 encode.
4. **Sign**: Ed25519 over the preimage, no prehash (`crypto.sign(null, …)`),
   signature emitted **base64** (signing.ts:143-166). Private key accepted as
   `KeyObject`, PEM (detected by `-----BEGIN` substring), or base64 PKCS#8 DER;
   public key as `KeyObject`/PEM/base64 SPKI DER (signing.ts:271-317).
5. **Artifact JSON** (`SchemaSignatureArtifact`, signing.ts:50-59):
   `{ version: 1, algorithm: "ed25519", identity, signature }`, written to
   `packages/protocol/generated/schema-signature.json` as
   `JSON.stringify(artifact, null, 2) + "\n"` (generate-native-artifacts.ts:51-54).
6. **Verification** (`verifySchemaArtifact`, signing.ts:176-234) returns
   `{ valid, reason?, message? }` with reasons
   `signatureMismatch | unsupportedVersion | unsupportedAlgorithm | malformedSignature | keyError`;
   empty base64 ⇒ `malformedSignature`. `verifySchemaArtifactForSchema` additionally
   pins expected `{schemaId, schemaHash, schemaRevision}` and reports a mismatch as
   `signatureMismatch` (signing.ts:243-269). Example CLI verifier:
   `packages/protocol/scripts/verify-schema-signature.ts` (exit 0/1/2).

---

## 7. Code generation — `pnpm schema:generate`

Root script (`package.json`): `"schema:generate": "tsx packages/protocol/scripts/generate-native-artifacts.ts"`.
The driver (generate-native-artifacts.ts:14-31) always generates **from
`foundationSchema` only** and writes (paths relative to `process.cwd()` = repo root):

| Output | Generator |
| --- | --- |
| `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift` | `generateSwiftArtifact` |
| `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt` | `generateKotlinArtifact` |
| `packages/core/src/generated/bindings.ts` | `generateTypeScriptBindings` |
| `packages/core/src/generated/errors.ts` | `generateTypeScriptErrorEnum` |
| `packages/protocol/generated/schema-signature.json` (only with `FRICK_SCHEMA_SIGNING_KEY`) | §6 |

Each file is the generator's string + one trailing `"\n"`. Directories are `mkdir -p`'d.
All generators are pure `FrickSchema → string`. They are re-run by `pnpm ios:generate`,
`ios:build`, `swift:test`, `android:build` (root package.json) and gated in CI by
`pnpm verify:generated` (`scripts/check-generated-artifacts.ts`): snapshots dirty
tracked files, runs `schema:generate` + `fixtures:generate` + `design:generate`, and
fails if the run introduced any *new* tracked-file modification (whole-tree check, FR-108).

`pnpm fixtures:generate` (generate-fixtures.ts) wipes and rewrites
`packages/protocol/fixtures/` with `foundation-schema.json` (the raw, authored-order
literal), `error-envelope.json` (code `schema.incompatible`, requestId
`fixture-error`, hash/revision from foundation), and `hello-frame.json`
(`[FrameKind.Hello, {...}]` with `defaultClientCapabilities`), each
`JSON.stringify(value, null, 2) + "\n"` — these are the cross-language golden fixtures.

### 7.1 Swift generator (`artifacts.ts:7-86, 153-231, 248-304`)

Output structure, in order:
1. Header `// Generated by @fricken/protocol.` + `import Foundation`.
2. `public enum FrickSchema` with constants (exact member order):
   `protocolVersion` (Int literal), `schemaId`, `schemaVersion` (JSON-quoted strings),
   `schemaRevision`, `minimumClientRevision`, `minimumServerRevision` (Int literals),
   `schemaHash` (string).
3. Top-level `public let frickSchemaHash = "<hash>"`.
4. `public enum FrickSchemaDescriptor` — five tables typed `[Int: String]` /
   `[Int: [Int: String]]`: `objectNames`, `streamNames`, `eventNames`, `objectFields`,
   `eventFields` (presences/signals/projections are **not** in the descriptor). Empty
   maps must emit `[:]` (Swift parses `[]` as an array) — artifacts.ts:41-47; an object
   with zero fields emits `[ id: [:] ]` via the `|| ":"` fallback (artifacts.ts:65).
   ⚠️ `objectFields` does NOT include the implicit `id` field (it maps declared fields only).
5. Error enum (§7.4).
6. `FrickJSONValue` indirect enum (Codable/Equatable/Sendable with cases
   string/int/double/bool/array/object/null and hand-rolled init/encode) — emitted
   **only if any object/event/presence/signal/job field has `kind:"json"`**
   (artifacts.ts:8, 237-246).
7. One `public struct {TypeName}DTO` per **object, event, presence, signal** (in that
   collection order; streams/blobs/jobs/projections get no DTO). Suffix is uppercase
   `DTO`. Object DTOs get an implicit first field `id` (`{ id: 0, name: "id", kind: "id",
   required: true }`) **unless a field named `id` is declared** (artifacts.ts:201-206),
   conform to `Codable, Equatable, Sendable, Identifiable`, and carry
   `public static let frickType = "<objectName>"`; non-object DTOs conform to
   `Codable, Equatable, Sendable` only. Properties are `public var`, memberwise
   `public init` with `= nil` defaults for optional fields.

Swift type map (artifacts.ts:208-217): `bool→Bool`, `int→Int`, `timestamp→Date`,
`bytes→Data`, `json→FrickJSONValue`, everything else (`id`, `ref`, `string`, `enum`) →
`String`; optional fields get `?`. Property names pass through except Swift keywords
`class`/`struct`/`enum` which are backtick-escaped (artifacts.ts:229-231).

### 7.2 Kotlin generator (`artifacts.ts:88-151, 188-199, 219-235`)

Output structure, in order:
1. Header + `package dev.frick.client` (+ `import kotlinx.serialization.json.JsonElement`
   only when a json field exists).
2. Top-level constants: `FRICK_SCHEMA_ID: String`, `FRICK_SCHEMA_VERSION: String`,
   `FRICK_SCHEMA_REVISION: Int`, `FRICK_MINIMUM_CLIENT_REVISION: Int`,
   `FRICK_MINIMUM_SERVER_REVISION: Int`, `FRICK_SCHEMA_HASH: String`.
   ⚠️ No `protocolVersion` constant (unlike Swift).
3. Descriptor tables as `internal val`: `FRICK_OBJECT_NAMES`, `FRICK_STREAM_NAMES`,
   `FRICK_EVENT_NAMES`: `Map<Int, String>`; `FRICK_OBJECT_FIELDS`,
   `FRICK_EVENT_FIELDS`: `Map<Int, Map<Int, String>>` via `mapOf(id to "name", …)`.
4. Error enum (§7.4).
5. One `data class {Name}Dto(…)` per object/event/presence/signal. Suffix is `Dto`
   (capital D, lowercase to). Class names pass through `kotlinTypeName` which only
   rewrites the substring `"RTC" → "Rtc"` (artifacts.ts:233-235; e.g. `WebRTCSignal` →
   `WebRtcSignalDto`). Object DTOs get the same implicit `id` field injection as Swift.
   Properties: `val {name}: {Type}` with `= null` default when optional. No
   `@Serializable` annotations are emitted.

Kotlin type map (artifacts.ts:219-227): `bool→Boolean`, `int→Int`, `bytes→ByteArray`,
`json→JsonElement`, everything else — **including `timestamp`** — → `String`; optional ⇒
nullable `?`. (⚠️ asymmetry: Swift decodes timestamps as `Date`, Kotlin keeps `String`.)

### 7.3 TypeScript bindings generator (`generators/typescript.ts:27-158`)

Emitted to `packages/core/src/generated/bindings.ts`, consumed by `@fricken/core`:
1. Header `// Generated by @fricken/protocol. Do not edit by hand.` +
   `// Source schema: "<schemaId>"@<schemaVersion> (hash="<hash>")`.
2. Imports from `../bindings.js`, `../runtime.js`, and `@fricken/protocol` (import path
   overridable via `options.schemaImportPath`).
3. `export interface {Name}Dto` per object (with implicit `id` field, typescript.ts:128-131),
   event, presence, signal. Optional fields use `?:`.
   Type map (typescript.ts:133-154): `bool→boolean`, `int→number`, `bytes→Uint8Array`,
   `json→unknown`, `enum→` string-literal union of `enumValues` (or `string` if empty),
   `id|ref|string|timestamp→string`.
4. `export type {StreamName}Event = | { event: "<EventName>"; payload: <EventName>Dto } | …`
   (`never` for empty streams).
5. `export interface FrickBindings` mapping every object/stream/presence/signal/projection
   name to `ObjectBinding<>/StreamBinding<>/PresenceBinding<>/SignalBinding<>/ProjectionBinding<PlainObject>`.
6. `export function bindFrickSchema(client)` shim delegating to runtime `bindSchema`.
7. `export const OBJECT_FIELD_INDEX = { {Name}: { id: <typeId>, fields: { <fieldName>: <fieldId>, … } }, … } as const;`
   (includes the implicit `id: 0`) and `EVENT_FIELD_INDEX` (no implicit id). Field-name
   keys are bare identifiers when they match `/^[A-Za-z_$][A-Za-z0-9_$]*$/`, else
   JSON-quoted (typescript.ts:156-158).

### 7.4 Error-code enums (`generators/error-enums.ts`)

Source of truth: `FRICK_ERROR_CODES` (errors.ts:12-29) — exact 16 wire strings, in order:
`auth.unauthenticated`, `auth.forbidden`, `auth.sessionExpired`, `schema.incompatible`,
`schema.migrationRequired`, `storage.conflict`, `storage.notFound`,
`stream.appendRejected`, `stream.invalidCursor`, `sync.protocolError`,
`sync.reconnectExhausted`, `blob.tooLarge`, `blob.unsupportedContentType`,
`blob.quotaExceeded`, `rateLimit.exceeded`, `server.internal`.

- **Swift**: `public enum FrickErrorCode: String, Codable, CaseIterable, Sendable` with
  cases named by `camelize` — split on `.`, first segment unchanged, later segments
  capitalized and concatenated (`auth.sessionExpired` → `authSessionExpired`). Unknown
  wire codes decode to `nil`.
- **Kotlin**: `enum class FrickErrorCode(val wireValue: String)` with entries named by
  `screamingSnake` — split on `.`, each segment camelCase-split via regex
  `([a-z0-9])([A-Z]) → $1_$2` then uppercased, joined with `_`
  (`auth.sessionExpired` → `AUTH_SESSION_EXPIRED`); plus
  `companion object { fun fromWire(value: String?): FrickErrorCode? }` backed by a
  `BY_WIRE` map.
- **TypeScript**: const array + union + `FRICK_ERROR_CODE_SET` + `isFrickErrorCode`,
  written to `packages/core/src/generated/errors.ts`.

---

## 8. Capabilities tie-in (schema identity inside the handshake)

`schemaCapability(schema)` (capabilities.ts:51-57) projects a schema to
`{ schemaId, schemaRevision, schemaHash: schema.hash }` — field order as listed.
`defaultClientCapabilities` defaults: transports `["websocket"]`, encodings
`["msgpack"]`, primitives `["objects","streams","presence","signals"]`,
offline `{cache:true, pendingAppends:true}`, blobUploads `["direct"]`, push/experimental/
required `[]`. `defaultServerCapabilities`: transports `["websocket","http"]`, encodings
`["msgpack","json"]`, all 7 primitives, blobUploads `["direct"]`, `limits: {}`.
Capability names flatten as `transport.X`, `encoding.X`, `primitive.X`, `blobUpload.X`,
`push.X`, `experimental.X` (capabilities.ts:92-101); unsupported `required` entries Nack
the hello (§4.3).

---

## 9. Reference schemas

### 9.1 The foundation schema (the reference example) — foundation.ts:3-22, verbatim

```ts
export const foundationSchema: FrickSchema = {
  name: "frick-foundation",
  schemaId: "frick-foundation",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "frick-foundation-empty-0.1.0",
  objects: [],
  streams: [],
  events: [],
  presences: [],
  signals: [],
  blobs: [],
  jobs: [],
  projections: [],
};
```

It is deliberately empty (the old chat-product types moved to `productTestSchema`).
Golden JSON fixture: `packages/protocol/fixtures/foundation-schema.json` (authored key
order, 2-space pretty-printed).

### 9.2 Non-trivial examples

- `productTestSchema` (fixtures/product-test-schema.ts) — exercises every node type:
  8 objects (incl. `mergePolicy: "versionPrecondition"` on `MessageDraft`/`ScheduledMessage`),
  2 streams, 9 events, 1 presence (`ttlMs: 5000`), 1 signal (`ttlMs: 30000`, `bytes`
  payload, 5-value enum), 1 blob (`AttachmentBlob` with `contentHash`/`byteLength`/
  `mimeType` metadata), 1 job, 1 projection (`ConversationInbox` sourced from
  `MessageStream`). Note its `hash` is `"frick-product-test-0.2.0"` while
  `schemaVersion` is `"0.1.0"` — proof the hash is free-form.
- `apps/rangercrm-server/src/schema.ts` — a shipped app schema: 5 objects, all
  `versionPrecondition`, camelCase fields, money as `int` cents, lat/lng as `string`s
  for wire stability, enum example `quoteStatus: ["open","closed","won","lost"]`.

### 9.3 Authoring conventions (docs/schema-author-tutorial.md:123-129, 150-157)

camelCase field names; booleans as predicates (`isArchived`); timestamps end `At`; ids
end `Id`. Ids start at 1, are scoped to their owner, and are **never reused** (a deleted
field's id is permanently retired). Never change a field's kind in place; never hand-edit
generated files.

---

## 10. Surprises, stale docs, and Rust porting notes

1. **`hash` is opaque** (§4.1). Two docs claim it is a computed content hash; no code
   computes it. Equality is the only operation. Port it as `String`.
2. **`validateSchema` returns a key-sorted deep clone** (`stableClone`). The runtime
   schema's map-key order is alphabetical at every nesting level, with `undefined`
   properties dropped; arrays preserve order. This is observable in `GET /schema` JSON
   and the msgpack `schema_versions.manifest` blob. In Rust, emit schema maps with
   lexicographically sorted keys to match.
3. **Duplicate detection is case-insensitive** for type names and field names
   (validator and linter both lower-case before comparing), but lookups
   (`objectByName` etc.) are case-sensitive exact matches.
4. **`mergePolicy` and `sensitivity` are deliberately absent from all generated
   artifacts** (schema.ts:47-54, 91-96) — adding them later is wire-compatible.
5. **`schemaFromClientCapabilities` spreads the server schema**, so the
   `serverTooOld` branch of compatibility is effectively dead in the WS path (§4.3).
6. **Hash mismatch with compatible revisions is accepted** (reason
   `revisionCompatibleHashMismatch`) on the capabilities path, but the
   no-capabilities legacy path requires exact hash equality (`rejectSchemaMismatch`).
7. **Index additions are never linted**; only removals (§5.2). Enum trailing adds are
   `warn`, mid-list inserts `breaking` — the `prevTail` cursor algorithm must be ported
   exactly to keep finding parity.
8. **Implicit `id` field injection** happens in all three DTO generators for objects
   only, with the sentinel `FieldDef { id: 0, name: "id", kind: "id", required: true }`,
   and only when no declared field is named `id`. The Swift descriptor tables do *not*
   include it.
9. **Type asymmetries to preserve**: Swift `timestamp→Date` vs Kotlin/TS
   `timestamp→String`; Swift suffix `DTO` vs Kotlin/TS `Dto`; Kotlin-only
   `"RTC"→"Rtc"` class-name rewrite; Kotlin has no `protocolVersion` constant.
10. **Stale tutorial fragments** (do not copy into the rewrite): `kind: "boolean"`
    (should be `"bool"`), stream `key: "taskId"` (StreamDef actually has
    `keyFields: FieldDef[]`), `severity=additive` (the linter emits `info`), and the
    auto-recomputed-hash claim. Also `auth.versionUnsupported` (versioning.md:59) is not
    a registered error code.
11. **msgpack library**: `@msgpack/msgpack` `^3.1.2` everywhere
    (`packages/protocol/package.json:32`, `apps/server/package.json:54`); frames are
    `encode(frame)` / `decode(bytes)` of the `[kind, payload]` tuples (frame.ts:215-223).
12. The generation driver is cwd-sensitive (`process.cwd()` = repo root); generated
    files always end in exactly one trailing newline.
13. `lintSchemaChange` only diffs members of type-id pairs that exist on **both** sides;
    a removed-and-readded id (same id, new shape) surfaces as rename/kind findings, not
    add+remove.
14. Schema persistence is append-only by hash: first boot inserts
    `(schema.hash, msgpack(schema), iso-timestamp)`; later boots with the same hash are
    no-ops (`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`).
