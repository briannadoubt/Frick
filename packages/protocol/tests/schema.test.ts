import { describe, expect, it } from "vitest";
import {
  blobByName,
  eventByName,
  foundationSchema,
  jobByName,
  objectByName,
  presenceByName,
  projectionByName,
  signalByName,
  streamByName,
  validateSchema,
} from "../src/index.js";

describe("foundation schema", () => {
  it("defines all realtime foundation primitives", () => {
    const schema = validateSchema(foundationSchema);

    expect(objectByName(schema, "User").id).toBe(1);
    expect(objectByName(schema, "Conversation").id).toBe(2);
    expect(objectByName(schema, "UserDevice").fields).toEqual([
      { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
      { id: 2, name: "label", kind: "string", required: false },
      { id: 3, name: "platform", kind: "enum", enumValues: ["web", "ios", "android", "server"], required: true },
      { id: 4, name: "lastSeenAt", kind: "timestamp", required: false },
    ]);
    expect(objectByName(schema, "UserSession").fields).toEqual([
      { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
      { id: 2, name: "deviceId", kind: "string", required: true },
      { id: 3, name: "replicaId", kind: "string", required: true },
      { id: 4, name: "expiresAt", kind: "timestamp", required: true },
    ]);
    expect(streamByName(schema, "MessageStream").id).toBe(1);
    expect(eventByName(schema, "MessageSent").id).toBe(1);
    expect(presenceByName(schema, "TypingState").id).toBe(1);
    expect(signalByName(schema, "WebRTCSignal").id).toBe(1);
    expect(blobByName(schema, "AttachmentBlob").id).toBe(1);
    expect(jobByName(schema, "PushNotificationJob").id).toBe(1);
    expect(projectionByName(schema, "ConversationInbox").id).toBe(1);
  });

  it("has stable schema identity metadata", () => {
    const schema = validateSchema(foundationSchema);

    expect(schema.name).toBe("frick-foundation");
    expect(schema.schemaId).toBe("frick-foundation");
    expect(schema.schemaVersion).toBe("0.1.0");
    expect(schema.schemaRevision).toBe(1);
    expect(schema.minimumClientRevision).toBe(1);
    expect(schema.minimumServerRevision).toBe(1);
    expect(schema.hash).toMatch(/^frick-foundation-/);
    expect(schema.protocol).toBe("frick.realtime");
    expect(schema.compatibility).toBe("greenfield-cutover");
  });

  it("rejects missing or invalid schema identity metadata", () => {
    const missingSchemaId = structuredClone(foundationSchema);
    delete (missingSchemaId as Partial<typeof foundationSchema>).schemaId;

    expect(() => validateSchema(missingSchemaId)).toThrow(/schemaId/i);

    const blankSchemaId = structuredClone(foundationSchema);
    blankSchemaId.schemaId = "   ";

    expect(() => validateSchema(blankSchemaId)).toThrow(/schemaId/i);

    const blankSchemaVersion = structuredClone(foundationSchema);
    blankSchemaVersion.schemaVersion = "\t\n";

    expect(() => validateSchema(blankSchemaVersion)).toThrow(/schemaVersion/i);

    const invalidSchemaRevision = structuredClone(foundationSchema);
    invalidSchemaRevision.schemaRevision = 0;

    expect(() => validateSchema(invalidSchemaRevision)).toThrow(/schemaRevision/i);
  });

  it("allows messages to reference attachment blob metadata", () => {
    const schema = validateSchema(foundationSchema);
    const messageSent = eventByName(schema, "MessageSent");

    expect(messageSent.fields).toContainEqual({
      id: 5,
      name: "attachmentBlobIds",
      kind: "json",
      required: false,
    });
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
