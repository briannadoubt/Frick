import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("authorization denial envelopes", () => {
  it("returns 401 unauthenticated for object reads without a session", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/objects`);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.unauthenticated");
    expect(body.error.details.reason).toBe("unauthenticated");
  });

  it("denies non-members reading another conversation's stream with reason notMember", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });

    const response = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general`, {
      headers: authHeaders(malloryLogin.sessionToken),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notMember");
  });

  it("denies non-members appending to another conversation's stream with reason notMember", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });

    const response = await fetch(`${app.httpUrl}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(malloryLogin.sessionToken) },
      body: JSON.stringify({
        requestId: "request-mallory-denied",
        replicaId: "replica-mallory",
        stream: "MessageStream",
        key: "conversation-general",
        event: "MessageSent",
        payload: {
          messageId: "message-mallory-denied",
          senderId: "user-mallory",
          body: "nope",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notMember");
  });

  it("denies blob uploads with mismatched ownerId via ownerMismatch", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/blobs/blob-spoof/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(login.sessionToken) },
      body: Buffer.from("not ada's blob"),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("ownerMismatch");
  });

  it("denies reading another user's blob content and metadata with reason ownerMismatch", async () => {
    app = await startServer();
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });
    const graceLogin = await devLogin(app.httpUrl, { userId: "user-grace" });

    // Grace uploads a blob she owns.
    const blobBody = Buffer.from("grace's secret");
    const upload = await fetch(`${app.httpUrl}/blobs/blob-grace-secret/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(graceLogin.sessionToken) },
      body: blobBody,
    });
    expect(upload.status).toBe(201);

    // Ada tries to fetch Grace's content.
    const contentRead = await fetch(`${app.httpUrl}/blobs/blob-grace-secret/content`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    const contentBody = await contentRead.json();
    expect(contentRead.status).toBe(403);
    expect(isFrickErrorEnvelope(contentBody.error)).toBe(true);
    expect(contentBody.error.code).toBe("auth.forbidden");
    expect(contentBody.error.details.reason).toBe("ownerMismatch");

    // Ada tries to fetch Grace's metadata.
    const metaRead = await fetch(`${app.httpUrl}/blobs/blob-grace-secret`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    const metaBody = await metaRead.json();
    expect(metaRead.status).toBe(403);
    expect(metaBody.error.details.reason).toBe("ownerMismatch");
  });

  it("allows the owner to read their own blob content and metadata", async () => {
    app = await startServer();
    const graceLogin = await devLogin(app.httpUrl, { userId: "user-grace" });

    const blobBody = Buffer.from("grace's own bytes");
    const upload = await fetch(`${app.httpUrl}/blobs/blob-grace-own/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(graceLogin.sessionToken) },
      body: blobBody,
    });
    expect(upload.status).toBe(201);

    const contentRead = await fetch(`${app.httpUrl}/blobs/blob-grace-own/content`, {
      headers: authHeaders(graceLogin.sessionToken),
    });
    expect(contentRead.status).toBe(200);
    const bytes = Buffer.from(await contentRead.arrayBuffer());
    expect(bytes.equals(blobBody)).toBe(true);

    const metaRead = await fetch(`${app.httpUrl}/blobs/blob-grace-own`, {
      headers: authHeaders(graceLogin.sessionToken),
    });
    expect(metaRead.status).toBe(200);
    const meta = await metaRead.json();
    expect(meta.ownerId).toBe("user-grace");
  });

  it("denies non-members POSTing signals to another conversation with reason notMember", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });

    const response = await fetch(`${app.httpUrl}/signals/WebRTCSignal/conversation-general`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(malloryLogin.sessionToken) },
      body: JSON.stringify({
        senderDeviceId: "device-mallory",
        kind: "offer",
        payload: "sdp-from-outsider",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notMember");
  });

  it("denies reading another user's inbox with notAuthorizedForResource", async () => {
    app = await startServer();
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/inbox?userId=user-grace`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notAuthorizedForResource");
  });
});

async function startServer() {
  const server = createFrickServer({ port: 0, dbPath: ":memory:" });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
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
