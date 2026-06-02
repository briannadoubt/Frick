import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, isFrickErrorEnvelope, type FrickErrorCode } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("HTTP error envelopes", () => {
  it("returns an auth envelope for missing auth on objects", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/objects`);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error).toMatchObject({
      code: "auth.unauthenticated",
      message: "Missing session token",
      requestId: "unauthorized",
      retryable: false,
      schemaHash: foundationSchema.hash,
      schemaRevision: foundationSchema.schemaRevision,
    });
    expect(body.code).toBe(body.error.code);
    expect(body.message).toBe(body.error.message);
    expect(body.requestId).toBe(body.error.requestId);
    expect(body.retryable).toBe(body.error.retryable);
  });

  it("returns a forbidden envelope for blob owner mismatches", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/blobs/blob-owner-spoof/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(login.sessionToken) },
      body: Buffer.from("not ada's blob"),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error).toMatchObject({
      code: "auth.forbidden",
      message: "Blob ownerId must match the principal",
      requestId: "blob_content_rejected",
      retryable: false,
      schemaHash: foundationSchema.hash,
      schemaRevision: foundationSchema.schemaRevision,
    });
    expect(body.code).toBe("auth.forbidden");
    expect(body.message).toBe(body.error.message);
  });

  it("returns a framework error envelope for invalid signup bodies", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "ada" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(validFrameworkErrorCodes).toContain(body.error.code);
    expect(body.error).toMatchObject({
      message: "displayName must be a non-empty string",
      requestId: "signup_rejected",
      retryable: false,
      schemaHash: foundationSchema.hash,
      schemaRevision: foundationSchema.schemaRevision,
    });
    expect(body.message).toBe(body.error.message);
  });
});

const validFrameworkErrorCodes: FrickErrorCode[] = ["server.internal", "sync.protocolError"];

async function startServer() {
  const server = createFrickServer({ port: 0, dbPath: ":memory:" });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{ sessionToken: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string };
}

function authHeaders(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}
