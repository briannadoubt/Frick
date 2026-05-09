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
