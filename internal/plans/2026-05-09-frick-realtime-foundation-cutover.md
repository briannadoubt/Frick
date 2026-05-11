# Frick Realtime Foundation Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype Task/Project data fabric with the greenfield Frick realtime foundation needed to support FrickenChat-class apps later.

**Architecture:** Cut over to a canonical schema model with objects, streams, events, presence, signals, blobs, jobs, and projections. The TypeScript protocol package defines the schema vocabulary, compact binary codecs, and frame protocol; the server persists durable state in SQLite using production-shaped tables; web, Swift, and Kotlin clients consume generated DTOs and local SQL-backed caches through idiomatic bindings. Thin demo/conformance apps prove the foundation across browser, iOS simulator, and Android emulator without becoming the FrickenChat product.

**Tech Stack:** pnpm workspaces, TypeScript 5.9, Vitest, Node `node:sqlite`, MessagePack, WebSocket, React/Vite, Swift Package Manager, SwiftUI, SQLite3, Kotlin, Android Compose, Android SQLite, XcodeGen, Tilt.

---

## Scope And Cutover Rules

- This is a greenfield cutover. Do not preserve compatibility with the current Task/Project demo schema, current frame names, current local SQLite rows, or current generated Swift/Kotlin artifacts.
- It is acceptable to reset local server/client databases while implementing this plan.
- Keep the current monorepo structure. Do not create a second framework beside the existing packages.
- Build foundation primitives first, then thin conformance surfaces.
- Treat chat and calls as validation domains for the framework, not as product implementation.
- Keep media bytes out of Frick sync. Frick owns call state and WebRTC/SFU signaling only.

## File Structure

Create or reshape the repository around these boundaries:

- `packages/protocol/src/schema.ts`: canonical schema AST and validators.
- `packages/protocol/src/codec.ts`: object/event/presence/signal/blob/job packing and unpacking.
- `packages/protocol/src/frame.ts`: canonical realtime frame definitions and MessagePack encoding.
- `packages/protocol/src/foundation.ts`: canonical Frick foundation schema fixture used by tests and demos.
- `packages/protocol/src/artifacts.ts`: generated artifact model shared by Swift/Kotlin generators.
- `packages/protocol/scripts/generate-native-artifacts.ts`: Swift and Kotlin DTO generation.
- `packages/protocol/tests/schema.test.ts`: schema validation, hash, and type lookup tests.
- `packages/protocol/tests/codec.test.ts`: binary packing and unpacking tests.
- `packages/protocol/tests/frame.test.ts`: frame round-trip and schema mismatch tests.
- `apps/server/src/storage/schema.ts`: SQLite DDL and database setup.
- `apps/server/src/storage/object-store.ts`: durable object snapshot storage.
- `apps/server/src/storage/stream-store.ts`: append-only stream/event storage.
- `apps/server/src/storage/presence-store.ts`: TTL presence leases.
- `apps/server/src/storage/blob-store.ts`: blob metadata and upload session metadata.
- `apps/server/src/storage/job-store.ts`: durable job queue.
- `apps/server/src/sync/gateway.ts`: WebSocket connection lifecycle and subscriptions.
- `apps/server/src/sync/subscriptions.ts`: subscription registry and fanout matching.
- `apps/server/src/sync/signal-router.ts`: authorized ephemeral signal routing.
- `apps/server/src/authz.ts`: local development authorization checks.
- `apps/server/src/store.ts`: small composition facade over storage modules.
- `apps/server/src/server.ts`: HTTP routes and WebSocket server wiring.
- `packages/core/src/cache.ts`: portable local cache interface and in-memory implementation.
- `packages/core/src/runtime.ts`: foundation sync runtime.
- `packages/core/src/subscriptions.ts`: object, stream, presence, and signal subscription helpers.
- `packages/react/src/index.tsx`: React provider and hooks for foundation primitives.
- `packages/swift/Sources/FrickSwift/FrickClient.swift`: Swift transport, SQL cache, and typed APIs.
- `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift`: generated Swift DTOs.
- `apps/android/frick/src/main/java/dev/frick/client/FrickClient.kt`: Kotlin transport, SQL cache, and typed APIs.
- `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt`: generated Kotlin DTOs.
- `apps/web/src/App.tsx`: thin web conformance harness.
- `apps/ios/FrickDemo/ContentView.swift`: thin SwiftUI conformance harness.
- `apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt`: thin Compose conformance harness.

---

### Task 1: Canonical Schema Vocabulary

**Files:**
- Modify: `packages/protocol/src/schema.ts`
- Create: `packages/protocol/src/foundation.ts`
- Create: `packages/protocol/tests/schema.test.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing schema tests**

Create `packages/protocol/tests/schema.test.ts` with tests that assert the canonical foundation schema supports every primitive.

```ts
import { describe, expect, it } from "vitest";
import {
  foundationSchema,
  objectByName,
  streamByName,
  eventByName,
  presenceByName,
  signalByName,
  blobByName,
  jobByName,
  projectionByName,
  validateSchema,
} from "../src/index.js";

describe("foundation schema", () => {
  it("defines all realtime foundation primitives", () => {
    const schema = validateSchema(foundationSchema);

    expect(objectByName(schema, "User").id).toBe(1);
    expect(objectByName(schema, "Conversation").id).toBe(2);
    expect(streamByName(schema, "MessageStream").id).toBe(1);
    expect(eventByName(schema, "MessageSent").id).toBe(1);
    expect(presenceByName(schema, "TypingState").id).toBe(1);
    expect(signalByName(schema, "WebRTCSignal").id).toBe(1);
    expect(blobByName(schema, "AttachmentBlob").id).toBe(1);
    expect(jobByName(schema, "PushNotificationJob").id).toBe(1);
    expect(projectionByName(schema, "ConversationInbox").id).toBe(1);
  });

  it("has a stable canonical schema hash", () => {
    const schema = validateSchema(foundationSchema);

    expect(schema.hash).toMatch(/^frick-foundation-/);
    expect(schema.protocol).toBe("frick.realtime");
    expect(schema.compatibility).toBe("greenfield-cutover");
  });

  it("rejects duplicate field ids within a type", () => {
    const invalid = structuredClone(foundationSchema);
    invalid.objects[0]!.fields.push({
      id: 1,
      name: "duplicateDisplayName",
      kind: "string",
      required: false,
    });

    expect(() => validateSchema(invalid)).toThrow(/duplicate field id/i);
  });
});
```

- [ ] **Step 2: Run the failing schema tests**

Run:

```bash
pnpm vitest run packages/protocol/tests/schema.test.ts
```

Expected: fail because `foundationSchema`, primitive lookup helpers, and `validateSchema` do not yet exist with the new shape.

- [ ] **Step 3: Replace the schema model**

In `packages/protocol/src/schema.ts`, replace the current entity/mutation-only model with the canonical model:

```ts
export type FieldKind =
  | "id"
  | "ref"
  | "string"
  | "bool"
  | "timestamp"
  | "int"
  | "bytes"
  | "enum"
  | "json";

export interface FieldDef {
  id: number;
  name: string;
  kind: FieldKind;
  required: boolean;
  ref?: string;
  enumValues?: string[];
}

export interface ObjectDef {
  id: number;
  name: string;
  fields: FieldDef[];
  indexes: IndexDef[];
}

export interface StreamDef {
  id: number;
  name: string;
  keyFields: FieldDef[];
  events: string[];
}

export interface EventDef {
  id: number;
  name: string;
  fields: FieldDef[];
}

export interface PresenceDef {
  id: number;
  name: string;
  keyFields: FieldDef[];
  fields: FieldDef[];
  ttlMs: number;
}

export interface SignalDef {
  id: number;
  name: string;
  keyFields: FieldDef[];
  fields: FieldDef[];
  ttlMs: number;
}

export interface BlobDef {
  id: number;
  name: string;
  metadataFields: FieldDef[];
}

export interface JobDef {
  id: number;
  name: string;
  fields: FieldDef[];
}

export interface ProjectionDef {
  id: number;
  name: string;
  source: string;
  fields: FieldDef[];
  indexes: IndexDef[];
}

export interface IndexDef {
  id: number;
  name: string;
  fields: string[];
}

export interface FrickSchema {
  name: string;
  protocol: "frick.realtime";
  protocolVersion: number;
  compatibility: "greenfield-cutover";
  hash: string;
  objects: ObjectDef[];
  streams: StreamDef[];
  events: EventDef[];
  presences: PresenceDef[];
  signals: SignalDef[];
  blobs: BlobDef[];
  jobs: JobDef[];
  projections: ProjectionDef[];
}

export type PlainObject = Record<string, unknown>;
export type PackedField = [fieldId: number, value: unknown];
export type PackedRecord = [typeId: number, recordId: string, fields: PackedField[]];
```

Also add lookup helpers for each primitive and `validateSchema(schema: FrickSchema): FrickSchema`. The validator must reject duplicate type ids, duplicate type names, duplicate field ids, duplicate field names, unknown stream event references, and unknown projection sources.

- [ ] **Step 4: Define the canonical foundation schema**

Create `packages/protocol/src/foundation.ts` with a schema fixture containing these minimum types:

```ts
import type { FrickSchema } from "./schema.js";

export const foundationSchema: FrickSchema = {
  name: "frick-foundation",
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "frick-foundation-2026-05-09",
  objects: [
    {
      id: 1,
      name: "User",
      fields: [
        { id: 1, name: "displayName", kind: "string", required: true },
        { id: 2, name: "avatarBlobId", kind: "ref", ref: "AttachmentBlob", required: false },
      ],
      indexes: [{ id: 1, name: "all", fields: ["displayName"] }],
    },
    {
      id: 2,
      name: "Conversation",
      fields: [
        { id: 1, name: "kind", kind: "enum", enumValues: ["dm", "group", "channel"], required: true },
        { id: 2, name: "title", kind: "string", required: false },
        { id: 3, name: "createdBy", kind: "ref", ref: "User", required: true },
        { id: 4, name: "lastMessageEventId", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "all", fields: ["kind"] }],
    },
    {
      id: 3,
      name: "RoomMember",
      fields: [
        { id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 2, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 3, name: "role", kind: "enum", enumValues: ["owner", "member"], required: true },
      ],
      indexes: [{ id: 1, name: "byConversation", fields: ["conversationId"] }],
    },
    {
      id: 4,
      name: "CallRoom",
      fields: [
        { id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 2, name: "state", kind: "enum", enumValues: ["ringing", "active", "ended"], required: true },
        { id: 3, name: "createdBy", kind: "ref", ref: "User", required: true },
      ],
      indexes: [{ id: 1, name: "byConversation", fields: ["conversationId", "state"] }],
    },
  ],
  streams: [
    {
      id: 1,
      name: "MessageStream",
      keyFields: [{ id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true }],
      events: ["MessageSent", "MessageEdited", "MessageRedacted", "ReactionAdded", "ReceiptAdvanced"],
    },
    {
      id: 2,
      name: "CallEventStream",
      keyFields: [{ id: 1, name: "callId", kind: "ref", ref: "CallRoom", required: true }],
      events: ["CallCreated", "CallParticipantJoined", "CallParticipantLeft", "CallEnded"],
    },
  ],
  events: [
    { id: 1, name: "MessageSent", fields: [
      { id: 1, name: "messageId", kind: "id", required: true },
      { id: 2, name: "senderId", kind: "ref", ref: "User", required: true },
      { id: 3, name: "body", kind: "string", required: true },
      { id: 4, name: "createdAt", kind: "timestamp", required: true },
    ] },
    { id: 2, name: "MessageEdited", fields: [
      { id: 1, name: "messageId", kind: "id", required: true },
      { id: 2, name: "body", kind: "string", required: true },
      { id: 3, name: "editedAt", kind: "timestamp", required: true },
    ] },
    { id: 3, name: "MessageRedacted", fields: [
      { id: 1, name: "messageId", kind: "id", required: true },
      { id: 2, name: "redactedAt", kind: "timestamp", required: true },
    ] },
    { id: 4, name: "ReactionAdded", fields: [
      { id: 1, name: "messageId", kind: "id", required: true },
      { id: 2, name: "userId", kind: "ref", ref: "User", required: true },
      { id: 3, name: "emoji", kind: "string", required: true },
    ] },
    { id: 5, name: "ReceiptAdvanced", fields: [
      { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
      { id: 2, name: "sequence", kind: "int", required: true },
    ] },
    { id: 6, name: "CallCreated", fields: [
      { id: 1, name: "callId", kind: "ref", ref: "CallRoom", required: true },
      { id: 2, name: "createdBy", kind: "ref", ref: "User", required: true },
    ] },
    { id: 7, name: "CallParticipantJoined", fields: [
      { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
      { id: 2, name: "deviceId", kind: "string", required: true },
    ] },
    { id: 8, name: "CallParticipantLeft", fields: [
      { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
      { id: 2, name: "deviceId", kind: "string", required: true },
    ] },
    { id: 9, name: "CallEnded", fields: [
      { id: 1, name: "endedAt", kind: "timestamp", required: true },
    ] },
  ],
  presences: [
    {
      id: 1,
      name: "TypingState",
      ttlMs: 5000,
      keyFields: [
        { id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 2, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
      ],
      fields: [{ id: 1, name: "isTyping", kind: "bool", required: true }],
    },
  ],
  signals: [
    {
      id: 1,
      name: "WebRTCSignal",
      ttlMs: 30000,
      keyFields: [{ id: 1, name: "callId", kind: "ref", ref: "CallRoom", required: true }],
      fields: [
        { id: 1, name: "senderDeviceId", kind: "string", required: true },
        { id: 2, name: "recipientDeviceId", kind: "string", required: false },
        { id: 3, name: "kind", kind: "enum", enumValues: ["offer", "answer", "ice", "renegotiate", "sfuToken"], required: true },
        { id: 4, name: "payload", kind: "bytes", required: true },
      ],
    },
  ],
  blobs: [
    {
      id: 1,
      name: "AttachmentBlob",
      metadataFields: [
        { id: 1, name: "contentHash", kind: "string", required: true },
        { id: 2, name: "byteLength", kind: "int", required: true },
        { id: 3, name: "mimeType", kind: "string", required: true },
      ],
    },
  ],
  jobs: [
    {
      id: 1,
      name: "PushNotificationJob",
      fields: [
        { id: 1, name: "recipientUserId", kind: "ref", ref: "User", required: true },
        { id: 2, name: "kind", kind: "string", required: true },
        { id: 3, name: "payload", kind: "json", required: true },
      ],
    },
  ],
  projections: [
    {
      id: 1,
      name: "ConversationInbox",
      source: "MessageStream",
      fields: [
        { id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 2, name: "lastSequence", kind: "int", required: true },
        { id: 3, name: "unreadCount", kind: "int", required: true },
      ],
      indexes: [{ id: 1, name: "byConversation", fields: ["conversationId"] }],
    },
  ],
};
```

- [ ] **Step 5: Export the new schema API**

Update `packages/protocol/src/index.ts` to export `schema.ts` and `foundation.ts`. Remove exports for Task/Project sample fixtures after downstream code is converted.

- [ ] **Step 6: Run schema tests**

Run:

```bash
pnpm vitest run packages/protocol/tests/schema.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/schema.ts packages/protocol/src/foundation.ts packages/protocol/src/index.ts packages/protocol/tests/schema.test.ts
git commit -m "feat(protocol): define canonical realtime foundation schema"
```

---

### Task 2: Compact Codec Cutover

**Files:**
- Create: `packages/protocol/src/codec.ts`
- Create: `packages/protocol/tests/codec.test.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing codec tests**

Create `packages/protocol/tests/codec.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import {
  foundationSchema,
  packObjectRecord,
  unpackObjectRecord,
  packStreamEvent,
  unpackStreamEvent,
  packPresenceRecord,
  unpackPresenceRecord,
  packSignalEnvelope,
  unpackSignalEnvelope,
} from "../src/index.js";

describe("foundation codecs", () => {
  it("packs and unpacks object records by stable field id", () => {
    const packed = packObjectRecord(foundationSchema, "User", "user-1", {
      displayName: "Ada",
      avatarBlobId: "blob-1",
    });

    expect(packed).toEqual([1, "user-1", [[1, "Ada"], [2, "blob-1"]]]);
    expect(unpackObjectRecord(foundationSchema, packed)).toEqual({
      type: "User",
      id: "user-1",
      value: { id: "user-1", displayName: "Ada", avatarBlobId: "blob-1" },
    });
  });

  it("packs stream events with stream key and event payload", () => {
    const packed = packStreamEvent(foundationSchema, {
      stream: "MessageStream",
      streamId: "conversation-1",
      sequence: 7,
      eventId: "event-7",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-1",
        body: "hello",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });

    expect(packed[0]).toBe(1);
    expect(packed[2]).toBe(7);
    expect(unpackStreamEvent(foundationSchema, packed).event).toBe("MessageSent");
  });

  it("packs presence and signal records", () => {
    const presence = packPresenceRecord(foundationSchema, "TypingState", "conversation-1:user-1:device-1", {
      isTyping: true,
    });
    const signal = packSignalEnvelope(foundationSchema, "WebRTCSignal", "call-1", {
      senderDeviceId: "device-1",
      kind: "offer",
      payload: new Uint8Array([1, 2, 3]),
    });

    expect(unpackPresenceRecord(foundationSchema, presence).value.isTyping).toBe(true);
    expect(unpackSignalEnvelope(foundationSchema, signal).value.kind).toBe("offer");
  });
});
```

- [ ] **Step 2: Run the failing codec tests**

Run:

```bash
pnpm vitest run packages/protocol/tests/codec.test.ts
```

Expected: fail because `codec.ts` and its exports do not exist.

- [ ] **Step 3: Implement record and event codecs**

Create `packages/protocol/src/codec.ts` with:

```ts
import {
  eventByName,
  fieldById,
  fieldByName,
  objectById,
  objectByName,
  presenceByName,
  signalByName,
  streamByName,
  type FrickSchema,
  type PackedField,
  type PackedRecord,
  type PlainObject,
} from "./schema.js";

export type PackedStreamEvent = [
  streamIdNumber: number,
  streamKey: string,
  sequence: number,
  eventId: string,
  eventTypeId: number,
  fields: PackedField[],
];

export type PackedPresenceRecord = [presenceTypeId: number, presenceKey: string, fields: PackedField[]];
export type PackedSignalEnvelope = [signalTypeId: number, signalKey: string, fields: PackedField[]];

export interface StreamEventInput {
  stream: string;
  streamId: string;
  sequence: number;
  eventId: string;
  event: string;
  payload: PlainObject;
}

export function packObjectRecord(
  schema: FrickSchema,
  objectName: string,
  objectId: string,
  value: PlainObject,
): PackedRecord {
  const object = objectByName(schema, objectName);
  return [object.id, objectId, packFields(object.fields, value)];
}

export function unpackObjectRecord(schema: FrickSchema, packed: PackedRecord) {
  const object = objectById(schema, packed[0]);
  return {
    type: object.name,
    id: packed[1],
    value: { id: packed[1], ...unpackFields(object.fields, packed[2]) },
  };
}

export function packStreamEvent(schema: FrickSchema, input: StreamEventInput): PackedStreamEvent {
  const stream = streamByName(schema, input.stream);
  const event = eventByName(schema, input.event);
  return [
    stream.id,
    input.streamId,
    input.sequence,
    input.eventId,
    event.id,
    packFields(event.fields, input.payload),
  ];
}

export function unpackStreamEvent(schema: FrickSchema, packed: PackedStreamEvent) {
  const stream = schema.streams.find((candidate) => candidate.id === packed[0]);
  const event = schema.events.find((candidate) => candidate.id === packed[4]);
  if (!stream || !event) {
    throw new Error("Unknown packed stream event type");
  }
  return {
    stream: stream.name,
    streamId: packed[1],
    sequence: packed[2],
    eventId: packed[3],
    event: event.name,
    payload: unpackFields(event.fields, packed[5]),
  };
}

export function packPresenceRecord(
  schema: FrickSchema,
  presenceName: string,
  presenceKey: string,
  value: PlainObject,
): PackedPresenceRecord {
  const presence = presenceByName(schema, presenceName);
  return [presence.id, presenceKey, packFields(presence.fields, value)];
}

export function unpackPresenceRecord(schema: FrickSchema, packed: PackedPresenceRecord) {
  const presence = schema.presences.find((candidate) => candidate.id === packed[0]);
  if (!presence) {
    throw new Error("Unknown packed presence type");
  }
  return { type: presence.name, key: packed[1], value: unpackFields(presence.fields, packed[2]) };
}

export function packSignalEnvelope(
  schema: FrickSchema,
  signalName: string,
  signalKey: string,
  value: PlainObject,
): PackedSignalEnvelope {
  const signal = signalByName(schema, signalName);
  return [signal.id, signalKey, packFields(signal.fields, value)];
}

export function unpackSignalEnvelope(schema: FrickSchema, packed: PackedSignalEnvelope) {
  const signal = schema.signals.find((candidate) => candidate.id === packed[0]);
  if (!signal) {
    throw new Error("Unknown packed signal type");
  }
  return { type: signal.name, key: packed[1], value: unpackFields(signal.fields, packed[2]) };
}

function packFields(fields: { id: number; name: string }[], value: PlainObject): PackedField[] {
  return Object.entries(value).map(([fieldName, fieldValue]) => {
    const field = fieldByName(fields, fieldName);
    return [field.id, fieldValue];
  });
}

function unpackFields(fields: { id: number; name: string }[], packed: PackedField[]): PlainObject {
  const value: PlainObject = {};
  for (const [fieldId, fieldValue] of packed) {
    const field = fieldById(fields, fieldId);
    value[field.name] = fieldValue;
  }
  return value;
}
```

Adjust helper signatures in `schema.ts` so `fieldByName` and `fieldById` operate on field arrays.

- [ ] **Step 4: Export codecs**

Update `packages/protocol/src/index.ts`:

```ts
export * from "./schema.js";
export * from "./foundation.js";
export * from "./codec.js";
```

- [ ] **Step 5: Run codec and schema tests**

Run:

```bash
pnpm vitest run packages/protocol/tests/schema.test.ts packages/protocol/tests/codec.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/schema.ts packages/protocol/src/codec.ts packages/protocol/src/index.ts packages/protocol/tests/codec.test.ts
git commit -m "feat(protocol): add compact foundation codecs"
```

---

### Task 3: Canonical Transport Frames

**Files:**
- Modify: `packages/protocol/src/frame.ts`
- Create: `packages/protocol/tests/frame.test.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing frame tests**

Create `packages/protocol/tests/frame.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  rejectSchemaMismatch,
  type FrickFrame,
} from "../src/index.js";

describe("foundation frames", () => {
  it("round-trips hello, subscribe, append, presence, signal, and cursor frames", () => {
    const frames: FrickFrame[] = [
      [FrameKind.Hello, { replicaId: "replica-1", deviceId: "device-1", schemaHash: foundationSchema.hash, knownCursors: {} }],
      [FrameKind.Subscribe, { subscriptionId: "sub-1", kind: "stream", name: "MessageStream", key: "conversation-1", cursor: 0 }],
      [FrameKind.Append, { requestId: "request-1", stream: "MessageStream", key: "conversation-1", event: "MessageSent", payload: { body: "hi" } }],
      [FrameKind.PresenceSet, { requestId: "presence-1", name: "TypingState", key: "conversation-1:user-1:device-1", value: { isTyping: true } }],
      [FrameKind.SignalSend, { requestId: "signal-1", name: "WebRTCSignal", key: "call-1", value: { kind: "offer", payload: new Uint8Array([1]) } }],
      [FrameKind.CursorCommit, { subscriptionId: "sub-1", cursor: 12 }],
    ];

    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("rejects schema hash mismatch during greenfield cutover", () => {
    expect(() => rejectSchemaMismatch("old-schema", foundationSchema.hash)).toThrow(/schema mismatch/i);
  });
});
```

- [ ] **Step 2: Run the failing frame tests**

Run:

```bash
pnpm vitest run packages/protocol/tests/frame.test.ts
```

Expected: fail because the current frame enum is the prototype protocol.

- [ ] **Step 3: Replace frame definitions**

In `packages/protocol/src/frame.ts`, define these frame families:

```ts
import { decode, encode } from "@msgpack/msgpack";
import type {
  FrickSchema,
  PackedPresenceRecord,
  PackedRecord,
  PackedSignalEnvelope,
  PackedStreamEvent,
  PlainObject,
} from "./index.js";

export const PROTOCOL_VERSION = 1;

export enum FrameKind {
  Hello = 0,
  Schema = 1,
  Subscribe = 2,
  Snapshot = 3,
  StreamPage = 4,
  Append = 5,
  Ack = 6,
  Nack = 7,
  Delta = 8,
  PresenceSet = 9,
  PresenceClear = 10,
  PresenceDelta = 11,
  SignalSend = 12,
  SignalDeliver = 13,
  CursorCommit = 14,
  Ping = 15,
  Pong = 16,
  SyncStatus = 17,
}

export type SubscriptionKind = "object" | "stream" | "presence" | "signal" | "projection";

export interface HelloPayload {
  replicaId: string;
  deviceId: string;
  schemaHash: string;
  knownCursors: Record<string, number>;
}

export interface SubscribePayload {
  subscriptionId: string;
  kind: SubscriptionKind;
  name: string;
  key?: string;
  cursor?: number;
}

export interface SnapshotPayload {
  subscriptionId: string;
  objects: PackedRecord[];
  cursor: number;
}

export interface StreamPagePayload {
  subscriptionId: string;
  events: PackedStreamEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface AppendPayload {
  requestId: string;
  stream: string;
  key: string;
  event: string;
  payload: PlainObject;
}

export interface AckPayload {
  requestId: string;
  cursor?: number;
}

export interface NackPayload {
  requestId: string;
  code: string;
  message: string;
}

export interface DeltaPayload {
  objects: PackedRecord[];
  events: PackedStreamEvent[];
  cursor: number;
}

export interface PresenceSetPayload {
  requestId: string;
  name: string;
  key: string;
  value: PlainObject;
}

export interface PresenceClearPayload {
  requestId: string;
  name: string;
  key: string;
}

export interface PresenceDeltaPayload {
  subscriptionId: string;
  records: PackedPresenceRecord[];
  cleared: string[];
}

export interface SignalPayload {
  requestId: string;
  name: string;
  key: string;
  value: PlainObject;
}

export interface SignalDeliverPayload {
  envelope: PackedSignalEnvelope;
}

export interface CursorCommitPayload {
  subscriptionId: string;
  cursor: number;
}

export type FrickFrame =
  | [FrameKind.Hello, HelloPayload]
  | [FrameKind.Schema, FrickSchema]
  | [FrameKind.Subscribe, SubscribePayload]
  | [FrameKind.Snapshot, SnapshotPayload]
  | [FrameKind.StreamPage, StreamPagePayload]
  | [FrameKind.Append, AppendPayload]
  | [FrameKind.Ack, AckPayload]
  | [FrameKind.Nack, NackPayload]
  | [FrameKind.Delta, DeltaPayload]
  | [FrameKind.PresenceSet, PresenceSetPayload]
  | [FrameKind.PresenceClear, PresenceClearPayload]
  | [FrameKind.PresenceDelta, PresenceDeltaPayload]
  | [FrameKind.SignalSend, SignalPayload]
  | [FrameKind.SignalDeliver, SignalDeliverPayload]
  | [FrameKind.CursorCommit, CursorCommitPayload]
  | [FrameKind.Ping, { sentAt: number }]
  | [FrameKind.Pong, { sentAt: number; receivedAt: number }]
  | [FrameKind.SyncStatus, { connected: boolean; cursors: Record<string, number>; inFlight: number }];

export function encodeFrame(frame: FrickFrame): Uint8Array {
  return encode(frame);
}

export function decodeFrame(payload: ArrayBuffer | Uint8Array | Buffer): FrickFrame {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  return decode(bytes) as FrickFrame;
}

export function rejectSchemaMismatch(clientHash: string, serverHash: string): void {
  if (clientHash !== serverHash) {
    throw new Error(`Schema mismatch: client=${clientHash} server=${serverHash}`);
  }
}
```

- [ ] **Step 4: Export frames**

Update `packages/protocol/src/index.ts`:

```ts
export * from "./schema.js";
export * from "./foundation.js";
export * from "./codec.js";
export * from "./frame.js";
```

- [ ] **Step 5: Run protocol tests**

Run:

```bash
pnpm vitest run packages/protocol/tests
```

Expected: pass after old prototype tests are rewritten or removed to target the foundation protocol.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/frame.ts packages/protocol/src/index.ts packages/protocol/tests/frame.test.ts packages/protocol/tests
git commit -m "feat(protocol): replace prototype frames with foundation transport"
```

---

### Task 4: Native Artifact Generation Cutover

**Files:**
- Modify: `packages/protocol/src/artifacts.ts`
- Modify: `packages/protocol/scripts/generate-native-artifacts.ts`
- Modify: `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift`
- Modify: `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt`
- Create: `packages/protocol/tests/artifacts.test.ts`

- [ ] **Step 1: Write failing artifact tests**

Create `packages/protocol/tests/artifacts.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { foundationSchema, generateKotlinArtifact, generateSwiftArtifact } from "../src/index.js";

describe("native artifacts", () => {
  it("generates Swift DTO names for objects, events, presence, and signals", () => {
    const swift = generateSwiftArtifact(foundationSchema);

    expect(swift).toContain("public struct UserDTO");
    expect(swift).toContain("public struct MessageSentDTO");
    expect(swift).toContain("public struct TypingStateDTO");
    expect(swift).toContain("public struct WebRTCSignalDTO");
  });

  it("generates Kotlin DTO names for objects, events, presence, and signals", () => {
    const kotlin = generateKotlinArtifact(foundationSchema);

    expect(kotlin).toContain("data class UserDto");
    expect(kotlin).toContain("data class MessageSentDto");
    expect(kotlin).toContain("data class TypingStateDto");
    expect(kotlin).toContain("data class WebRtcSignalDto");
  });
});
```

- [ ] **Step 2: Run the failing artifact tests**

Run:

```bash
pnpm vitest run packages/protocol/tests/artifacts.test.ts
```

Expected: fail because native generation still targets the prototype artifacts.

- [ ] **Step 3: Implement artifact generators**

In `packages/protocol/src/artifacts.ts`, export:

```ts
import type { FieldDef, FrickSchema } from "./schema.js";

export function generateSwiftArtifact(schema: FrickSchema): string {
  const structs = [
    ...schema.objects.map((type) => swiftStruct(`${type.name}DTO`, type.fields)),
    ...schema.events.map((type) => swiftStruct(`${type.name}DTO`, type.fields)),
    ...schema.presences.map((type) => swiftStruct(`${type.name}DTO`, type.fields)),
    ...schema.signals.map((type) => swiftStruct(`${type.name}DTO`, type.fields)),
  ];
  return [
    "import Foundation",
    "",
    `public let frickSchemaHash = "${schema.hash}"`,
    "",
    ...structs,
    "",
  ].join("\n");
}

export function generateKotlinArtifact(schema: FrickSchema): string {
  const classes = [
    ...schema.objects.map((type) => kotlinClass(`${type.name}Dto`, type.fields)),
    ...schema.events.map((type) => kotlinClass(`${type.name}Dto`, type.fields)),
    ...schema.presences.map((type) => kotlinClass(`${type.name}Dto`, type.fields)),
    ...schema.signals.map((type) => kotlinClass(`${type.name}Dto`, type.fields)),
  ];
  return [
    "package dev.frick.client",
    "",
    `const val FRICK_SCHEMA_HASH: String = "${schema.hash}"`,
    "",
    ...classes,
    "",
  ].join("\n");
}

function swiftStruct(name: string, fields: FieldDef[]): string {
  const properties = fields.map((field) => `    public let ${field.name}: ${swiftType(field)}`).join("\n");
  return `public struct ${name}: Codable, Equatable {\n${properties}\n}`;
}

function kotlinClass(name: string, fields: FieldDef[]): string {
  const properties = fields.map((field) => `    val ${field.name}: ${kotlinType(field)}`).join(",\n");
  return `data class ${name}(\n${properties}\n)`;
}

function swiftType(field: FieldDef): string {
  const base = field.kind === "bool" ? "Bool"
    : field.kind === "int" ? "Int"
    : field.kind === "bytes" ? "Data"
    : field.kind === "json" ? "String"
    : "String";
  return field.required ? base : `${base}?`;
}

function kotlinType(field: FieldDef): string {
  const base = field.kind === "bool" ? "Boolean"
    : field.kind === "int" ? "Int"
    : field.kind === "bytes" ? "ByteArray"
    : "String";
  return field.required ? base : `${base}?`;
}
```

- [ ] **Step 4: Update generation script**

In `packages/protocol/scripts/generate-native-artifacts.ts`, generate from `foundationSchema`, write the Swift artifact to `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift`, and write the Kotlin artifact to `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt`.

- [ ] **Step 5: Run generation and tests**

Run:

```bash
pnpm schema:generate
pnpm vitest run packages/protocol/tests/artifacts.test.ts
```

Expected: generated Swift and Kotlin files contain foundation DTOs and tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/artifacts.ts packages/protocol/scripts/generate-native-artifacts.ts packages/protocol/tests/artifacts.test.ts packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt
git commit -m "feat(protocol): generate foundation native DTOs"
```

---

### Task 5: Server SQLite Foundation Storage

**Files:**
- Create: `apps/server/src/storage/schema.ts`
- Create: `apps/server/src/storage/object-store.ts`
- Create: `apps/server/src/storage/stream-store.ts`
- Create: `apps/server/src/storage/presence-store.ts`
- Create: `apps/server/src/storage/blob-store.ts`
- Create: `apps/server/src/storage/job-store.ts`
- Modify: `apps/server/src/store.ts`
- Modify: `apps/server/tests/store.test.ts`

- [ ] **Step 1: Write failing storage tests**

Replace `apps/server/tests/store.test.ts` with foundation storage tests:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";

let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("FrickStore foundation storage", () => {
  it("stores objects and appends ordered stream events", () => {
    store = new FrickStore({ path: ":memory:", seed: true });

    const user = store.readObject("User", "user-ada");
    expect(user?.displayName).toBe("Ada Lovelace");

    const event = store.appendEvent({
      requestId: "request-1",
      replicaId: "replica-1",
      stream: "MessageStream",
      streamId: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "Foundation online",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    });

    expect(event.sequence).toBe(1);
    expect(store.readEvents("MessageStream", "conversation-general", 0)).toHaveLength(1);
  });

  it("deduplicates appends by replica and request id", () => {
    store = new FrickStore({ path: ":memory:", seed: true });

    const input = {
      requestId: "request-1",
      replicaId: "replica-1",
      stream: "MessageStream",
      streamId: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "once",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    };

    const first = store.appendEvent(input);
    const second = store.appendEvent(input);

    expect(second.eventId).toBe(first.eventId);
    expect(store.readEvents("MessageStream", "conversation-general", 0)).toHaveLength(1);
  });

  it("stores presence leases, signal envelopes, blob metadata, and jobs", () => {
    store = new FrickStore({ path: ":memory:", seed: true });

    store.setPresence("TypingState", "conversation-general:user-ada:device-1", { isTyping: true }, 5000);
    store.enqueueSignal("WebRTCSignal", "call-1", { senderDeviceId: "device-1", kind: "offer", payload: new Uint8Array([1]) });
    store.createBlobMetadata({ blobId: "blob-1", ownerId: "user-ada", contentHash: "sha256-demo", byteLength: 10, mimeType: "text/plain" });
    store.enqueueJob("PushNotificationJob", { recipientUserId: "user-grace", kind: "message", payload: "{}" });

    expect(store.readPresence("TypingState", "conversation-general:user-ada:device-1")?.isTyping).toBe(true);
    expect(store.drainSignals("WebRTCSignal", "call-1")).toHaveLength(1);
    expect(store.readBlobMetadata("blob-1")?.mimeType).toBe("text/plain");
    expect(store.nextJob("PushNotificationJob")?.name).toBe("PushNotificationJob");
  });
});
```

- [ ] **Step 2: Run the failing storage tests**

Run:

```bash
pnpm vitest run apps/server/tests/store.test.ts
```

Expected: fail because storage modules and foundation store methods do not exist.

- [ ] **Step 3: Create SQLite DDL**

Create `apps/server/src/storage/schema.ts` with `initializeStorage(db: DatabaseSync): void` that executes:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_versions (
  schema_hash TEXT PRIMARY KEY,
  manifest BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  packed BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_type, object_id)
);

CREATE TABLE IF NOT EXISTS stream_events (
  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  packed BLOB NOT NULL,
  replica_id TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (stream_type, stream_id, sequence)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  replica_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  result_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (replica_id, request_id)
);

CREATE TABLE IF NOT EXISTS presence_leases (
  presence_type TEXT NOT NULL,
  presence_key TEXT NOT NULL,
  packed BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (presence_type, presence_key)
);

CREATE TABLE IF NOT EXISTS signal_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type TEXT NOT NULL,
  signal_key TEXT NOT NULL,
  packed BLOB NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blob_metadata (
  blob_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  storage_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  packed BLOB NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 4: Implement storage modules**

Implement each storage module as a small class that receives `DatabaseSync` and `FrickSchema`.

Required public methods:

```ts
ObjectStore.upsert(type: string, id: string, value: PlainObject, version: number): void
ObjectStore.read(type: string, id: string): PlainObject | undefined
ObjectStore.list(type: string): PlainObject[]

StreamStore.append(input: AppendInput): StoredEvent
StreamStore.read(stream: string, streamId: string, after: number): StoredEvent[]

PresenceStore.set(type: string, key: string, value: PlainObject, ttlMs: number): void
PresenceStore.read(type: string, key: string): PlainObject | undefined

SignalRouterStore.enqueue(type: string, key: string, value: PlainObject, ttlMs: number): void
SignalRouterStore.drain(type: string, key: string): PlainObject[]

BlobStore.create(metadata: BlobMetadataInput): void
BlobStore.read(blobId: string): BlobMetadata | undefined

JobStore.enqueue(type: string, value: PlainObject): void
JobStore.next(type: string): StoredJob | undefined
```

- [ ] **Step 5: Compose `FrickStore`**

Rewrite `apps/server/src/store.ts` as a facade over the storage modules. Seed only foundation data:

- `user-ada`
- `user-grace`
- `conversation-general`
- `member-general-ada`
- `member-general-grace`

Expose the methods used by the tests.

- [ ] **Step 6: Run storage tests**

Run:

```bash
pnpm vitest run apps/server/tests/store.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/storage apps/server/src/store.ts apps/server/tests/store.test.ts
git commit -m "feat(server): add foundation SQLite storage"
```

---

### Task 6: Sync Gateway And HTTP Foundation API

**Files:**
- Create: `apps/server/src/sync/subscriptions.ts`
- Create: `apps/server/src/sync/signal-router.ts`
- Create: `apps/server/src/sync/gateway.ts`
- Create: `apps/server/src/authz.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/tests/server.test.ts`

- [ ] **Step 1: Write failing server sync tests**

Replace or extend `apps/server/tests/server.test.ts` with:

```ts
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import { FrameKind, decodeFrame, encodeFrame, foundationSchema, type FrickFrame } from "@frick/protocol";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("foundation sync gateway", () => {
  it("hard rejects schema hash mismatch", async () => {
    app = await startServer();
    const socket = await connect(app.url);

    socket.send(encodeFrame([FrameKind.Hello, {
      replicaId: "replica-1",
      deviceId: "device-1",
      schemaHash: "wrong",
      knownCursors: {},
    }]));

    const frame = await nextFrame(socket);
    expect(frame[0]).toBe(FrameKind.Nack);
    expect(frame[1].code).toBe("schema_mismatch");
  });

  it("subscribes to message stream and receives appended events", async () => {
    app = await startServer();
    const socket = await connect(app.url);

    socket.send(encodeFrame([FrameKind.Hello, {
      replicaId: "replica-1",
      deviceId: "device-1",
      schemaHash: foundationSchema.hash,
      knownCursors: {},
    }]));
    await nextFrame(socket);

    socket.send(encodeFrame([FrameKind.Subscribe, {
      subscriptionId: "sub-messages",
      kind: "stream",
      name: "MessageStream",
      key: "conversation-general",
      cursor: 0,
    }]));

    const page = await nextFrame(socket);
    expect(page[0]).toBe(FrameKind.StreamPage);

    socket.send(encodeFrame([FrameKind.Append, {
      requestId: "request-1",
      stream: "MessageStream",
      key: "conversation-general",
      event: "MessageSent",
      payload: {
        messageId: "message-1",
        senderId: "user-ada",
        body: "hello",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
    }]));

    expect((await nextFrame(socket))[0]).toBe(FrameKind.Ack);
    expect((await nextFrame(socket))[0]).toBe(FrameKind.Delta);
  });
});

async function startServer() {
  const server = createFrickServer({ port: 0, dbPath: ":memory:" });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    close: server.close,
  };
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

async function nextFrame(socket: WebSocket): Promise<FrickFrame> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(decodeFrame(data as Buffer))));
}
```

- [ ] **Step 2: Run the failing sync tests**

Run:

```bash
pnpm vitest run apps/server/tests/server.test.ts
```

Expected: fail because the current server still uses prototype frames.

- [ ] **Step 3: Implement local authorization**

Create `apps/server/src/authz.ts`:

```ts
export interface Principal {
  userId: string;
  deviceId: string;
  replicaId: string;
}

export function principalFromHello(replicaId: string, deviceId: string): Principal {
  return { userId: replicaId.includes("grace") ? "user-grace" : "user-ada", deviceId, replicaId };
}

export function assertCanSubscribe(_principal: Principal, _kind: string, _name: string, _key?: string): void {
}

export function assertCanAppend(_principal: Principal, _stream: string, _key: string): void {
}

export function assertCanSignal(_principal: Principal, _signal: string, _key: string): void {
}
```

This permissive authz is only for local foundation validation. It keeps the interface explicit so production auth can replace the internals.

- [ ] **Step 4: Implement subscription registry**

Create `apps/server/src/sync/subscriptions.ts` with a class that tracks clients by subscription id and can find matching stream subscribers by `(stream, key)`.

- [ ] **Step 5: Implement signal router**

Create `apps/server/src/sync/signal-router.ts` with a `routeSignal` function that packs a signal envelope and sends `FrameKind.SignalDeliver` to connected clients subscribed to that signal key.

- [ ] **Step 6: Implement sync gateway**

Create `apps/server/src/sync/gateway.ts` with:

- WebSocket `connection` handling.
- `Hello` handling with `rejectSchemaMismatch`.
- `Subscribe` handling for `stream`, `object`, `presence`, and `signal`.
- `Append` handling through `store.appendEvent`.
- `PresenceSet` / `PresenceClear` handling through store presence methods.
- `SignalSend` handling through authz and signal router.
- `CursorCommit` acknowledgement.

- [ ] **Step 7: Simplify HTTP server wiring**

Rewrite `apps/server/src/server.ts` so HTTP routes are foundation-focused:

- `GET /health`
- `GET /schema`
- `GET /objects?type=Conversation`
- `GET /streams/:stream/:key?after=0`
- `POST /append`

Mount WebSocket at `/_frick/sync` using `SyncGateway`.

- [ ] **Step 8: Run server tests**

Run:

```bash
pnpm vitest run apps/server/tests/server.test.ts apps/server/tests/store.test.ts
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src apps/server/tests/server.test.ts apps/server/tests/store.test.ts
git commit -m "feat(server): cut over to foundation sync gateway"
```

---

### Task 7: Core Runtime Foundation API

**Files:**
- Create: `packages/core/src/cache.ts`
- Create: `packages/core/src/subscriptions.ts`
- Modify: `packages/core/src/runtime.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/tests/runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Replace `packages/core/tests/runtime.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { FrameKind, foundationSchema } from "@frick/protocol";
import { FrickClient, MemoryFrickCache } from "../src/index.js";

describe("foundation runtime", () => {
  it("hydrates objects and stream events from local cache", () => {
    const cache = new MemoryFrickCache();
    cache.saveObject(foundationSchema, "User", "user-ada", { displayName: "Ada Lovelace" }, 1);
    cache.saveStreamEvent(foundationSchema, {
      stream: "MessageStream",
      streamId: "conversation-general",
      sequence: 1,
      eventId: "event-1",
      event: "MessageSent",
      payload: { messageId: "message-1", senderId: "user-ada", body: "cached", createdAt: "2026-05-09T00:00:00.000Z" },
    });

    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema, cache });

    expect(client.object("User", "user-ada")?.displayName).toBe("Ada Lovelace");
    expect(client.stream("MessageStream", "conversation-general").value).toHaveLength(1);
  });

  it("queues appends while disconnected and tracks pending count", async () => {
    const cache = new MemoryFrickCache();
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema, cache });

    await client.append("MessageStream", "conversation-general", "MessageSent", {
      messageId: "message-1",
      senderId: "user-ada",
      body: "queued",
      createdAt: "2026-05-09T00:00:00.000Z",
    });

    expect(client.syncStatus.value.pendingMutations).toBe(1);
    expect(cache.load(foundationSchema).pendingAppends).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the failing runtime tests**

Run:

```bash
pnpm vitest run packages/core/tests/runtime.test.ts
```

Expected: fail because runtime still exposes query/mutate prototype APIs.

- [ ] **Step 3: Implement portable cache**

Create `packages/core/src/cache.ts`:

```ts
import type { FrickSchema, PlainObject, StreamEventInput } from "@frick/protocol";

export interface PendingAppend {
  requestId: string;
  stream: string;
  key: string;
  event: string;
  payload: PlainObject;
}

export interface FrickCacheState {
  objects: Array<{ type: string; id: string; value: PlainObject; version: number }>;
  streamEvents: StreamEventInput[];
  cursors: Record<string, number>;
  pendingAppends: PendingAppend[];
}

export interface FrickLocalCache {
  load(schema: FrickSchema): FrickCacheState;
  saveObject(schema: FrickSchema, type: string, id: string, value: PlainObject, version: number): void;
  saveStreamEvent(schema: FrickSchema, event: StreamEventInput): void;
  saveCursor(schema: FrickSchema, key: string, cursor: number): void;
  savePendingAppend(schema: FrickSchema, append: PendingAppend): void;
  removePendingAppend(schema: FrickSchema, requestId: string): void;
}
```

Move the in-memory implementation into the same file and update it for objects, stream events, cursors, and pending appends.

- [ ] **Step 4: Implement foundation subscriptions**

Create `packages/core/src/subscriptions.ts` with `Signal<T>`, `objectKey`, `streamKey`, and typed helper functions for updating subscribers.

- [ ] **Step 5: Rewrite runtime**

Rewrite `packages/core/src/runtime.ts` around the new methods:

```ts
client.object(type, id): PlainObject | undefined
client.objects(type): Signal<PlainObject[]>
client.stream(stream, key): Signal<StreamEventInput[]>
client.presence(name, key): Signal<PlainObject | undefined>
client.signalChannel(name, key): Signal<PlainObject[]>
client.append(stream, key, event, payload): Promise<void>
client.setPresence(name, key, value): Promise<void>
client.clearPresence(name, key): Promise<void>
client.sendSignal(name, key, value): Promise<void>
```

Use canonical frames from `@frick/protocol`. On connect, send `Hello` with schema hash and known cursors. On `Ack`, remove the matching pending append. On `StreamPage` and `Delta`, update cache and subscribers.

- [ ] **Step 6: Export runtime API**

Update `packages/core/src/index.ts` to export `cache.ts`, `subscriptions.ts`, and `runtime.ts`.

- [ ] **Step 7: Run core tests**

Run:

```bash
pnpm vitest run packages/core/tests/runtime.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src packages/core/tests/runtime.test.ts
git commit -m "feat(core): expose foundation sync runtime"
```

---

### Task 8: React Foundation Hooks And Web Harness

**Files:**
- Modify: `packages/react/src/index.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/theme.ts`

- [ ] **Step 1: Update React hooks**

Replace query/mutation hooks with foundation hooks:

```ts
useObject(type: string, id: string)
useObjects(type: string)
useStream(stream: string, key: string)
useAppend(stream: string, key: string)
usePresence(name: string, key: string)
useSetPresence(name: string, key: string)
useSignalChannel(name: string, key: string)
useSendSignal(name: string, key: string)
useSyncStatus()
```

`FrickProvider` should default to `foundationSchema` and endpoint `ws://127.0.0.1:4099/_frick/sync`.

- [ ] **Step 2: Build web conformance harness**

Update `apps/web/src/App.tsx` into a thin foundation test surface:

- Left panel: users and conversations loaded from objects.
- Main panel: `MessageStream` for `conversation-general`.
- Composer: append `MessageSent`.
- Presence indicator: set/clear `TypingState`.
- Signal tester: send a fake `WebRTCSignal` and render received signal count.
- Sync status strip: connected, cursors, pending appends.

- [ ] **Step 3: Keep dark mode support**

Keep existing dark mode behavior in `apps/web/src/theme.ts` and `apps/web/src/styles.css`. Do not regress current dark UI.

- [ ] **Step 4: Run web package checks**

Run:

```bash
pnpm typecheck
pnpm --filter @frick/web build
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add packages/react/src/index.tsx apps/web/src/App.tsx apps/web/src/styles.css apps/web/src/theme.ts
git commit -m "feat(web): add foundation conformance hooks and harness"
```

---

### Task 9: Swift Client Foundation Cutover

**Files:**
- Modify: `packages/swift/Sources/FrickSwift/FrickClient.swift`
- Modify: `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift`
- Modify: `packages/swift/Tests/FrickSwiftTests/FrickEventStreamParserTests.swift`
- Modify: `apps/ios/FrickDemo/ContentView.swift`

- [ ] **Step 1: Write Swift tests for SQL-backed foundation cache**

Update Swift tests to cover:

- Generated `frickSchemaHash`.
- SQLite object save/read for `UserDTO`.
- SQLite stream event save/read for `MessageSentDTO`.
- Pending append persistence and removal.

- [ ] **Step 2: Run failing Swift tests**

Run:

```bash
pnpm swift:test
```

Expected: fail until the Swift client runtime is updated.

- [ ] **Step 3: Rewrite Swift runtime API**

In `FrickClient.swift`, expose:

```swift
public func object(type: String, id: String) async throws -> [String: Sendable]
public func stream(name: String, key: String) -> AsyncStream<FrickStreamEvent>
public func append(stream: String, key: String, event: String, payload: [String: Sendable]) async throws
public func setPresence(name: String, key: String, value: [String: Sendable]) async throws
public func sendSignal(name: String, key: String, value: [String: Sendable]) async throws
```

Use SQLite tables that mirror the TypeScript client cache: `local_objects`, `local_stream_events`, `local_stream_cursors`, and `pending_mutations`.

- [ ] **Step 4: Update iOS conformance harness**

Update `apps/ios/FrickDemo/ContentView.swift` so it:

- Loads `conversation-general`.
- Shows messages from `MessageStream`.
- Appends `MessageSent`.
- Shows sync status and pending append count.
- Keeps the launch screen definition intact.

- [ ] **Step 5: Run Swift and iOS checks**

Run:

```bash
pnpm swift:test
pnpm ios:generate
pnpm ios:build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/swift apps/ios/FrickDemo/ContentView.swift apps/ios/project.yml
git commit -m "feat(swift): cut over to foundation client runtime"
```

---

### Task 10: Android Client Foundation Cutover

**Files:**
- Modify: `apps/android/frick/src/main/java/dev/frick/client/FrickClient.kt`
- Modify: `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt`
- Modify: `apps/android/frick/src/test/java/dev/frick/client/FrickEventStreamParserTest.kt`
- Modify: `apps/android/frick/src/test/java/dev/frick/client/FrickSQLiteStorageTest.kt`
- Modify: `apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt`

- [ ] **Step 1: Write Kotlin tests for foundation cache**

Update Android library tests to cover:

- Generated `FRICK_SCHEMA_HASH`.
- SQLite object save/read for `UserDto`.
- SQLite stream event save/read for `MessageSentDto`.
- Pending append persistence and removal.
- WebSocket/SSE parser for stream pages and deltas.

- [ ] **Step 2: Run failing Android tests**

Run:

```bash
pnpm android:build
```

Expected: fail until Kotlin client is updated.

- [ ] **Step 3: Rewrite Kotlin runtime API**

In `FrickClient.kt`, expose:

```kotlin
fun objects(type: String): StateFlow<List<Map<String, Any?>>>
fun stream(name: String, key: String): StateFlow<List<FrickStreamEvent>>
suspend fun append(stream: String, key: String, event: String, payload: Map<String, Any?>)
suspend fun setPresence(name: String, key: String, value: Map<String, Any?>)
suspend fun sendSignal(name: String, key: String, value: Map<String, Any?>)
```

Use Android SQLite tables matching the Swift and TypeScript cache shape.

- [ ] **Step 4: Update Compose conformance harness**

Update `apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt` so it:

- Loads `conversation-general`.
- Shows messages from `MessageStream`.
- Appends `MessageSent`.
- Shows sync status and pending append count.
- Uses `10.0.2.2:4099` for emulator backend access.

- [ ] **Step 5: Run Android checks**

Run:

```bash
pnpm android:build
```

Expected: tests, lint, and debug builds pass.

- [ ] **Step 6: Commit**

```bash
git add apps/android/frick apps/android/app/src/main/java/dev/frick/demo/MainActivity.kt
git commit -m "feat(android): cut over to foundation client runtime"
```

---

### Task 11: Local Runtime And Tilt Cutover

**Files:**
- Modify: `Tiltfile`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Update scripts**

Ensure these scripts still exist and point at the foundation stack:

```json
{
  "scripts": {
    "schema:generate": "tsx packages/protocol/scripts/generate-native-artifacts.ts",
    "server": "pnpm --filter @frick/server dev",
    "web": "pnpm --filter @frick/web dev",
    "tilt": "tilt up",
    "swift:test": "pnpm schema:generate && swift test --package-path packages/swift",
    "ios:build": "pnpm schema:generate && cd apps/ios && xcodebuild -project FrickDemo.xcodeproj -scheme FrickDemo -destination 'platform=iOS Simulator,name=iPhone 17' build",
    "android:build": "pnpm schema:generate && cd apps/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator:$PATH ./gradlew :frick:testDebugUnitTest :frick:lintDebug :frick:assembleDebug :app:lintDebug :app:assembleDebug"
  }
}
```

- [ ] **Step 2: Update Tilt resources**

Keep Tilt lightweight:

- one resource for dependency install if needed,
- one server resource,
- one web resource,
- links to `http://127.0.0.1:4099/health`, `http://127.0.0.1:4099/schema`, and `http://127.0.0.1:5173/`.

- [ ] **Step 3: Update README**

Document:

- greenfield cutover posture,
- local database reset expectation,
- core primitives,
- commands to run server, web, iOS, and Android,
- what the conformance harnesses prove.

- [ ] **Step 4: Run local stack checks**

Run:

```bash
pnpm test
pnpm typecheck
pnpm --filter @frick/web build
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add Tiltfile README.md package.json
git commit -m "docs: document foundation cutover runtime"
```

---

### Task 12: Cross-Platform Foreground Verification

**Files:**
- Modify only if verification exposes defects.

- [ ] **Step 1: Reset local data**

Remove local prototype databases before launching the cutover stack:

```bash
rm -f apps/server/data/frick.sqlite
```

Expected: no output if the file does not exist.

- [ ] **Step 2: Generate native artifacts**

Run:

```bash
pnpm schema:generate
```

Expected: Swift and Kotlin generated files contain `frick-foundation-2026-05-09`.

- [ ] **Step 3: Run full automated verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm --filter @frick/web build
pnpm swift:test
pnpm ios:build
pnpm android:build
```

Expected: all pass.

- [ ] **Step 4: Start server and web**

Run in foreground terminals or managed screen sessions:

```bash
pnpm server
pnpm --filter @frick/web dev
```

Expected:

- server healthy at `http://127.0.0.1:4099/health`,
- schema visible at `http://127.0.0.1:4099/schema`,
- web harness visible at `http://127.0.0.1:5173/`.

- [ ] **Step 5: Run iOS app in simulator**

Run:

```bash
pnpm ios:generate
pnpm ios:build
```

Then launch the app on the booted simulator. Expected: iOS app loads `conversation-general` and can append a message.

- [ ] **Step 6: Run Android app in emulator**

Run:

```bash
pnpm android:emulator
pnpm android:install
```

Expected: Android app loads `conversation-general` through `10.0.2.2:4099` and can append a message.

- [ ] **Step 7: Verify realtime propagation**

With web, iOS, and Android open:

1. Append a message on web.
2. Confirm it appears on iOS and Android.
3. Append a message on iOS.
4. Confirm it appears on web and Android.
5. Append a message on Android.
6. Confirm it appears on web and iOS.
7. Trigger typing presence on web.
8. Confirm presence renders on the other clients.
9. Send a fake WebRTC signal from web.
10. Confirm subscribed clients receive a signal event.

- [ ] **Step 8: Commit fixes from verification**

If verification required code changes:

```bash
git add <changed-files>
git commit -m "fix: stabilize foundation cutover verification"
```

If verification required no changes, do not create an empty commit.

---

## Self-Review

- Spec coverage: covered canonical schema, compact codecs, transport frames, server SQL storage, object store, stream store, presence, signals, blobs, jobs, client local SQL shape, React hooks, Swift/Kotlin DTOs, thin conformance apps, Tilt, and cross-platform verification.
- Scope check: this is a master cutover plan with independently testable tasks. If execution starts to sprawl, split Tasks 5-6, Tasks 7-10, and Task 12 into separate task-runner sessions.
- Placeholder scan: no implementation task depends on preserving prototype compatibility. No task asks for product-specific FrickenChat UX.
- Type consistency: frame names, schema names, and cache method names are consistent across protocol, server, core runtime, React, Swift, and Kotlin sections.
