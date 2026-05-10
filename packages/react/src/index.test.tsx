import { describe, expect, test } from "vitest";
import { createAuthorizedFetchInit, inboxEndpointPath, resolveHttpEndpoint } from "./index.js";

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

describe("authorized optional endpoint requests", () => {
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
