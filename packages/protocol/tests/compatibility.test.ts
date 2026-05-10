import { describe, expect, it } from "vitest";
import {
  compareSchemaCompatibility,
  foundationSchema,
  requireSchemaCompatibility,
} from "../src/index.js";

describe("schema compatibility", () => {
  it("accepts an exact matching schema", () => {
    expect(compareSchemaCompatibility(foundationSchema, foundationSchema)).toEqual({
      compatible: true,
      reason: "exact",
      clientRevision: 1,
      serverRevision: 1,
    });
  });

  it("rejects a different schema id", () => {
    const client = { ...foundationSchema, schemaId: "other-app" };

    expect(compareSchemaCompatibility(client, foundationSchema)).toEqual({
      compatible: false,
      reason: "schemaIdMismatch",
      clientRevision: 1,
      serverRevision: 1,
      message: "Schema id mismatch: client=other-app server=frick-foundation",
    });
  });

  it("rejects a client below the server minimum revision", () => {
    const client = { ...foundationSchema, schemaRevision: 1 };
    const server = { ...foundationSchema, schemaRevision: 3, minimumClientRevision: 2 };

    expect(compareSchemaCompatibility(client, server)).toEqual({
      compatible: false,
      reason: "clientTooOld",
      clientRevision: 1,
      serverRevision: 3,
      message: "Client schema revision 1 is below server minimum 2",
    });
  });

  it("rejects a server below the client minimum revision", () => {
    const client = { ...foundationSchema, schemaRevision: 3, minimumServerRevision: 2 };
    const server = { ...foundationSchema, schemaRevision: 1 };

    expect(compareSchemaCompatibility(client, server)).toEqual({
      compatible: false,
      reason: "serverTooOld",
      clientRevision: 3,
      serverRevision: 1,
      message: "Server schema revision 1 is below client minimum 2",
    });
  });

  it("accepts compatible revisions but reports hash mismatch", () => {
    const client = { ...foundationSchema, hash: "frick-foundation-compatible-client" };
    const server = { ...foundationSchema, hash: "frick-foundation-compatible-server" };

    expect(compareSchemaCompatibility(client, server)).toEqual({
      compatible: true,
      reason: "revisionCompatibleHashMismatch",
      clientRevision: 1,
      serverRevision: 1,
      message: "Schema revisions are compatible but hashes differ",
    });
  });

  it("throws a useful error when compatibility is required", () => {
    const client = { ...foundationSchema, schemaId: "other-app" };

    expect(() => requireSchemaCompatibility(client, foundationSchema)).toThrow(/schema id mismatch/i);
  });
});
