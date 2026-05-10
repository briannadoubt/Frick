import { describe, expect, it } from "vitest";
import {
  defaultClientCapabilities,
  defaultServerCapabilities,
  foundationSchema,
} from "../src/index.js";

describe("capability negotiation metadata", () => {
  it("builds conservative client capabilities", () => {
    expect(
      defaultClientCapabilities({
        platform: "web",
        sdkVersion: "0.0.0-test",
        schema: foundationSchema,
      }),
    ).toEqual({
      platform: "web",
      sdkVersion: "0.0.0-test",
      schema: {
        schemaId: "frick-foundation",
        schemaRevision: 1,
        schemaHash: foundationSchema.hash,
      },
      transports: ["websocket"],
      encodings: ["msgpack"],
      primitives: ["objects", "streams", "presence", "signals"],
      offline: { cache: true, pendingAppends: true },
      blobUploads: ["direct"],
      push: [],
      experimental: [],
      required: [],
    });
  });

  it("builds conservative server capabilities", () => {
    expect(defaultServerCapabilities(foundationSchema)).toEqual({
      schema: {
        schemaId: "frick-foundation",
        schemaRevision: 1,
        schemaHash: foundationSchema.hash,
      },
      transports: ["websocket", "http"],
      encodings: ["msgpack", "json"],
      primitives: ["objects", "streams", "presence", "signals", "blobs", "jobs", "projections"],
      blobUploads: ["direct"],
      push: [],
      experimental: [],
      limits: {},
    });
  });
});
