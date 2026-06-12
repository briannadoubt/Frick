/**
 * Golden lint fixtures for the FR-236 Rust rewrite (FR-239).
 *
 * Runs the production TypeScript linter (`lintSchema` / `lintSchemaChange`)
 * over a comprehensive set of schema snapshots and snapshot pairs, and writes:
 *
 *   conformance/fixtures/lint/manifest.json — every case with its input
 *     schema(s) and the exact `FrickLintResult` the TS linter produced.
 *
 * The Rust `frick-schema` crate must reproduce each expected result exactly:
 * same ruleId strings, severities, paths, messages, finding order, and
 * breakingCount (`crates/frick-schema/tests/lint_golden.rs`).
 *
 * Every linter rule is triggered by at least one case (asserted below), and
 * a handful of cases pin deliberate *non*-rules (ttlMs, mergePolicy, hash,
 * index additions, …) with empty findings.
 *
 * Run from the repo root: pnpm fixtures:lint
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  lintSchema,
  lintSchemaChange,
  type FrickLintResult,
} from "../src/lint.js";
import type {
  EventDef,
  FieldDef,
  FrickSchema,
  ObjectDef,
  PresenceDef,
  ProjectionDef,
  SignalDef,
  StreamDef,
} from "../src/schema.js";
import { foundationSchema } from "../src/foundation.js";
import { productTestSchema } from "../src/fixtures/product-test-schema.js";

const outDir = join(process.cwd(), "conformance", "fixtures", "lint");

interface LintCase {
  name: string;
  description: string;
  mode: "schema" | "change";
  current: FrickSchema;
  previous?: FrickSchema;
}

/** Every ruleId the linter can emit — the generator fails if any is untriggered. */
const ALL_RULE_IDS = [
  // lintSchema
  "schema.identity.missing",
  "schema.revision.invalid",
  ...["object", "stream", "event", "presence", "signal", "blob", "job", "projection"].map(
    (label) => `${label}.duplicate.name`,
  ),
  "field.duplicate.name",
  // lintSchemaChange
  "schema.id.changed",
  "schema.revision.decreased",
  "schema.minimumClientRevision.raised",
  ...["object", "stream", "event", "presence", "signal", "blob", "job", "projection"].flatMap(
    (label) => [`${label}.removed`, `${label}.added`, `${label}.renamed`],
  ),
  "stream.event.removed",
  "stream.event.added",
  "projection.source.changed",
  "field.removed",
  "field.required.added",
  "field.optional.added",
  "field.renamed",
  "field.kind.changed",
  "field.required.toggled",
  "field.optional.toggled",
  "field.ref.changed",
  "enum.value.removed",
  "enum.value.added.trailing",
  "enum.value.inserted",
  "index.removed",
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function product(mutate?: (schema: FrickSchema) => void): FrickSchema {
  const next = clone(productTestSchema);
  mutate?.(next);
  return next;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`fixture setup: missing ${what}`);
  }
  return value;
}

const obj = (s: FrickSchema, name: string): ObjectDef =>
  must(s.objects.find((t) => t.name === name), `object ${name}`);
const stream = (s: FrickSchema, name: string): StreamDef =>
  must(s.streams.find((t) => t.name === name), `stream ${name}`);
const event = (s: FrickSchema, name: string): EventDef =>
  must(s.events.find((t) => t.name === name), `event ${name}`);
const presence = (s: FrickSchema, name: string): PresenceDef =>
  must(s.presences.find((t) => t.name === name), `presence ${name}`);
const signal = (s: FrickSchema, name: string): SignalDef =>
  must(s.signals.find((t) => t.name === name), `signal ${name}`);
const projection = (s: FrickSchema, name: string): ProjectionDef =>
  must(s.projections.find((t) => t.name === name), `projection ${name}`);
const fieldOf = (fields: FieldDef[], name: string): FieldDef =>
  must(fields.find((f) => f.name === name), `field ${name}`);

const cases: LintCase[] = [];

function schemaCase(name: string, description: string, current: FrickSchema): void {
  cases.push({ name, description, mode: "schema", current });
}

function changeCase(
  name: string,
  description: string,
  current: FrickSchema,
  previous: FrickSchema,
): void {
  cases.push({ name, description, mode: "change", current, previous });
}

// ---------------------------------------------------------------------------
// lintSchema — single-snapshot validity
// ---------------------------------------------------------------------------

schemaCase("schema-product-clean", "productTestSchema lints clean", product());
schemaCase(
  "schema-foundation-clean",
  "the empty foundation schema lints clean",
  clone(foundationSchema),
);
schemaCase(
  "schema-id-empty",
  "empty schemaId trips schema.identity.missing",
  product((s) => {
    s.schemaId = "";
  }),
);
schemaCase(
  "schema-id-whitespace",
  "whitespace-only schemaId trips schema.identity.missing (trim semantics)",
  product((s) => {
    s.schemaId = "   ";
  }),
);
schemaCase(
  "schema-revision-zero",
  "schemaRevision 0 trips schema.revision.invalid",
  product((s) => {
    s.schemaRevision = 0;
  }),
);
schemaCase(
  "schema-revision-negative",
  "negative schemaRevision trips schema.revision.invalid",
  product((s) => {
    s.schemaRevision = -3;
  }),
);
schemaCase(
  "schema-duplicate-object-names",
  "case-insensitive duplicate object names, path uses the lowercased key",
  product((s) => {
    s.objects.push({ id: 99, name: "user", fields: [], indexes: [] });
  }),
);
schemaCase(
  "schema-duplicate-names-every-collection",
  "duplicate type names in all eight collections, pinning per-collection finding order",
  product((s) => {
    s.objects.push({ id: 90, name: "USER", fields: [], indexes: [] });
    s.streams.push({ id: 90, name: "messagestream", keyFields: [], events: [] });
    s.events.push({ id: 90, name: "MESSAGESENT", fields: [] });
    s.presences.push({ id: 90, name: "typingstate", ttlMs: 1000, keyFields: [], fields: [] });
    s.signals.push({ id: 90, name: "webrtcsignal", ttlMs: 1000, keyFields: [], fields: [] });
    s.blobs.push({ id: 90, name: "attachmentblob", metadataFields: [] });
    s.jobs.push({ id: 90, name: "pushnotificationjob", fields: [] });
    s.projections.push({
      id: 90,
      name: "conversationinbox",
      source: "MessageStream",
      fields: [],
      indexes: [],
    });
  }),
);
schemaCase(
  "schema-duplicate-object-field-names",
  "case-insensitive duplicate field names within an object",
  product((s) => {
    obj(s, "User").fields.push({ id: 9, name: "DisplayName", kind: "string", required: false });
  }),
);
schemaCase(
  "schema-duplicate-event-field-names",
  "case-insensitive duplicate field names within an event",
  product((s) => {
    event(s, "MessageSent").fields.push({ id: 9, name: "Body", kind: "string", required: true });
  }),
);
schemaCase(
  "schema-duplicate-field-names-elsewhere-ignored",
  "duplicate field names in presences/signals/blobs/jobs/projections are NOT linted (objects and events only)",
  product((s) => {
    presence(s, "TypingState").fields.push({ id: 9, name: "IsTyping", kind: "bool", required: false });
    signal(s, "WebRTCSignal").fields.push({ id: 9, name: "Payload", kind: "bytes", required: false });
    s.blobs[0]!.metadataFields.push({ id: 9, name: "MimeType", kind: "string", required: false });
    s.jobs[0]!.fields.push({ id: 9, name: "Kind", kind: "string", required: false });
    projection(s, "ConversationInbox").fields.push({ id: 99, name: "Title", kind: "string", required: false });
  }),
);
schemaCase(
  "schema-triplicate-object-name",
  "three case-insensitive occurrences report a single finding with the count",
  product((s) => {
    s.objects.push({ id: 91, name: "user", fields: [], indexes: [] });
    s.objects.push({ id: 92, name: "USER", fields: [], indexes: [] });
  }),
);
schemaCase(
  "schema-everything-wrong",
  "identity + revision + duplicate types + duplicate fields together, pinning overall finding order",
  product((s) => {
    s.schemaId = "";
    s.schemaRevision = 0;
    s.objects.push({ id: 93, name: "Conversation", fields: [], indexes: [] });
    s.events.push({ id: 93, name: "callended", fields: [] });
    obj(s, "User").fields.push({ id: 9, name: "displayname", kind: "string", required: false });
    event(s, "CallEnded").fields.push({ id: 9, name: "EndedAt", kind: "timestamp", required: false });
  }),
);

// ---------------------------------------------------------------------------
// lintSchemaChange — identity / revision rules and deliberate non-rules
// ---------------------------------------------------------------------------

changeCase("change-identical-product", "identical snapshots produce no findings", product(), product());
changeCase(
  "change-identical-foundation",
  "identical empty snapshots produce no findings",
  clone(foundationSchema),
  clone(foundationSchema),
);
changeCase(
  "change-schema-id",
  "schemaId change is breaking",
  product((s) => {
    s.schemaId = "frick-product-test-v2";
  }),
  product(),
);
changeCase(
  "change-revision-decreased",
  "schemaRevision going backwards is breaking",
  product((s) => {
    s.schemaRevision = 2;
  }),
  product((s) => {
    s.schemaRevision = 3;
  }),
);
changeCase(
  "change-revision-increased-plus-untracked-fields",
  "revision bump plus name/schemaVersion/protocolVersion/minimumServerRevision/hash changes produce no findings",
  product((s) => {
    s.name = "frick-product-test-renamed";
    s.schemaVersion = "0.2.0";
    s.schemaRevision = 2;
    s.minimumServerRevision = 2;
    s.protocolVersion = 2;
    s.hash = "frick-product-test-0.3.0";
  }),
  product(),
);
changeCase(
  "change-minimum-client-revision-raised",
  "raising minimumClientRevision is a warn",
  product((s) => {
    s.minimumClientRevision = 2;
  }),
  product(),
);
changeCase(
  "change-minimum-client-revision-lowered",
  "lowering minimumClientRevision produces no findings",
  product((s) => {
    s.minimumClientRevision = 1;
  }),
  product((s) => {
    s.minimumClientRevision = 2;
  }),
);
changeCase(
  "change-hash-only",
  "a hash change without a revision bump produces no findings (the linter has no hash rule)",
  product((s) => {
    s.hash = "frick-product-test-0.2.0-drift";
  }),
  product(),
);
changeCase(
  "change-merge-policy-only",
  "mergePolicy changes are not linted",
  product((s) => {
    obj(s, "MessageDraft").mergePolicy = "lastWriteWins";
    obj(s, "User").mergePolicy = "versionPrecondition";
  }),
  product(),
);
changeCase(
  "change-ttl-only",
  "presence/signal ttlMs changes are not linted",
  product((s) => {
    presence(s, "TypingState").ttlMs = 10000;
    signal(s, "WebRTCSignal").ttlMs = 60000;
  }),
  product(),
);

// ---------------------------------------------------------------------------
// lintSchemaChange — type-set rules for all eight collections
// ---------------------------------------------------------------------------

changeCase(
  "change-object-removed",
  "removing an object is breaking",
  product((s) => {
    s.objects = s.objects.filter((t) => t.name !== "ScheduledMessage");
  }),
  product(),
);
changeCase(
  "change-object-added",
  "adding an object is info",
  product((s) => {
    s.objects.push({
      id: 9,
      name: "Workspace",
      fields: [{ id: 1, name: "title", kind: "string", required: true }],
      indexes: [],
    });
  }),
  product(),
);
changeCase(
  "change-object-renamed",
  "renaming an object at the same id is breaking; unchanged members add nothing",
  product((s) => {
    obj(s, "RoomMember").name = "Member";
  }),
  product(),
);
changeCase(
  "change-object-renamed-case-only",
  "type renames are case-sensitive even though duplicate detection is not",
  product((s) => {
    obj(s, "User").name = "user";
  }),
  product(),
);
changeCase(
  "change-stream-removed",
  "removing a stream is breaking",
  product((s) => {
    s.streams = s.streams.filter((t) => t.name !== "CallEventStream");
  }),
  product(),
);
changeCase(
  "change-stream-added",
  "adding a stream is info",
  product((s) => {
    s.streams.push({
      id: 3,
      name: "AuditStream",
      keyFields: [{ id: 1, name: "tenantId", kind: "string", required: true }],
      events: ["MessageSent"],
    });
  }),
  product(),
);
changeCase(
  "change-stream-renamed",
  "renaming a stream at the same id is breaking",
  product((s) => {
    stream(s, "CallEventStream").name = "CallStream";
  }),
  product(),
);
changeCase(
  "change-event-removed",
  "removing an event is breaking",
  product((s) => {
    s.events = s.events.filter((t) => t.name !== "CallEnded");
    stream(s, "CallEventStream").events = stream(s, "CallEventStream").events.filter(
      (e) => e !== "CallEnded",
    );
  }),
  product(),
);
changeCase(
  "change-event-added",
  "adding an event is info",
  product((s) => {
    s.events.push({
      id: 10,
      name: "MessagePinned",
      fields: [{ id: 1, name: "messageId", kind: "id", required: true }],
    });
  }),
  product(),
);
changeCase(
  "change-event-renamed",
  "renaming an event at the same id is breaking",
  product((s) => {
    event(s, "ReactionAdded").name = "ReactionApplied";
  }),
  product(),
);
changeCase(
  "change-presence-removed-and-added",
  "swapping a presence id surfaces removed + added",
  product((s) => {
    s.presences = [
      { id: 2, name: "OnlineState", ttlMs: 60000, keyFields: [], fields: [] },
    ];
  }),
  product(),
);
changeCase(
  "change-presence-renamed",
  "renaming a presence at the same id is breaking",
  product((s) => {
    presence(s, "TypingState").name = "ComposingState";
  }),
  product(),
);
changeCase(
  "change-signal-removed-and-added",
  "swapping a signal id surfaces removed + added",
  product((s) => {
    s.signals = [{ id: 2, name: "PushSignal", ttlMs: 1000, keyFields: [], fields: [] }];
  }),
  product(),
);
changeCase(
  "change-signal-renamed",
  "renaming a signal at the same id is breaking",
  product((s) => {
    signal(s, "WebRTCSignal").name = "RTCSignal";
  }),
  product(),
);
changeCase(
  "change-blob-removed-and-added",
  "swapping a blob id surfaces removed + added",
  product((s) => {
    s.blobs = [{ id: 2, name: "AvatarBlob", metadataFields: [] }];
  }),
  product(),
);
changeCase(
  "change-blob-renamed",
  "renaming a blob at the same id is breaking",
  product((s) => {
    s.blobs[0]!.name = "UploadBlob";
  }),
  product(),
);
changeCase(
  "change-job-removed-and-added",
  "swapping a job id surfaces removed + added",
  product((s) => {
    s.jobs = [{ id: 2, name: "DigestJob", fields: [] }];
  }),
  product(),
);
changeCase(
  "change-job-renamed",
  "renaming a job at the same id is breaking",
  product((s) => {
    s.jobs[0]!.name = "NotifyJob";
  }),
  product(),
);
changeCase(
  "change-projection-removed-and-added",
  "swapping a projection id surfaces removed + added",
  product((s) => {
    s.projections = [
      { id: 2, name: "CallSummary", source: "CallEventStream", fields: [], indexes: [] },
    ];
  }),
  product(),
);
changeCase(
  "change-projection-renamed",
  "renaming a projection at the same id is breaking",
  product((s) => {
    projection(s, "ConversationInbox").name = "Inbox";
  }),
  product(),
);
changeCase(
  "change-object-id-reused",
  "a removed-and-readded id surfaces as rename + member diffs, not remove + add",
  product((s) => {
    s.objects = s.objects.map((t) =>
      t.id === 1
        ? {
            id: 1,
            name: "Account",
            fields: [{ id: 1, name: "accountName", kind: "string", required: true }],
            indexes: [],
          }
        : t,
    );
  }),
  product(),
);

// ---------------------------------------------------------------------------
// lintSchemaChange — field rules
// ---------------------------------------------------------------------------

changeCase(
  "change-field-removed",
  "removing a field is breaking",
  product((s) => {
    obj(s, "User").fields = obj(s, "User").fields.filter((f) => f.name !== "avatarBlobId");
  }),
  product(),
);
changeCase(
  "change-field-added-required",
  "adding a required field is breaking",
  product((s) => {
    obj(s, "User").fields.push({ id: 3, name: "handle", kind: "string", required: true });
  }),
  product(),
);
changeCase(
  "change-field-added-optional",
  "adding an optional field is info",
  product((s) => {
    obj(s, "User").fields.push({ id: 3, name: "bio", kind: "string", required: false });
  }),
  product(),
);
changeCase(
  "change-field-renamed",
  "renaming a field at the same id is breaking",
  product((s) => {
    fieldOf(obj(s, "User").fields, "displayName").name = "fullName";
  }),
  product(),
);
changeCase(
  "change-field-kind-changed",
  "changing a field kind is breaking",
  product((s) => {
    fieldOf(obj(s, "Conversation").fields, "title").kind = "json";
  }),
  product(),
);
changeCase(
  "change-field-required-toggled",
  "flipping required false→true is breaking under field.required.toggled",
  product((s) => {
    fieldOf(obj(s, "Conversation").fields, "title").required = true;
  }),
  product(),
);
changeCase(
  "change-field-optional-toggled",
  "flipping required true→false is breaking under field.optional.toggled",
  product((s) => {
    fieldOf(obj(s, "User").fields, "displayName").required = false;
  }),
  product(),
);
changeCase(
  "change-field-ref-changed",
  "retargeting a ref is breaking",
  product((s) => {
    fieldOf(obj(s, "Conversation").fields, "createdBy").ref = "RoomMember";
  }),
  product(),
);
changeCase(
  "change-field-ref-added-from-none",
  "gaining a ref target reports <none> as the previous value",
  product((s) => {
    fieldOf(obj(s, "User").fields, "displayName").ref = "User";
  }),
  product(),
);
changeCase(
  "change-field-ref-removed-to-none",
  "losing a ref target reports <none> as the new value",
  product((s) => {
    delete fieldOf(obj(s, "User").fields, "avatarBlobId").ref;
  }),
  product(),
);
changeCase(
  "change-field-ref-empty-string-equals-none",
  "ref \"\" and absent ref compare equal (the ?? \"\" normalization) — no findings",
  product((s) => {
    fieldOf(obj(s, "User").fields, "displayName").ref = "";
  }),
  product(),
);
changeCase(
  "change-field-many-rules-at-once",
  "one field tripping rename + kind + required + ref rules pins per-field rule order",
  product((s) => {
    const field = fieldOf(obj(s, "User").fields, "avatarBlobId");
    field.name = "pictureId";
    field.kind = "string";
    field.required = true;
    field.ref = "User";
  }),
  product(),
);

// ---------------------------------------------------------------------------
// lintSchemaChange — enum rules
// ---------------------------------------------------------------------------

changeCase(
  "change-enum-value-removed",
  "removing an enum value is breaking",
  product((s) => {
    fieldOf(obj(s, "Conversation").fields, "kind").enumValues = ["dm", "group"];
  }),
  product(),
);
changeCase(
  "change-enum-value-added-trailing",
  "appending an enum value is a warn",
  product((s) => {
    fieldOf(obj(s, "Conversation").fields, "kind").enumValues = ["dm", "group", "channel", "broadcast"];
  }),
  product(),
);
changeCase(
  "change-enum-value-inserted",
  "inserting an enum value mid-list is breaking (ordinal encodings shift)",
  product((s) => {
    fieldOf(obj(s, "Conversation").fields, "kind").enumValues = ["broadcast", "dm", "group", "channel"];
  }),
  product(),
);
changeCase(
  "change-enum-prev-tail-cursor",
  "values after an appended value are also trailing (the prevTail cursor)",
  product((s) => {
    fieldOf(obj(s, "Conversation").fields, "kind").enumValues = [
      "x",
      "dm",
      "group",
      "channel",
      "y",
      "z",
    ];
  }),
  product(),
);
changeCase(
  "change-enum-replaced-wholesale",
  "replacing the whole value list yields removals plus insertions",
  product((s) => {
    fieldOf(obj(s, "Conversation").fields, "kind").enumValues = ["a", "b"];
  }),
  product(),
);
changeCase(
  "change-enum-to-string-kind",
  "kind change away from enum reports field.kind.changed only — the enum diff needs both sides enum",
  product((s) => {
    const field = fieldOf(obj(s, "Conversation").fields, "kind");
    field.kind = "string";
    delete field.enumValues;
  }),
  product(),
);
changeCase(
  "change-enum-values-absent-previous",
  "missing enumValues coerce to [] — everything current is trailing from index 0",
  product((s) => {
    obj(s, "User").fields.push({
      id: 3,
      name: "tier",
      kind: "enum",
      enumValues: ["free", "pro"],
      required: false,
    });
  }),
  product((s) => {
    obj(s, "User").fields.push({ id: 3, name: "tier", kind: "enum", required: false });
  }),
);

// ---------------------------------------------------------------------------
// lintSchemaChange — index rules (removal only, by id)
// ---------------------------------------------------------------------------

changeCase(
  "change-index-removed",
  "removing an index is breaking",
  product((s) => {
    obj(s, "User").indexes = [];
  }),
  product(),
);
changeCase(
  "change-index-added",
  "adding an index produces no findings",
  product((s) => {
    obj(s, "User").indexes.push({ id: 2, name: "byAvatar", fields: ["avatarBlobId"] });
  }),
  product(),
);
changeCase(
  "change-index-fields-changed",
  "changing an index field list produces no findings",
  product((s) => {
    obj(s, "CallRoom").indexes[0]!.fields = ["state"];
  }),
  product(),
);
changeCase(
  "change-index-renamed",
  "renaming an index at the same id produces no findings (diffIndexes only checks removal)",
  product((s) => {
    obj(s, "User").indexes[0]!.name = "everyone";
  }),
  product(),
);

// ---------------------------------------------------------------------------
// lintSchemaChange — stream rules
// ---------------------------------------------------------------------------

changeCase(
  "change-stream-key-field-changed",
  "stream key fields diff under streams[name].key",
  product((s) => {
    const key = fieldOf(stream(s, "MessageStream").keyFields, "conversationId");
    key.kind = "string";
    delete key.ref;
  }),
  product(),
);
changeCase(
  "change-stream-event-removed",
  "a stream dropping an event name is breaking",
  product((s) => {
    stream(s, "MessageStream").events = stream(s, "MessageStream").events.filter(
      (e) => e !== "ReactionAdded",
    );
  }),
  product(),
);
changeCase(
  "change-stream-event-added",
  "a stream gaining an event name is info (plus the event.added typeset finding)",
  product((s) => {
    s.events.push({
      id: 10,
      name: "MessagePinned",
      fields: [{ id: 1, name: "messageId", kind: "id", required: true }],
    });
    stream(s, "MessageStream").events.push("MessagePinned");
  }),
  product(),
);
changeCase(
  "change-stream-events-reordered",
  "reordering stream event names produces no findings (set comparison)",
  product((s) => {
    stream(s, "MessageStream").events = [...stream(s, "MessageStream").events].reverse();
  }),
  product(),
);

// ---------------------------------------------------------------------------
// lintSchemaChange — presence/signal/blob/job/projection member diffs
// ---------------------------------------------------------------------------

changeCase(
  "change-presence-members",
  "presence keyFields diff under .key and fields under the bare path",
  product((s) => {
    const typing = presence(s, "TypingState");
    typing.keyFields = typing.keyFields.filter((f) => f.name !== "deviceId");
    typing.fields.push({ id: 2, name: "since", kind: "timestamp", required: false });
  }),
  product(),
);
changeCase(
  "change-signal-members",
  "signal keyFields diff under .key and fields under the bare path",
  product((s) => {
    const rtc = signal(s, "WebRTCSignal");
    fieldOf(rtc.keyFields, "callId").name = "roomId";
    fieldOf(rtc.fields, "kind").enumValues = [
      "offer",
      "answer",
      "ice",
      "renegotiate",
      "sfuToken",
      "keyEpoch",
    ];
  }),
  product(),
);
changeCase(
  "change-blob-metadata-members",
  "blob metadata fields diff under blobs[name].metadata",
  product((s) => {
    const blob = s.blobs[0]!;
    blob.metadataFields = blob.metadataFields.filter((f) => f.name !== "mimeType");
    blob.metadataFields.push({ id: 4, name: "width", kind: "int", required: true });
  }),
  product(),
);
changeCase(
  "change-job-members",
  "job fields diff under jobs[name]",
  product((s) => {
    fieldOf(s.jobs[0]!.fields, "payload").name = "body";
  }),
  product(),
);
changeCase(
  "change-projection-source",
  "a projection changing source is breaking",
  product((s) => {
    projection(s, "ConversationInbox").source = "CallEventStream";
  }),
  product(),
);
changeCase(
  "change-projection-members",
  "projection fields and indexes diff after the source check",
  product((s) => {
    const inbox = projection(s, "ConversationInbox");
    inbox.fields = inbox.fields.filter((f) => f.name !== "lastMessageBody");
    inbox.indexes = inbox.indexes.filter((x) => x.name !== "byUser");
  }),
  product(),
);

// ---------------------------------------------------------------------------
// lintSchemaChange — edge cases and ordering pins
// ---------------------------------------------------------------------------

changeCase(
  "change-duplicate-field-ids-last-wins",
  "duplicate field ids resolve like JS Maps: the last previous entry wins the pair diff",
  product((s) => {
    obj(s, "User").fields = [
      { id: 1, name: "b", kind: "int", required: true },
      { id: 2, name: "avatarBlobId", kind: "ref", ref: "AttachmentBlob", required: false },
    ];
  }),
  product((s) => {
    obj(s, "User").fields = [
      { id: 1, name: "a", kind: "string", required: true },
      { id: 1, name: "b", kind: "int", required: true },
      { id: 2, name: "avatarBlobId", kind: "ref", ref: "AttachmentBlob", required: false },
    ];
  }),
);
changeCase(
  "change-everything-removed",
  "foundation (different schemaId) replacing the product schema removes every type",
  clone(foundationSchema),
  product(),
);
changeCase(
  "change-everything-added",
  "the product schema replacing foundation adds every type",
  product(),
  clone(foundationSchema),
);
changeCase(
  "change-kitchen-sink",
  "many rules at once, pinning the global finding order across all diff phases",
  product((s) => {
    s.schemaRevision = 2;
    s.minimumClientRevision = 2;
    s.objects = s.objects.filter((t) => t.name !== "ScheduledMessage");
    s.objects.push({
      id: 9,
      name: "Workspace",
      fields: [{ id: 1, name: "title", kind: "string", required: true }],
      indexes: [],
    });
    obj(s, "RoomMember").name = "Member";
    const user = obj(s, "User");
    user.fields = user.fields.filter((f) => f.name !== "avatarBlobId");
    user.fields.push({ id: 3, name: "bio", kind: "string", required: false });
    user.indexes = [];
    const conversation = obj(s, "Conversation");
    fieldOf(conversation.fields, "title").kind = "json";
    fieldOf(conversation.fields, "lastMessageEventId").required = true;
    fieldOf(conversation.fields, "createdBy").ref = "Member";
    fieldOf(conversation.fields, "kind").enumValues = ["dm", "group", "broadcast"];
    s.events.push({
      id: 10,
      name: "MessagePinned",
      fields: [{ id: 1, name: "messageId", kind: "id", required: true }],
    });
    const messages = stream(s, "MessageStream");
    fieldOf(messages.keyFields, "conversationId").name = "roomId";
    messages.events = [
      ...messages.events.filter((e) => e !== "ReceiptAdvanced"),
      "MessagePinned",
    ];
    const typing = presence(s, "TypingState");
    typing.ttlMs = 10000;
    fieldOf(typing.fields, "isTyping").required = false;
    fieldOf(signal(s, "WebRTCSignal").fields, "kind").enumValues = [
      "preOffer",
      "offer",
      "answer",
      "ice",
      "renegotiate",
      "sfuToken",
    ];
    const blob = s.blobs[0]!;
    blob.metadataFields = blob.metadataFields.filter((f) => f.name !== "mimeType");
    s.jobs[0]!.fields.push({ id: 4, name: "priority", kind: "int", required: true });
    const inbox = projection(s, "ConversationInbox");
    inbox.source = "CallEventStream";
    inbox.fields = inbox.fields.filter((f) => f.name !== "lastMessageSenderId");
    inbox.indexes = inbox.indexes.filter((x) => x.name !== "byUser");
  }),
  product((s) => {
    s.schemaRevision = 3;
  }),
);

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const names = new Set<string>();
for (const entry of cases) {
  if (names.has(entry.name)) {
    throw new Error(`duplicate case name: ${entry.name}`);
  }
  names.add(entry.name);
}

const manifest = cases.map((entry) => {
  const expected: FrickLintResult =
    entry.mode === "schema"
      ? lintSchema(entry.current)
      : lintSchemaChange(entry.current, must(entry.previous, `${entry.name} previous`));
  return {
    name: entry.name,
    description: entry.description,
    mode: entry.mode,
    current: entry.current,
    ...(entry.previous === undefined ? {} : { previous: entry.previous }),
    expected,
  };
});

const triggered = new Set(
  manifest.flatMap((entry) => entry.expected.findings.map((f) => f.ruleId)),
);
const untriggered = ALL_RULE_IDS.filter((ruleId) => !triggered.has(ruleId));
if (untriggered.length > 0) {
  throw new Error(`rules never triggered by any case: ${untriggered.join(", ")}`);
}
const unknown = [...triggered].filter((ruleId) => !ALL_RULE_IDS.includes(ruleId));
if (unknown.length > 0) {
  throw new Error(`cases triggered unknown rules: ${unknown.join(", ")}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify({ cases: manifest }, null, 2)}\n`);

console.log(
  `wrote ${manifest.length} lint fixtures (${ALL_RULE_IDS.length} rules covered) to ${outDir}`,
);
