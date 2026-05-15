# Schema Author Tutorial

This tutorial is for someone adding a new object, event, or projection to the foundation schema (or to a scaffolded app's schema). By the end you will have added a `Reaction` object type end-to-end: edited the schema, regenerated Swift and Kotlin DTOs, confirmed there are no breaking changes via `frick lint`, and decided whether to bump `schemaRevision`.

## Mental model

In Frick, **the schema is the contract**. It is the canonical source for:

- the wire frames the server and clients exchange,
- the server's storage layout (table names, column names, indexes),
- the local cache layout on every client (TS, Swift, Kotlin),
- the generated DTOs each native client sees,
- the fixtures and compatibility tests in CI.

You write the schema once, in TypeScript, as a `FrickSchema` literal in `packages/protocol/src/foundation.ts` (for framework changes) or in `src/schema.ts` (for an app scaffolded with `frick init`). Everything else is generated or derived.

Two consequences of "schema is canonical":

1. **Stable ids matter more than names.** Every object, field, stream, and event has a numeric `id`. The framework tracks compatibility by id — renaming a field is safe, reusing an id is not.
2. **Drift is detected, not tolerated.** `pnpm verify:generated` regenerates every tracked schema, fixture, and design artifact and fails CI if anything moved. There is no "I'll regenerate later."

## Walkthrough: add a Reaction object

We'll add a typed `Reaction` object — a row that ties a user, a message id, and an emoji — alongside the existing `ReactionAdded` event in the foundation schema. (`ReactionAdded` is a stream event; the `Reaction` object is a materialized projection target that supports "show me all reactions on this message".)

### 1. Edit the schema

Open `packages/protocol/src/foundation.ts` and add a new entry to `objects[]`. Pick the next free object id by reading the largest existing `id` and adding one.

```ts
{
  id: 7,                         // next free id; never reuse
  name: "Reaction",
  fields: [
    { id: 1, name: "messageId",  kind: "id",        required: true },
    { id: 2, name: "userId",     kind: "ref", ref: "User", required: true },
    { id: 3, name: "emoji",      kind: "string",    required: true },
    { id: 4, name: "createdAt",  kind: "timestamp", required: true },
  ],
  indexes: [
    { id: 1, name: "byMessage", fields: ["messageId"] },
    { id: 2, name: "byUser",    fields: ["userId"] },
  ],
},
```

Notes:

- Field ids start at 1 and are unique **within the object** — they're not globally unique. The `byMessage` and `byUser` index ids are likewise scoped to the object.
- `kind: "id"` is for stable opaque identifiers the framework treats as primary keys. `kind: "ref"` carries a `ref` to another object name and tells the framework to track foreign-key-style integrity.
- Required fields cannot be added later without bumping `schemaRevision` (see "versioning interplay" below). Plan accordingly.

### 2. Regenerate native artifacts

```bash
pnpm schema:generate
```

This regenerates `packages/swift/Sources/FrickGenerated/`, `apps/android/frick/src/main/kotlin/dev/frick/generated/`, and the fixtures used by the codec drift checks. You should see new `Reaction.swift` and `Reaction.kt` DTOs.

Then:

```bash
pnpm fixtures:generate
pnpm verify:generated
```

`verify:generated` runs schema, fixture, and design-token regeneration end-to-end and fails if the tracked generated outputs have uncommitted differences after — i.e. it's the same check CI runs.

### 3. Lint for breaking changes

```bash
pnpm cli lint --against ./baseline-schema.json
```

The optional `--against` flag points at a previous-schema snapshot on disk. Without it, `frick lint` only runs single-schema validation (no missing refs, no duplicate ids, etc.). With it, you get a change report: each finding is one JSON Lines record with a `severity` field. Exit code is 1 only when at least one finding is `severity=breaking`.

For an additive change like adding `Reaction`, you should see only `severity=info` or `severity=additive` records.

### 4. Decide whether to bump revision

Open the top of `foundation.ts`:

```ts
schemaRevision: 1,
minimumClientRevision: 1,
```

If the lint reported only additive findings, you don't need to bump anything — the hash will change automatically because the AST changed, and that's enough to tell client caches "your snapshot is stale, please resync."

If the lint reported a `breaking` finding (you removed a required field, changed a type in place, or renamed an enum value), then:

- Bump `schemaRevision` by one.
- Decide whether `minimumClientRevision` should rise with it. Raise it when older clients literally cannot interpret the new wire frames; leave it when older clients can still read the new server (the server will just hide the breaking-only fields).

### 5. Add a migration if storage changed

Storage migrations live alongside the server. For pure schema-driven changes (new objects, new fields, new indexes) the framework synthesizes the migration from the schema diff and you don't have to write one. For changes that touch how data is interpreted — backfilling a derived field, splitting one stream into two — write a migration file under `apps/server/src/migrations/` and the migration runner will apply it before the server accepts traffic. See `frick migrate status` and `frick migrate up` in [`apps/cli/README.md`](../apps/cli/README.md).

## Authoring conventions

- **Field naming.** `camelCase`. Booleans read as predicates (`isArchived`, not `archived`). Timestamps end in `At` (`createdAt`, `expiresAt`). Ids end in `Id` (`messageId`, `userId`).
- **Stable ids.** Pick the next free numeric `id` and never reuse one. If you delete a field, leave a comment so the next author doesn't accidentally pick the same id.
- **Objects vs streams vs projections.** Use an **object** for state that has a current value clients want to render directly (User, Conversation, Reaction). Use a **stream** for append-only history that clients want to tail (MessageStream). Use a **projection** for a derived view that's expensive to compute on every client (an unread-count, a leaderboard) — write it once on the server, push deltas to subscribers.
- **Indexes.** Declare every access pattern you actually rely on. The framework will not create implicit indexes; missing one means a full scan in production.
- **Enums over free-form strings.** If a field has a known small set of values, model it as `kind: "enum"`. Future-you will get exhaustive switches in Swift and Kotlin for free.

## When to bump revision vs hash

| Change                                                            | Hash changes | `schemaRevision` bump | `minimumClientRevision` bump |
| ----------------------------------------------------------------- | :----------: | :-------------------: | :--------------------------: |
| Add an optional field on an object                                | yes          | no                    | no                           |
| Add a new object, stream, event, projection, job, or signal       | yes          | no                    | no                           |
| Add a new index                                                   | yes          | no                    | no                           |
| Add a required field on an object                                 | yes          | **yes**               | depends                      |
| Rename a field (id stable)                                        | yes          | no                    | no                           |
| Remove a field                                                    | yes          | **yes**               | **yes**                      |
| Change a field's `kind` or `ref` in place                         | yes          | **yes**               | **yes**                      |
| Remove an enum value still in use                                 | yes          | **yes**               | **yes**                      |

The hash changes any time the AST changes — it's a content hash. Revision bumps are deliberate and tell clients "discard your cache and reconnect with the new contract."

## Versioning interplay

The full breaking-change policy, the support window for older clients, and the publish-time checklist live in [`docs/versioning.md`](./versioning.md). Read it before bumping `schemaRevision` on a published schema.

## Anti-patterns

- **Don't reuse field ids.** Even after a field is deleted, its `id` is permanently retired. Reusing it will read old bytes as a new type and corrupt clients in subtle ways.
- **Don't change a field's type in place.** Add a new field with a new id, dual-write for a release, then deprecate the old one.
- **Don't remove required fields without a revision bump.** Older clients still expect them on the wire.
- **Don't rename an enum value to "fix a typo" without a revision bump.** The wire form carries the string; renaming silently breaks any client that hasn't regenerated.
- **Don't skip `pnpm verify:generated`.** If the artifacts in git don't match what regeneration produces, every client downstream will eventually see a hash mismatch.
- **Don't hand-edit generated Swift or Kotlin DTOs.** They will be overwritten on the next `schema:generate` and your change will silently disappear.

## Next steps

- Run the [onboarding tutorial](./onboarding.md) end-to-end if you haven't yet.
- Read [`docs/authoring.md`](./authoring.md) for the full `frick scaffold` reference.
- Read [`docs/versioning.md`](./versioning.md) before bumping a revision in a shipped schema.
