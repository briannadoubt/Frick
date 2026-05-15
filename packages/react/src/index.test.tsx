import { describe, expect, test } from "vitest";
import {
  createAuthorizedFetchInit,
  frickHttpUrl,
  inboxEndpointPath,
  resolveHttpEndpoint,
  useProjection,
  useProjectionRows,
} from "./index.js";
import { FrickClient } from "@frick/core";
import { foundationSchema } from "@frick/protocol";

describe("resolveHttpEndpoint", () => {
  test("maps the default websocket sync URL to the HTTP origin", () => {
    expect(resolveHttpEndpoint("ws://127.0.0.1:4099/_frick/sync")).toBe("http://127.0.0.1:4099");
  });

  test("preserves explicit HTTP endpoint overrides", () => {
    expect(resolveHttpEndpoint("https://api.example.test/frick")).toBe("https://api.example.test/frick");
  });
});

describe("inboxEndpointPath", () => {
  test("scopes inbox requests to the configured user id", () => {
    expect(inboxEndpointPath("user-ada")).toBe("/inbox?userId=user-ada");
  });

  test("encodes user ids safely for query strings", () => {
    expect(inboxEndpointPath("user+space@example.test")).toBe("/inbox?userId=user%2Bspace%40example.test");
  });
});

describe("useProjection", () => {
  test("exposes the FrickClient projection signal as a row map", () => {
    // The hook is a thin wrapper over `client.projection(name)`. Verify the
    // wiring through the underlying client so we don't need a full DOM
    // renderer in the framework's smoke tests — a project app can cover the
    // hook with a real render in its own test suite.
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema });
    expect(typeof useProjection).toBe("function");
    expect(typeof useProjectionRows).toBe("function");
    const signal = client.projection<{ unreadCount: number }>("conversation-inbox");
    signal.set(
      new Map([
        ["user-ada:conversation-general", { unreadCount: 2 }],
        ["user-grace:conversation-general", { unreadCount: 0 }],
      ]),
    );
    expect(signal.value.size).toBe(2);
    expect(signal.value.get("user-ada:conversation-general")?.unreadCount).toBe(2);
    // Subsequent calls return the same signal instance — the hook relies on
    // this to keep referential equality stable across renders.
    expect(client.projection("conversation-inbox")).toBe(signal);
  });
});

describe("authorized optional endpoint requests", () => {
  test("builds optional endpoint URLs relative to the configured HTTP endpoint", () => {
    expect(frickHttpUrl("https://api.example.test/frick", "/inbox?userId=user-ada").toString()).toBe(
      "https://api.example.test/frick/inbox?userId=user-ada",
    );
  });

  test("rejects absolute optional endpoint paths before bearer tokens are attached", () => {
    expect(() => frickHttpUrl("https://api.example.test", "https://evil.example/collect")).toThrow(
      /relative paths/,
    );
  });

  test("rejects scheme-relative optional endpoint paths before bearer tokens are attached", () => {
    expect(() => frickHttpUrl("https://api.example.test", "//evil.example/collect")).toThrow(
      /relative paths/,
    );
  });

  test("rejects schemed optional endpoint paths before bearer tokens are attached", () => {
    expect(() => frickHttpUrl("https://api.example.test", "javascript:alert(1)")).toThrow(
      /relative paths/,
    );
  });

  test("adds a bearer token when a session token is available", () => {
    expect(
      createAuthorizedFetchInit({
        sessionToken: "session-token-123",
        userId: "user-ada",
        deviceId: "device-web",
        replicaId: "replica-web",
        schemaHash: "schema-hash",
        expiresAt: "2026-05-09T13:00:00.000Z",
      }),
    ).toEqual({
      headers: {
        Authorization: "Bearer session-token-123",
      },
    });
  });
});
