import { defaultClientCapabilities } from "./capabilities.js";
import { createFrickErrorEnvelope } from "./errors.js";
import { FrameKind, type FrickFrame } from "./frame.js";
import { foundationSchema } from "./foundation.js";

export function foundationSchemaFixture() {
  return foundationSchema;
}

export function errorEnvelopeFixture() {
  return createFrickErrorEnvelope({
    code: "schema.incompatible",
    message: "Fixture schema mismatch",
    requestId: "fixture-error",
    retryable: false,
    details: { reason: "fixture" },
    schemaHash: foundationSchema.hash,
    schemaRevision: foundationSchema.schemaRevision,
  });
}

export function helloFrameFixture(): FrickFrame {
  return [
    FrameKind.Hello,
    {
      replicaId: "fixture-replica",
      deviceId: "fixture-device",
      schemaHash: foundationSchema.hash,
      knownCursors: {},
      clientCapabilities: defaultClientCapabilities({
        platform: "test",
        sdkVersion: "0.0.0-fixture",
        schema: foundationSchema,
      }),
    },
  ];
}
