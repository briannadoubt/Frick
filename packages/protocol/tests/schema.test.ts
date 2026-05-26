import { describe, expect, it } from "vitest";
import {
  blobByName,
  eventByName,
  productTestSchema,
  jobByName,
  objectByName,
  presenceByName,
  projectionByName,
  resolveObjectMergePolicy,
  signalByName,
  streamByName,
  validateSchema,
} from "../src/index.js";

describe("foundation schema", () => {
  it("defines all realtime foundation primitives", () => {
    const schema = validateSchema(productTestSchema);

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
    const schema = validateSchema(productTestSchema);

    expect(schema.name).toBe("frick-product-test");
    expect(schema.schemaId).toBe("frick-product-test");
    expect(schema.schemaVersion).toBe("0.1.0");
    expect(schema.schemaRevision).toBe(1);
    expect(schema.minimumClientRevision).toBe(1);
    expect(schema.minimumServerRevision).toBe(1);
    expect(schema.hash).toMatch(/^frick-product-test-/);
    expect(schema.protocol).toBe("frick.realtime");
    expect(schema.compatibility).toBe("greenfield-cutover");
  });

  it("rejects missing or invalid schema identity metadata", () => {
    const missingSchemaId = structuredClone(productTestSchema);
    delete (missingSchemaId as Partial<typeof productTestSchema>).schemaId;

    expect(() => validateSchema(missingSchemaId)).toThrow(/schemaId/i);

    const blankSchemaId = structuredClone(productTestSchema);
    blankSchemaId.schemaId = "   ";

    expect(() => validateSchema(blankSchemaId)).toThrow(/schemaId/i);

    const blankSchemaVersion = structuredClone(productTestSchema);
    blankSchemaVersion.schemaVersion = "\t\n";

    expect(() => validateSchema(blankSchemaVersion)).toThrow(/schemaVersion/i);

    const invalidSchemaRevision = structuredClone(productTestSchema);
    invalidSchemaRevision.schemaRevision = 0;

    expect(() => validateSchema(invalidSchemaRevision)).toThrow(/schemaRevision/i);
  });

  it("allows messages to reference attachment blob metadata", () => {
    const schema = validateSchema(productTestSchema);
    const messageSent = eventByName(schema, "MessageSent");

    expect(messageSent.fields).toContainEqual({
      id: 5,
      name: "attachmentBlobIds",
      kind: "json",
      required: false,
    });
  });

  it("treats objects without an explicit mergePolicy as lastWriteWins", () => {
    const schema = validateSchema(productTestSchema);
    expect(objectByName(schema, "User").mergePolicy).toBeUndefined();
    expect(resolveObjectMergePolicy(schema, "User")).toBe("lastWriteWins");
    // Unknown types fall back to the default rather than throwing.
    expect(resolveObjectMergePolicy(schema, "NoSuchObject")).toBe("lastWriteWins");
  });

  it("accepts schemas that declare a versionPrecondition mergePolicy", () => {
    const customised = structuredClone(productTestSchema);
    customised.objects[0]!.mergePolicy = "versionPrecondition";

    const schema = validateSchema(customised);
    expect(objectByName(schema, "User").mergePolicy).toBe("versionPrecondition");
    expect(resolveObjectMergePolicy(schema, "User")).toBe("versionPrecondition");
    // Other objects continue to default to lastWriteWins.
    expect(resolveObjectMergePolicy(schema, "Conversation")).toBe("lastWriteWins");
  });

  it("rejects duplicate field ids within a type", () => {
    const invalid = structuredClone(productTestSchema);
    invalid.objects[0]!.fields.push({
      id: 1,
      name: "duplicateDisplayName",
      kind: "string",
      required: false,
    });

    expect(() => validateSchema(invalid)).toThrow(/duplicate field id/i);
  });
});
