import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  DEFAULT_MAX_JSON_BODY_BYTES,
  JsonBodyTooLargeError,
  authenticateRequest,
  handlePreflight,
  matchPath,
  readJsonBody,
  sendJson,
  setCors,
  FrickStore,
} from "../src/index.js";
import { productTestSchema } from "@fricken/protocol";

// FR-128: the app-route helper kit. Covers CORS, JSON I/O (with the size
// guard), the :param matcher, and bearer→session principal authentication.

// A tiny ServerResponse stand-in capturing what the kit writes.
class FakeResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  ended = false;
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.ended = true;
  }
}

function makeRequest(method: string, body?: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(body !== undefined ? [Buffer.from(body, "utf8")] : []) as IncomingMessage;
  stream.method = method;
  stream.headers = headers;
  return stream;
}

describe("app-route kit: CORS", () => {
  it("setCors applies defaults and honors overrides", () => {
    const res = new FakeResponse();
    setCors(res as never);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toBe("GET,POST,OPTIONS");

    const res2 = new FakeResponse();
    setCors(res2 as never, { origin: "https://app.example", credentials: true });
    expect(res2.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(res2.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("handlePreflight answers OPTIONS with 204 and passes through others", () => {
    const res = new FakeResponse();
    expect(handlePreflight(makeRequest("OPTIONS"), res as never)).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);

    const res2 = new FakeResponse();
    expect(handlePreflight(makeRequest("GET"), res2 as never)).toBe(false);
    expect(res2.ended).toBe(false);
  });

  it("sendJson writes a JSON body with CORS + content-type", () => {
    const res = new FakeResponse();
    sendJson(res as never, 201, { ok: true });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe("app-route kit: readJsonBody", () => {
  it("parses a JSON body and returns {} for an empty body", async () => {
    expect(await readJsonBody(makeRequest("POST", '{"a":1}'))).toEqual({ a: 1 });
    expect(await readJsonBody(makeRequest("POST", ""))).toEqual({});
    expect(await readJsonBody(makeRequest("POST"))).toEqual({});
  });

  it("throws JsonBodyTooLargeError past the cap", async () => {
    const big = "x".repeat(50);
    await expect(readJsonBody(makeRequest("POST", big), { maxBytes: 10 })).rejects.toBeInstanceOf(
      JsonBodyTooLargeError,
    );
    expect(DEFAULT_MAX_JSON_BODY_BYTES).toBe(1024 * 1024);
  });
});

describe("app-route kit: matchPath", () => {
  it("captures :params and rejects mismatches", () => {
    expect(matchPath("/api/plan/:id/run", "/api/plan/42/run")).toEqual({ id: "42" });
    expect(matchPath("/api/plan/:id", "/api/plan/a%2Fb")).toEqual({ id: "a/b" });
    expect(matchPath("/api/plan/:id", "/api/plan/1/extra")).toBeNull();
    expect(matchPath("/api/plan", "/api/widget")).toBeNull();
  });
});

describe("app-route kit: authenticateRequest", () => {
  let store: FrickStore | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("resolves a live bearer token to the session principal", () => {
    store = new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
    store.sessions.create({
      sessionToken: "tok-live",
      tenantId: "_default",
      userId: "user-ada",
      deviceId: "device-ada",
      replicaId: "replica-ada",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const principal = authenticateRequest(
      store,
      makeRequest("GET", undefined, { authorization: "Bearer tok-live" }),
    );
    expect(principal).toEqual({
      userId: "user-ada",
      tenantId: "_default",
      deviceId: "device-ada",
      replicaId: "replica-ada",
    });
  });

  it("returns null for a missing, malformed, or expired token", () => {
    store = new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
    store.sessions.create({
      sessionToken: "tok-dead",
      tenantId: "_default",
      userId: "user-ada",
      deviceId: "d",
      replicaId: "r",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    expect(authenticateRequest(store, makeRequest("GET"))).toBeNull();
    expect(
      authenticateRequest(store, makeRequest("GET", undefined, { authorization: "Basic xyz" })),
    ).toBeNull();
    expect(
      authenticateRequest(store, makeRequest("GET", undefined, { authorization: "Bearer tok-dead" })),
    ).toBeNull();
  });
});
