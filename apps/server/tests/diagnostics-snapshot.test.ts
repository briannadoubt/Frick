/**
 * FR-76: structured diagnostics snapshot assembler.
 *
 * Covers the store-driven assembly path: schema identity, cache metadata, sync
 * timing, cursor probes, and — the spec-mandated guarantee — that recent error
 * envelopes are redacted of anything that looks like a secret.
 */
import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { FrickStore } from "../src/store.js";
import { assembleDiagnosticsSnapshot } from "../src/diagnostics.js";

let store: FrickStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function freshStore(): FrickStore {
  return new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
}

describe("assembleDiagnosticsSnapshot", () => {
  it("captures schema identity, cache metadata, and sync timing", async () => {
    store = freshStore();
    const snapshot = await assembleDiagnosticsSnapshot(store, {
      env: "development",
      now: () => new Date("2026-06-07T00:00:00.000Z"),
    });

    expect(snapshot.diagnosticsVersion).toBe(1);
    expect(snapshot.source).toBe("cli");
    expect(snapshot.env).toBe("development");
    expect(snapshot.schema.schemaId).toBe(productTestSchema.schemaId);
    expect(snapshot.schema.schemaRevision).toBe(productTestSchema.schemaRevision);
    expect(snapshot.schema.schemaHash).toBe(productTestSchema.hash);
    expect(snapshot.syncTiming.snapshotAt).toBe("2026-06-07T00:00:00.000Z");

    const idempotency = snapshot.caches.find((c) => c.name === "idempotency");
    expect(idempotency).toBeDefined();
    expect(typeof idempotency?.size).toBe("number");
    expect(typeof idempotency?.capacity).toBe("number");
  });

  it("reports a schema-compatibility verdict", async () => {
    store = freshStore();
    const snapshot = await assembleDiagnosticsSnapshot(store);
    // No migrations ledger on an in-memory product-schema store => unmatched.
    expect(snapshot.compatibility).toBeDefined();
    expect(snapshot.compatibility?.expectedRevision).toBe(productTestSchema.schemaRevision);
    expect(typeof snapshot.compatibility?.matched).toBe("boolean");
  });

  it("probes requested stream cursors and skips unknown ones", async () => {
    store = freshStore();
    for (let i = 1; i <= 3; i++) {
      await store.appendEvent({
        requestId: `req-${i}`,
        replicaId: "replica-1",
        stream: "MessageStream",
        streamId: "conversation-general",
        event: "MessageSent",
        payload: {
          messageId: `m-${i}`,
          senderId: "user-ada",
          body: `msg ${i}`,
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      });
    }

    const snapshot = await assembleDiagnosticsSnapshot(store, {
      cursors: [
        { stream: "MessageStream", streamId: "conversation-general" },
        { stream: "MessageStream", streamId: "does-not-exist" },
      ],
    });

    const known = snapshot.cursors?.find((c) => c.streamId === "conversation-general");
    expect(known).toBeDefined();
    expect(known?.count).toBe(3);
    expect(known?.headSequence).toBe(3);
    // An empty/unknown stream head returns count 0 — still a valid cursor row.
    const unknown = snapshot.cursors?.find((c) => c.streamId === "does-not-exist");
    expect(unknown?.count).toBe(0);
  });

  it("surfaces recent error envelopes and ignores successful events", async () => {
    store = freshStore();
    await store.devtoolsEvents.record({
      kind: "http.request",
      fields: { requestId: "r1", method: "GET", path: "/ok", status: 200 },
    });
    await store.devtoolsEvents.record({
      kind: "http.request",
      fields: { requestId: "r2", method: "POST", path: "/boom", status: 500 },
    });
    await store.devtoolsEvents.record({
      kind: "job.failed",
      fields: { jobType: "sendEmail", jobId: 7, errorCode: "smtp.timeout" },
    });

    const snapshot = await assembleDiagnosticsSnapshot(store);
    const codes = snapshot.recentErrors.map((e) => e.code);
    expect(codes).toContain("http.500");
    expect(codes).toContain("smtp.timeout");
    expect(codes).not.toContain("http.200");
  });

  it("redacts secrets out of recent error context", async () => {
    store = freshStore();
    await store.devtoolsEvents.record({
      kind: "auth.failed",
      fields: {
        requestId: "r9",
        userId: "user-ada",
        password: "hunter2",
        sessionToken: "tok_live_should_never_leak",
        authorization: "Bearer abc.def.ghi",
        apiKey: "sk-secret",
      },
    });

    const snapshot = await assembleDiagnosticsSnapshot(store);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("tok_live_should_never_leak");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("sk-secret");

    const envelope = snapshot.recentErrors.find((e) => e.code === "auth.failed");
    expect(envelope).toBeDefined();
    expect(envelope?.context?.password).toBe("<redacted>");
    expect(envelope?.context?.sessionToken).toBe("<redacted>");
    expect(envelope?.context?.authorization).toBe("<redacted>");
    expect(envelope?.context?.apiKey).toBe("<redacted>");
    // Non-secret fields survive.
    expect(envelope?.context?.userId).toBe("user-ada");
  });

  it("includes runtime gateway surfaces when provided", async () => {
    store = freshStore();
    const snapshot = await assembleDiagnosticsSnapshot(store, {
      runtime: {
        source: "server",
        startedAt: "2026-06-07T00:00:00.000Z",
        uptimeSeconds: 42,
        connection: { status: "connected", transport: "websocket", activeConnections: 3 },
        subscriptions: [{ target: "MessageStream", deliveredThrough: 10 }],
        pendingAppends: [{ requestId: "p1", stream: "MessageStream", state: "inflight" }],
      },
    });

    expect(snapshot.source).toBe("server");
    expect(snapshot.connection?.activeConnections).toBe(3);
    expect(snapshot.subscriptions).toHaveLength(1);
    expect(snapshot.pendingAppends?.[0]?.state).toBe("inflight");
    expect(snapshot.syncTiming.uptimeSeconds).toBe(42);
  });
});
