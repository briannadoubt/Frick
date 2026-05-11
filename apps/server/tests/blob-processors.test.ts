/**
 * End-to-end tests for the blob processor pipeline: synchronous validators
 * gating upload, asynchronous derivative generation via the job worker, and
 * the HTTP routes that expose derivatives back to clients.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import type { FrickBlobProcessor } from "../src/blobs/processor.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startServer(processors: FrickBlobProcessor[]) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    blobProcessors: processors,
    jobs: { workerEnabled: true, pollIntervalMs: 10 },
  });
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

async function devLogin(httpUrl: string, userId: string, tenantId?: string) {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, ...(tenantId !== undefined ? { tenantId } : {}) }),
  });
  return (await response.json()) as { sessionToken: string; userId: string; tenantId: string };
}

async function uploadBlob(
  httpUrl: string,
  sessionToken: string,
  blobId: string,
  body: Buffer | string,
  mimeType: string,
  ownerId: string,
): Promise<Response> {
  return fetch(
    `${httpUrl}/blobs/${encodeURIComponent(blobId)}/content?ownerId=${encodeURIComponent(ownerId)}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": mimeType,
      },
      body,
    },
  );
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("waitFor timeout");
}

describe("blob processor pipeline", () => {
  it("rejects uploads when a registered validator returns ok: false", async () => {
    const rejecting: FrickBlobProcessor = {
      id: "reject-text",
      matches: { mimePrefixes: ["text/"] },
      async validate() {
        return { ok: false, reason: "text uploads forbidden" };
      },
    };
    app = await startServer([rejecting]);
    const session = await devLogin(app.httpUrl, "user-ada");

    const response = await uploadBlob(
      app.httpUrl,
      session.sessionToken,
      "blob-reject-1",
      "hello world",
      "text/plain",
      session.userId,
    );

    expect(response.status).toBe(415);
    const body = (await response.json()) as {
      code: string;
      error: { code: string; details?: { processorId?: string; rejectionReason?: string } };
    };
    expect(body.code).toBe("blob.unsupportedContentType");
    expect(body.error.details?.processorId).toBe("reject-text");
    expect(body.error.details?.rejectionReason).toBe("text uploads forbidden");

    // The metadata row must not have been created.
    expect(app.store.blobs.read(session.tenantId, "blob-reject-1")).toBeUndefined();
  });

  it("runs async processors and persists derivative rows", async () => {
    const echo: FrickBlobProcessor = {
      id: "echo",
      matches: { mimePrefixes: ["text/"] },
      async process(ctx) {
        const bytes = Buffer.from(`processed:${ctx.byteLength}`);
        return {
          derivatives: [
            {
              derivativeId: "echo-1",
              mimeType: "text/plain",
              bytes,
              metadata: { sourceByteLength: ctx.byteLength },
            },
          ],
        };
      },
    };
    app = await startServer([echo]);
    const session = await devLogin(app.httpUrl, "user-ada");

    const upload = await uploadBlob(
      app.httpUrl,
      session.sessionToken,
      "blob-async-1",
      "hello",
      "text/plain",
      session.userId,
    );
    expect(upload.status).toBe(201);

    // Wait for the worker to claim and complete the blob.process job.
    const derivatives = await waitFor(() => {
      const list = app!.store.blobDerivatives.listForParent("blob-async-1", session.tenantId);
      return list.length > 0 ? list : undefined;
    });
    expect(derivatives).toHaveLength(1);
    const derivative = derivatives[0]!;
    expect(derivative.derivativeId).toBe("echo-1");
    expect(derivative.processorId).toBe("echo");
    expect(derivative.mimeType).toBe("text/plain");
    expect(derivative.metadata).toEqual({ sourceByteLength: 5 });

    // List endpoint surfaces the derivative.
    const listResponse = await fetch(
      `${app.httpUrl}/blobs/${encodeURIComponent("blob-async-1")}/derivatives`,
      { headers: { authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      derivatives: Array<{ derivativeId: string; processorId: string }>;
    };
    expect(listBody.derivatives.map((d) => d.derivativeId)).toEqual(["echo-1"]);

    // Content endpoint returns bytes with correct mime + ETag.
    const contentResponse = await fetch(
      `${app.httpUrl}/blobs/${encodeURIComponent("blob-async-1")}/derivatives/echo-1/content`,
      { headers: { authorization: `Bearer ${session.sessionToken}` } },
    );
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get("content-type")).toBe("text/plain");
    expect(contentResponse.headers.get("etag")).toMatch(/^"sha256-[0-9a-f]+"$/);
    const buf = Buffer.from(await contentResponse.arrayBuffer());
    expect(buf.toString("utf8")).toBe("processed:5");
  });

  it("returns 404 when a different tenant tries to fetch derivatives", async () => {
    const echo: FrickBlobProcessor = {
      id: "echo-x",
      matches: { mimePrefixes: ["text/"] },
      async process() {
        return {
          derivatives: [
            { derivativeId: "d1", mimeType: "text/plain", bytes: Buffer.from("x") },
          ],
        };
      },
    };
    app = await startServer([echo]);
    const owner = await devLogin(app.httpUrl, "user-ada", "tenant-a");
    const stranger = await devLogin(app.httpUrl, "user-grace", "tenant-b");

    const upload = await uploadBlob(
      app.httpUrl,
      owner.sessionToken,
      "blob-iso-1",
      "abc",
      "text/plain",
      owner.userId,
    );
    expect(upload.status).toBe(201);
    await waitFor(() => {
      const list = app!.store.blobDerivatives.listForParent("blob-iso-1", owner.tenantId);
      return list.length > 0 ? list : undefined;
    });

    const crossList = await fetch(
      `${app.httpUrl}/blobs/${encodeURIComponent("blob-iso-1")}/derivatives`,
      { headers: { authorization: `Bearer ${stranger.sessionToken}` } },
    );
    expect(crossList.status).toBe(404);

    const crossContent = await fetch(
      `${app.httpUrl}/blobs/${encodeURIComponent("blob-iso-1")}/derivatives/d1/content`,
      { headers: { authorization: `Bearer ${stranger.sessionToken}` } },
    );
    expect(crossContent.status).toBe(404);
  });

  it("surfaces validator-extracted metadata via a derivative row with no bytes", async () => {
    // The blob_metadata row doesn't carry arbitrary metadata today — to keep
    // that schema invariant, processors persist extracted metadata via a
    // zero-byte sidecar derivative whose `metadata` column holds the data.
    const extractor: FrickBlobProcessor = {
      id: "size-meta",
      matches: { mimePrefixes: ["text/"] },
      async process(ctx) {
        return {
          derivatives: [
            {
              derivativeId: "size-meta",
              mimeType: "application/json",
              bytes: Buffer.alloc(0),
              metadata: { byteLength: ctx.byteLength },
            },
          ],
        };
      },
    };
    app = await startServer([extractor]);
    const session = await devLogin(app.httpUrl, "user-ada");
    const upload = await uploadBlob(
      app.httpUrl,
      session.sessionToken,
      "blob-meta-1",
      "1234567",
      "text/plain",
      session.userId,
    );
    expect(upload.status).toBe(201);

    const derivatives = await waitFor(() => {
      const list = app!.store.blobDerivatives.listForParent("blob-meta-1", session.tenantId);
      return list.length > 0 ? list : undefined;
    });
    expect(derivatives[0]?.metadata).toEqual({ byteLength: 7 });
  });
});
