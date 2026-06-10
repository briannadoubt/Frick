/**
 * Golden wire fixtures for the FR-236 Rust rewrite (FR-238 / FR-250).
 *
 * Encodes a comprehensive set of frames with the production TypeScript
 * encoder (`encodeFrame` → @msgpack/msgpack) and writes:
 *
 *   conformance/fixtures/wire/<name>.bin   — the exact wire bytes
 *   conformance/fixtures/wire/manifest.json — per-case metadata + the logical
 *     frame as JSON (Uint8Array values appear as {"$bytes": "<base64>"}).
 *
 * The Rust `frick-protocol` crate must decode every .bin and — for cases with
 * `reencode: true` — re-encode to byte-identical output. Cases with
 * `reencode: false` use msgpack map-key orders the Rust typed structs do not
 * reproduce (e.g. raw schema literals before validateSchema normalization);
 * they are decode/semantic checks only.
 *
 * Payload object literals below deliberately list keys in the order the TS
 * interfaces declare them — that is the byte-level key order the fixtures pin.
 *
 * Run from the repo root: pnpm fixtures:wire
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FrameKind, PROTOCOL_VERSION, encodeFrame, type FrickFrame } from "../src/frame.js";
import { defaultClientCapabilities, defaultServerCapabilities } from "../src/capabilities.js";
import { compareSchemaCompatibility } from "../src/compatibility.js";
import { FRICK_ERROR_CODES } from "../src/errors.js";
import {
  packObjectRecord,
  packPresenceRecord,
  packSignalEnvelope,
  packStreamEvent,
} from "../src/codec.js";
import { foundationSchema } from "../src/foundation.js";
import { productTestSchema } from "../src/fixtures/product-test-schema.js";
import { validateSchema } from "../src/schema.js";

const outDir = join(process.cwd(), "conformance", "fixtures", "wire");

interface Case {
  name: string;
  description: string;
  /** Whether the Rust typed structs are expected to re-encode byte-identically. */
  reencode: boolean;
  /**
   * True when the typed Rust layer legitimately loses information on decode
   * (e.g. an explicitly-undefined optional encoded as key→nil decodes to
   * None and re-emits without the key). Lossy cases are decode-only.
   */
  lossy?: boolean;
  /** Manifest JSON override for frames `toJsonSafe` can't mirror (e.g. explicit undefined). */
  json?: unknown;
  frame: FrickFrame;
}

const validatedFoundation = validateSchema(foundationSchema);
const validatedProduct = validateSchema(productTestSchema);

// A schema whose revisions are compatible with productTestSchema but whose
// hash differs — exercises the revisionCompatibleHashMismatch branch.
const driftedProduct = { ...validatedProduct, hash: "frick-product-test-0.2.0-drift" };

/** Width-boundary torture values for the msgpack integer/string/collection formats. */
const tortureValues = {
  i0: 0,
  i127: 127,
  i128: 128,
  i255: 255,
  i256: 256,
  i65535: 65535,
  i65536: 65536,
  i2p31: 2147483648,
  i2p32: 4294967296,
  iMaxSafe: Number.MAX_SAFE_INTEGER,
  iNeg32: -32,
  iNeg33: -33,
  iNeg128: -128,
  iNeg129: -129,
  iNeg32768: -32768,
  iNeg32769: -32769,
  iNeg2p31: -2147483648,
  iNeg2p31m1: -2147483649,
  iMinSafe: Number.MIN_SAFE_INTEGER,
  f: 1.5,
  fNeg: -2.75,
  fTiny: 1e-9,
  strEmpty: "",
  str31: "a".repeat(31),
  str32: "b".repeat(32),
  str255: "c".repeat(255),
  str256: "d".repeat(256),
  unicode: "héllo 🦀 日本語",
  yes: true,
  no: false,
  nil: null,
  arr15: Array.from({ length: 15 }, (_, i) => i),
  arr16: Array.from({ length: 16 }, (_, i) => i),
  map15: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i])),
  map16: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i])),
  bytes: new Uint8Array([0, 1, 2, 254, 255]),
  bytes256: new Uint8Array(256).fill(7),
  str65535: "e".repeat(65535),
  str65536: "f".repeat(65536),
  bytes65536: new Uint8Array(65536).fill(9),
  emptyKey: { "": "empty" },
  // JS treats -0 as a safe integer, so @msgpack/msgpack encodes fixint 0.
  fNegZero: -0,
  // JS objects hoist canonical-integer keys ascending: wire order "2", "10".
  numericKeys: { "10": 1, "2": 2 },
};
// array32/map32 (>65535 elements) are deliberately not covered: the length
// encoding shares the array16/map16 code path on both sides and the fixture
// payloads would dominate the repo.

const cases: Case[] = [
  {
    name: "hello-minimal",
    description: "Hello without optional sessionToken/clientCapabilities",
    reencode: true,
    frame: [
      FrameKind.Hello,
      {
        replicaId: "replica-1",
        deviceId: "device-1",
        schemaHash: validatedProduct.hash,
        knownCursors: { "sub-objects": 41, "sub-stream": 7 },
      },
    ],
  },
  {
    name: "hello-full",
    description: "Hello with sessionToken and full default client capabilities",
    reencode: true,
    frame: [
      FrameKind.Hello,
      {
        replicaId: "replica-2",
        deviceId: "device-2",
        schemaHash: validatedProduct.hash,
        knownCursors: {},
        sessionToken: "session-token-fixture",
        clientCapabilities: defaultClientCapabilities({
          platform: "test",
          sdkVersion: "0.0.0-fixture",
          schema: validatedProduct,
        }),
      },
    ],
  },
  {
    name: "schema-foundation-raw",
    description:
      "Schema frame carrying the foundation schema in source-literal key order (decode-only)",
    reencode: false,
    frame: [FrameKind.Schema, foundationSchema],
  },
  {
    name: "schema-foundation-validated",
    description: "Schema frame carrying validateSchema(foundationSchema) — sorted key order",
    reencode: true,
    frame: [FrameKind.Schema, validatedFoundation],
  },
  {
    name: "schema-product-validated",
    description: "Schema frame carrying validateSchema(productTestSchema) — sorted key order",
    reencode: true,
    frame: [FrameKind.Schema, validatedProduct],
  },
  {
    name: "subscribe-object-minimal",
    description: "Subscribe to an object type without key/cursor",
    reencode: true,
    frame: [
      FrameKind.Subscribe,
      { subscriptionId: "sub-1", kind: "object", name: "User" },
    ],
  },
  {
    name: "subscribe-stream-full",
    description: "Subscribe to a stream with key and cursor",
    reencode: true,
    frame: [
      FrameKind.Subscribe,
      { subscriptionId: "sub-2", kind: "stream", name: "MessageStream", key: "conv-1", cursor: 12 },
    ],
  },
  {
    name: "snapshot-objects",
    description: "Snapshot with packed object records (optional field present and absent)",
    reencode: true,
    frame: [
      FrameKind.Snapshot,
      {
        subscriptionId: "sub-1",
        objects: [
          packObjectRecord(validatedProduct, "User", "user-1", { displayName: "Ada" }),
          packObjectRecord(validatedProduct, "User", "user-2", {
            displayName: "Bo",
            avatarBlobId: "blob-1",
          }),
        ],
        cursor: 41,
      },
    ],
  },
  {
    name: "stream-page",
    description: "StreamPage with packed MessageSent events and hasMore",
    reencode: true,
    frame: [
      FrameKind.StreamPage,
      {
        subscriptionId: "sub-2",
        events: [
          packStreamEvent(validatedProduct, {
            stream: "MessageStream",
            streamId: "conv-1",
            sequence: 1,
            eventId: "evt-1",
            event: "MessageSent",
            payload: {
              messageId: "msg-1",
              senderId: "user-1",
              body: "hello",
              createdAt: 1718064000000,
            },
          }),
          packStreamEvent(validatedProduct, {
            stream: "MessageStream",
            streamId: "conv-1",
            sequence: 2,
            eventId: "evt-2",
            event: "MessageSent",
            payload: {
              messageId: "msg-2",
              senderId: "user-2",
              body: "hi 🦀",
              createdAt: 1718064001000,
              attachmentBlobIds: ["blob-1", "blob-2"],
            },
          }),
        ],
        cursor: 2,
        hasMore: true,
      },
    ],
  },
  {
    name: "append",
    description: "Append whose payload exercises msgpack width boundaries",
    reencode: true,
    frame: [
      FrameKind.Append,
      {
        requestId: "req-append-1",
        stream: "MessageStream",
        key: "conv-1",
        event: "MessageSent",
        payload: tortureValues,
      },
    ],
  },
  {
    name: "ack-bare",
    description: "Ack with requestId only",
    reencode: true,
    frame: [FrameKind.Ack, { requestId: "req-1" }],
  },
  {
    name: "ack-cursor-version",
    description: "Ack carrying both optional cursor and version",
    reencode: true,
    frame: [FrameKind.Ack, { requestId: "req-2", cursor: 42, version: 7 }],
  },
  {
    name: "nack-minimal",
    description: "Nack with just the error envelope (no optional envelope fields)",
    reencode: true,
    frame: [
      FrameKind.Nack,
      {
        requestId: "req-3",
        error: {
          code: "storage.notFound",
          message: "Object not found",
          requestId: "req-3",
          retryable: false,
        },
      },
    ],
  },
  {
    name: "nack-full",
    description: "Nack with a fully-populated envelope plus legacy code/message",
    reencode: true,
    frame: [
      FrameKind.Nack,
      {
        requestId: "req-4",
        error: {
          code: "schema.incompatible",
          message: "Fixture schema mismatch",
          requestId: "req-4",
          retryable: false,
          details: { reason: "fixture", clientHash: "abc", attempt: 2 },
          schemaHash: validatedProduct.hash,
          schemaRevision: validatedProduct.schemaRevision,
        },
        code: "schema.incompatible",
        message: "Fixture schema mismatch",
      },
    ],
  },
  {
    name: "delta-empty",
    description: "Delta with empty objects/events",
    reencode: true,
    frame: [FrameKind.Delta, { objects: [], events: [], cursor: 99 }],
  },
  {
    name: "delta-removed",
    description: "Delta carrying objects plus the optional removed list (FR-142)",
    reencode: true,
    frame: [
      FrameKind.Delta,
      {
        objects: [packObjectRecord(validatedProduct, "User", "user-1", { displayName: "Ada" })],
        events: [],
        cursor: 100,
        removed: [
          { type: "User", id: "user-9" },
          { type: "Conversation", id: "conv-9" },
        ],
      },
    ],
  },
  {
    name: "presence-set",
    description: "PresenceSet for TypingState",
    reencode: true,
    frame: [
      FrameKind.PresenceSet,
      {
        requestId: "req-5",
        name: "TypingState",
        key: "conv-1:user-1:device-1",
        value: { isTyping: true },
      },
    ],
  },
  {
    name: "presence-clear",
    description: "PresenceClear",
    reencode: true,
    frame: [
      FrameKind.PresenceClear,
      { requestId: "req-6", name: "TypingState", key: "conv-1:user-1:device-1" },
    ],
  },
  {
    name: "presence-delta",
    description: "PresenceDelta with packed records and cleared keys",
    reencode: true,
    frame: [
      FrameKind.PresenceDelta,
      {
        subscriptionId: "sub-3",
        records: [
          packPresenceRecord(validatedProduct, "TypingState", "conv-1:user-1:device-1", {
            isTyping: true,
          }),
        ],
        cleared: ["conv-1:user-2:device-2"],
      },
    ],
  },
  {
    name: "signal-send",
    description: "SignalSend carrying a WebRTC offer with binary payload",
    reencode: true,
    frame: [
      FrameKind.SignalSend,
      {
        requestId: "req-7",
        name: "WebRTCSignal",
        key: "call-1",
        value: {
          senderDeviceId: "device-1",
          recipientDeviceId: "device-2",
          kind: "offer",
          payload: new Uint8Array([0x73, 0x64, 0x70, 0x00, 0xff]),
        },
      },
    ],
  },
  {
    name: "signal-deliver",
    description: "SignalDeliver with a packed WebRTCSignal envelope (binary field)",
    reencode: true,
    frame: [
      FrameKind.SignalDeliver,
      {
        envelope: packSignalEnvelope(validatedProduct, "WebRTCSignal", "call-1", {
          senderDeviceId: "device-1",
          kind: "answer",
          payload: new Uint8Array([0x01, 0x02]),
        }),
      },
    ],
  },
  {
    name: "cursor-commit",
    description: "CursorCommit",
    reencode: true,
    frame: [FrameKind.CursorCommit, { subscriptionId: "sub-2", cursor: 1234567 }],
  },
  {
    name: "ping",
    description: "Ping with a millisecond timestamp",
    reencode: true,
    frame: [FrameKind.Ping, { sentAt: 1718064000123 }],
  },
  {
    name: "pong",
    description: "Pong echoing sentAt with receivedAt",
    reencode: true,
    frame: [FrameKind.Pong, { sentAt: 1718064000123, receivedAt: 1718064000150 }],
  },
  {
    name: "sync-status",
    description: "SyncStatus with cursors map and inFlight count",
    reencode: true,
    frame: [
      FrameKind.SyncStatus,
      { connected: true, cursors: { "sub-1": 41, "sub-2": 2 }, inFlight: 3 },
    ],
  },
  {
    name: "hello-ack-exact",
    description: "HelloAck for an exact schema match with default server capabilities",
    reencode: true,
    frame: [
      FrameKind.HelloAck,
      {
        schemaHash: validatedProduct.hash,
        schemaId: validatedProduct.schemaId,
        schemaRevision: validatedProduct.schemaRevision,
        schemaCompatibility: compareSchemaCompatibility(validatedProduct, validatedProduct),
        serverCapabilities: defaultServerCapabilities(validatedProduct),
      },
    ],
  },
  {
    name: "hello-ack-hash-drift",
    description: "HelloAck where revisions are compatible but hashes differ (message present)",
    reencode: true,
    frame: [
      FrameKind.HelloAck,
      {
        schemaHash: validatedProduct.hash,
        schemaId: validatedProduct.schemaId,
        schemaRevision: validatedProduct.schemaRevision,
        schemaCompatibility: compareSchemaCompatibility(driftedProduct, validatedProduct),
        serverCapabilities: {
          ...defaultServerCapabilities(validatedProduct),
          limits: { maxAppendBytes: 1048576, maxBlobBytes: 268435456 },
        },
      },
    ],
  },
  {
    name: "projection-delta",
    description: "ProjectionDelta with an upsert row and a null delete row",
    reencode: true,
    frame: [
      FrameKind.ProjectionDelta,
      {
        projection: "ConversationInbox",
        changes: [
          {
            key: "user-1:conv-1",
            value: {
              conversationId: "conv-1",
              userId: "user-1",
              kind: "dm",
              lastSequence: 2,
              readSequence: 1,
              unreadCount: 1,
              updatedAt: 1718064001000,
            },
          },
          { key: "user-1:conv-2", value: null },
        ],
      },
    ],
  },
  {
    name: "object-upsert-create",
    description: "ObjectUpsert without expectedVersion (create intent)",
    reencode: true,
    frame: [
      FrameKind.ObjectUpsert,
      {
        requestId: "req-8",
        objectType: "MessageDraft",
        objectId: "draft-1",
        value: {
          userId: "user-1",
          conversationId: "conv-1",
          body: "draft body",
          updatedAt: 1718064002000,
        },
      },
    ],
  },
  {
    name: "object-upsert-versioned",
    description: "ObjectUpsert with expectedVersion (versionPrecondition policy)",
    reencode: true,
    frame: [
      FrameKind.ObjectUpsert,
      {
        requestId: "req-9",
        objectType: "MessageDraft",
        objectId: "draft-1",
        value: {
          userId: "user-1",
          conversationId: "conv-1",
          body: "draft body v2",
          updatedAt: 1718064003000,
        },
        expectedVersion: 1,
      },
    ],
  },
  {
    name: "call-command-create",
    description: "CallCommand create with invitees, kind, and regionHint",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      {
        requestId: "req-10",
        command: {
          op: "create",
          conversationId: "conv-1",
          inviteeUserIds: ["user-2", "user-3"],
          kind: "video",
          regionHint: "us-west-2",
        },
      },
    ],
  },
  {
    name: "call-command-join",
    description: "CallCommand join",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      { requestId: "req-11", command: { op: "join", callId: "call-1" } },
    ],
  },
  {
    name: "call-command-set-media-state",
    description: "CallCommand setMediaState with a partial media patch",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      {
        requestId: "req-12",
        command: {
          op: "setMediaState",
          callId: "call-1",
          media: { micEnabled: false, screenSharing: true },
        },
      },
    ],
  },
  {
    name: "call-command-sfu-connect",
    description: "CallCommand sfuConnectTransport with opaque dtlsParameters",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      {
        requestId: "req-13",
        command: {
          op: "sfuConnectTransport",
          callId: "call-1",
          token: "join-nonce-1",
          transportId: "transport-1",
          dtlsParameters: { role: "client", fingerprints: [{ algorithm: "sha-256", value: "AA:BB" }] },
        },
      },
    ],
  },
  {
    name: "call-command-sfu-consume",
    description: "CallCommand sfuConsume with opaque rtpCapabilities",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      {
        requestId: "req-14",
        command: {
          op: "sfuConsume",
          callId: "call-1",
          token: "join-nonce-1",
          transportId: "transport-2",
          producerId: "producer-1",
          rtpCapabilities: { codecs: [{ mimeType: "audio/opus", clockRate: 48000, channels: 2 }] },
        },
      },
    ],
  },
  {
    name: "call-command-result-create",
    description: "CallCommandResult for create: room + invites",
    reencode: true,
    frame: [
      FrameKind.CallCommandResult,
      {
        requestId: "req-10",
        op: "create",
        room: {
          id: "call-1",
          conversationId: "conv-1",
          state: "ringing",
          createdBy: "user-1",
          kind: "video",
          createdAt: "2026-06-10T00:00:00.000Z",
        },
        invites: [
          {
            id: "invite-1",
            callId: "call-1",
            inviteeUserId: "user-2",
            status: "ringing",
            invitedBy: "user-1",
            invitedAt: "2026-06-10T00:00:00.000Z",
          },
        ],
      },
    ],
  },
  {
    name: "call-command-result-join",
    description: "CallCommandResult for join: room + participant + mediaGrant",
    reencode: true,
    frame: [
      FrameKind.CallCommandResult,
      {
        requestId: "req-11",
        op: "join",
        room: {
          id: "call-1",
          conversationId: "conv-1",
          state: "active",
          createdBy: "user-1",
          kind: "video",
          createdAt: "2026-06-10T00:00:00.000Z",
          startedAt: "2026-06-10T00:00:05.000Z",
          mediaSessionId: "media-1",
          transport: "sfu",
        },
        participant: {
          id: "participant-1",
          callId: "call-1",
          userId: "user-2",
          deviceId: "device-2",
          state: "joined",
          joinedAt: "2026-06-10T00:00:05.000Z",
          micEnabled: true,
          cameraEnabled: true,
          screenSharing: false,
          speaking: false,
          networkQuality: "good",
        },
        mediaGrant: {
          callId: "call-1",
          mediaSessionId: "media-1",
          userId: "user-2",
          deviceId: "device-2",
          token: "grant-token-1",
          expiresAt: "2026-06-10T00:05:05.000Z",
          connection: { signalingUrl: "wss://sfu.example/route" },
        },
      },
    ],
  },
  {
    name: "call-command-result-sfu-consume",
    description: "CallCommandResult for sfuConsume: consumer params",
    reencode: true,
    frame: [
      FrameKind.CallCommandResult,
      {
        requestId: "req-14",
        op: "sfuConsume",
        consumer: {
          consumerId: "consumer-1",
          producerId: "producer-1",
          kind: "audio",
          rtpParameters: { codecs: [{ mimeType: "audio/opus", payloadType: 100 }] },
        },
      },
    ],
  },
];

// -- coverage extensions (adversarial-review round, FR-238) ------------------

// Production join flow appends startedAt via object spread, so the room's
// startedAt key lands AFTER mediaSessionId/transport — a key order the typed
// structs (interface order) do not reproduce. Decode-only until the server
// constructs records in interface order (tracked on FR-243).
const ringingRoom = {
  id: "call-1",
  conversationId: "conv-1",
  state: "ringing" as const,
  createdBy: "user-1",
  kind: "video" as const,
  createdAt: "2026-06-10T00:00:00.000Z",
  mediaSessionId: "media-1",
  transport: "sfu",
};
const spreadActiveRoom = { ...ringingRoom, state: "active" as const, startedAt: "2026-06-10T00:00:05.000Z" };

const tooOldClient = { ...validatedProduct, schemaRevision: 1 };
const strictServer = { ...validatedProduct, schemaRevision: 5, minimumClientRevision: 3 };
const tooOldResult = compareSchemaCompatibility(tooOldClient, strictServer);

const sensitivityProduct = validateSchema({
  ...productTestSchema,
  objects: productTestSchema.objects.map((object, objectIndex) =>
    objectIndex === 0
      ? {
          ...object,
          fields: object.fields.map((field, fieldIndex) =>
            fieldIndex === 0 ? { ...field, sensitivity: "pii" as const } : field,
          ),
        }
      : object,
  ),
});

const coveredNackCodes = new Set(["storage.notFound", "schema.incompatible"]);

cases.push(
  {
    name: "subscribe-presence",
    description: "Subscribe to presence with key but no cursor",
    reencode: true,
    frame: [
      FrameKind.Subscribe,
      { subscriptionId: "sub-4", kind: "presence", name: "TypingState", key: "conv-1" },
    ],
  },
  {
    name: "subscribe-signal",
    description: "Subscribe to a signal with cursor but no key",
    reencode: true,
    frame: [
      FrameKind.Subscribe,
      { subscriptionId: "sub-5", kind: "signal", name: "WebRTCSignal", cursor: 3 },
    ],
  },
  {
    name: "subscribe-projection",
    description: "Subscribe to a projection without key/cursor",
    reencode: true,
    frame: [
      FrameKind.Subscribe,
      { subscriptionId: "sub-6", kind: "projection", name: "ConversationInbox" },
    ],
  },
  {
    name: "ack-cursor-only",
    description: "The append ack the server actually sends: requestId + cursor",
    reencode: true,
    frame: [FrameKind.Ack, { requestId: "req-a1", cursor: 7 }],
  },
  {
    name: "ack-version-only",
    description: "The object-upsert ack: requestId + version with cursor absent",
    reencode: true,
    frame: [FrameKind.Ack, { requestId: "req-a2", version: 3 }],
  },
  {
    name: "hello-caps-no-token",
    description: "The production client Hello: clientCapabilities without sessionToken",
    reencode: true,
    frame: [
      FrameKind.Hello,
      {
        replicaId: "replica-3",
        deviceId: "device-3",
        schemaHash: validatedProduct.hash,
        knownCursors: { "sub-1": 1 },
        clientCapabilities: defaultClientCapabilities({
          platform: "web",
          sdkVersion: "0.3.0",
          schema: validatedProduct,
        }),
      },
    ],
  },
  {
    name: "call-command-accept",
    description: "CallCommand accept",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      { requestId: "req-15", command: { op: "accept", callId: "call-1" } },
    ],
  },
  {
    name: "call-command-leave",
    description: "CallCommand leave",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      { requestId: "req-16", command: { op: "leave", callId: "call-1" } },
    ],
  },
  {
    name: "call-command-end",
    description: "CallCommand end",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      { requestId: "req-17", command: { op: "end", callId: "call-1" } },
    ],
  },
  {
    name: "call-command-sfu-produce",
    description: "CallCommand sfuProduce with opaque rtpParameters",
    reencode: true,
    frame: [
      FrameKind.CallCommand,
      {
        requestId: "req-18",
        command: {
          op: "sfuProduce",
          callId: "call-1",
          token: "join-nonce-1",
          transportId: "transport-1",
          kind: "audio",
          rtpParameters: { codecs: [{ mimeType: "audio/opus", payloadType: 100 }], mid: "0" },
        },
      },
    ],
  },
  {
    name: "call-command-result-accept",
    description: "CallCommandResult for accept: invite with respondedAt",
    reencode: true,
    frame: [
      FrameKind.CallCommandResult,
      {
        requestId: "req-15",
        op: "accept",
        invite: {
          id: "invite-1",
          callId: "call-1",
          inviteeUserId: "user-2",
          status: "accepted",
          invitedBy: "user-1",
          invitedAt: "2026-06-10T00:00:00.000Z",
          respondedAt: "2026-06-10T00:00:03.000Z",
        },
      },
    ],
  },
  {
    name: "call-command-result-end",
    description: "CallCommandResult for end: room with startedAt and endedAt (interface order)",
    reencode: true,
    frame: [
      FrameKind.CallCommandResult,
      {
        requestId: "req-17",
        op: "end",
        room: {
          id: "call-1",
          conversationId: "conv-1",
          state: "ended",
          createdBy: "user-1",
          kind: "video",
          createdAt: "2026-06-10T00:00:00.000Z",
          startedAt: "2026-06-10T00:00:05.000Z",
          endedAt: "2026-06-10T00:10:00.000Z",
          mediaSessionId: "media-1",
          transport: "sfu",
        },
      },
    ],
  },
  {
    name: "call-command-result-set-media-state",
    description:
      "CallCommandResult for setMediaState: participant without speaking/networkQuality/leftAt",
    reencode: true,
    frame: [
      FrameKind.CallCommandResult,
      {
        requestId: "req-12",
        op: "setMediaState",
        participant: {
          id: "participant-1",
          callId: "call-1",
          userId: "user-2",
          deviceId: "device-2",
          state: "joined",
          joinedAt: "2026-06-10T00:00:05.000Z",
          micEnabled: false,
          cameraEnabled: true,
          screenSharing: true,
        },
      },
    ],
  },
  {
    name: "call-command-result-sfu-connect",
    description: "CallCommandResult for sfuConnectTransport: requestId + op only",
    reencode: true,
    frame: [
      FrameKind.CallCommandResult,
      { requestId: "req-13", op: "sfuConnectTransport" },
    ],
  },
  {
    name: "call-command-result-sfu-produce",
    description: "CallCommandResult for sfuProduce: producer",
    reencode: true,
    frame: [
      FrameKind.CallCommandResult,
      {
        requestId: "req-18",
        op: "sfuProduce",
        producer: { producerId: "producer-2", kind: "audio" },
      },
    ],
  },
  {
    name: "call-command-result-join-production-order",
    description:
      "Join result as the server currently builds it: startedAt appended last via spread, grant without connection (decode-only; see FR-243)",
    reencode: false,
    frame: [
      FrameKind.CallCommandResult,
      {
        requestId: "req-11",
        op: "join",
        room: spreadActiveRoom,
        participant: {
          id: "participant-1",
          callId: "call-1",
          userId: "user-2",
          deviceId: "device-2",
          state: "joined",
          joinedAt: "2026-06-10T00:00:05.000Z",
          micEnabled: true,
          cameraEnabled: true,
          screenSharing: false,
        },
        mediaGrant: {
          callId: "call-1",
          mediaSessionId: "media-1",
          userId: "user-2",
          deviceId: "device-2",
          token: "grant-token-2",
          expiresAt: "2026-06-10T00:05:05.000Z",
        },
      },
    ],
  },
  {
    name: "signal-send-key-epoch",
    description: "SignalSend carrying an E2EE keyEpoch announcement (FR-156)",
    reencode: true,
    frame: [
      FrameKind.SignalSend,
      {
        requestId: "req-19",
        name: "WebRTCSignal",
        key: "call-1",
        value: {
          senderDeviceId: "device-1",
          kind: "keyEpoch",
          payload: new Uint8Array([0x4b, 0x45, 0x59]),
        },
      },
    ],
  },
  {
    name: "nack-schema-too-old",
    description: "Nack carrying a real compareSchemaCompatibility clientTooOld message",
    reencode: true,
    frame: [
      FrameKind.Nack,
      {
        requestId: "req-20",
        error: {
          code: "schema.incompatible",
          message: tooOldResult.message ?? "",
          requestId: "req-20",
          retryable: false,
          schemaHash: strictServer.hash,
          schemaRevision: strictServer.schemaRevision,
        },
      },
    ],
  },
  {
    name: "hello-ack-incompatible",
    description: "HelloAck wire shape for a compatible:false (clientTooOld) result",
    reencode: true,
    frame: [
      FrameKind.HelloAck,
      {
        schemaHash: strictServer.hash,
        schemaId: strictServer.schemaId,
        schemaRevision: strictServer.schemaRevision,
        schemaCompatibility: tooOldResult,
        serverCapabilities: defaultServerCapabilities(strictServer),
      },
    ],
  },
  {
    name: "schema-sensitivity-validated",
    description: "Schema frame with a sensitivity-annotated field (sorted key order)",
    reencode: true,
    frame: [FrameKind.Schema, sensitivityProduct],
  },
  {
    name: "ack-explicit-undefined-cursor",
    description:
      "Ack built with an explicitly-undefined cursor: @msgpack/msgpack encodes the key with nil. Rust decodes cursor→None and re-emits without the key, so this is decode-only/lossy.",
    reencode: false,
    lossy: true,
    json: [FrameKind.Ack, { requestId: "req-x", cursor: null }],
    frame: [FrameKind.Ack, { requestId: "req-x", cursor: undefined } as never],
  },
);

for (const code of FRICK_ERROR_CODES) {
  if (coveredNackCodes.has(code)) {
    continue;
  }
  cases.push({
    name: `nack-code-${code.replace(".", "-")}`,
    description: `Nack pinning the ${code} error-code wire string`,
    reencode: true,
    frame: [
      FrameKind.Nack,
      {
        requestId: "req-c",
        error: { code, message: `fixture ${code}`, requestId: "req-c", retryable: false },
      },
    ],
  });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const manifest = cases.map((entry) => {
  const bytes = encodeFrame(entry.frame);
  writeFileSync(join(outDir, `${entry.name}.bin`), bytes);
  return {
    name: entry.name,
    description: entry.description,
    kind: entry.frame[0],
    reencode: entry.reencode,
    lossy: entry.lossy ?? false,
    bin: `${entry.name}.bin`,
    json: entry.json === undefined ? toJsonSafe(entry.frame) : entry.json,
  };
});

writeFileSync(
  join(outDir, "manifest.json"),
  `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, cases: manifest }, null, 2)}\n`,
);

console.log(`wrote ${cases.length} wire fixtures to ${outDir}`);

/** JSON-safe mirror of a frame: Uint8Array → {"$bytes": base64}. */
function toJsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        result[key] = toJsonSafe(entry);
      }
    }
    return result;
  }
  return value;
}
