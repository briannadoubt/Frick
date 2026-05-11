import { describe, expect, it } from "vitest";
import {
  defaultClientCapabilities,
  defaultServerCapabilities,
  foundationSchema,
  serverCapabilityNames,
  unsupportedRequiredCapabilities,
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

  it("returns deterministic server capability names", () => {
    expect(
      serverCapabilityNames({
        ...defaultServerCapabilities(foundationSchema),
        experimental: ["alpha", "beta"],
      }),
    ).toEqual([
      "transport.websocket",
      "transport.http",
      "encoding.msgpack",
      "encoding.json",
      "primitive.objects",
      "primitive.streams",
      "primitive.presence",
      "primitive.signals",
      "primitive.blobs",
      "primitive.jobs",
      "primitive.projections",
      "blobUpload.direct",
      "experimental.alpha",
      "experimental.beta",
    ]);
  });

  it("preserves required capability order when reporting unsupported names", () => {
    const client = defaultClientCapabilities({
      platform: "web",
      sdkVersion: "0.0.0-test",
      schema: foundationSchema,
    });
    const server = defaultServerCapabilities(foundationSchema);

    expect(
      unsupportedRequiredCapabilities(
        {
          ...client,
          required: ["transport.websocket", "primitive.telepathy", "encoding.json", "push.apns"],
        },
        server,
      ),
    ).toEqual(["primitive.telepathy", "push.apns"]);
  });
});
