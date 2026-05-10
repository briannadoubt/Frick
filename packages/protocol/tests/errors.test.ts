import { describe, expect, it } from "vitest";
import { createFrickErrorEnvelope, isFrickErrorEnvelope } from "../src/index.js";

describe("frick error envelopes", () => {
  it("creates stable safe error envelopes", () => {
    expect(
      createFrickErrorEnvelope({
        code: "schema.incompatible",
        message: "Schema mismatch",
        requestId: "request-1",
        retryable: false,
        details: { reason: "hashMismatch" },
        schemaRevision: 1,
      }),
    ).toEqual({
      code: "schema.incompatible",
      message: "Schema mismatch",
      requestId: "request-1",
      retryable: false,
      details: { reason: "hashMismatch" },
      schemaRevision: 1,
    });
  });

  it("recognizes valid envelopes and rejects arbitrary objects", () => {
    expect(
      isFrickErrorEnvelope({
        code: "auth.unauthenticated",
        message: "Sign in required",
        requestId: "request-2",
        retryable: false,
      }),
    ).toBe(true);

    expect(isFrickErrorEnvelope({ code: "auth.unauthenticated" })).toBe(false);
  });

  it("rejects unknown error codes and invalid optional fields", () => {
    const valid = {
      code: "schema.incompatible",
      message: "Schema mismatch",
      requestId: "request-3",
      retryable: false,
    };

    expect(isFrickErrorEnvelope({ ...valid, code: "schema.surprise" })).toBe(false);
    expect(isFrickErrorEnvelope({ ...valid, details: null })).toBe(false);
    expect(isFrickErrorEnvelope({ ...valid, details: "hash mismatch" })).toBe(false);
    expect(isFrickErrorEnvelope({ ...valid, schemaHash: 123 })).toBe(false);
    expect(isFrickErrorEnvelope({ ...valid, schemaRevision: 1.5 })).toBe(false);
    expect(isFrickErrorEnvelope({ ...valid, schemaRevision: "1" })).toBe(false);
    expect(
      isFrickErrorEnvelope({
        ...valid,
        details: { reason: "hashMismatch" },
        schemaHash: "hash",
        schemaRevision: 1,
      }),
    ).toBe(true);
  });
});
