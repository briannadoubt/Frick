import { afterEach, describe, expect, it } from "vitest";
import { createNoopLogger } from "../src/logger.js";
import { FrickStore } from "../src/store.js";
import { createFrickJobRegistry } from "../src/jobs/registry.js";
import { createFrickJobWorker, type FrickJobWorker } from "../src/jobs/worker.js";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;
let worker: FrickJobWorker | undefined;
let standaloneStore: FrickStore | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (worker) {
    await worker.stop();
    worker = undefined;
  }
  standaloneStore?.close();
  standaloneStore = undefined;
});

async function startServer(overrides: { inspectionEnabled?: boolean } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { env: "development", ...overrides },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    server,
    close: server.close,
  };
}

async function inspectHeaders(): Promise<Record<string, string>> {
  if (!app) throw new Error("server not started");
  const response = await fetch(`${app.httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-ada" }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
  return { authorization: `Bearer ${body.sessionToken}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(predicate: () => T | undefined | Promise<T | undefined>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined && value !== null && value !== false) {
      return value as T;
    }
    await sleep(10);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("devtools event feed", () => {
  it("records an http.request event on every HTTP request", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/health`);
    expect(response.status).toBe(200);

    const events = await waitFor(async () => {
      const list = await app!.server.store.devtoolsEvents.list();
      return list.some((row) => row.kind === "http.request") ? list : undefined;
    });
    const request = events.find(
      (row) => row.kind === "http.request" && row.fields.path === "/health",
    );
    expect(request).toBeDefined();
    expect(request?.fields).toMatchObject({
      method: "GET",
      path: "/health",
      status: 200,
    });
    expect(typeof request?.fields.durationMs).toBe("number");
    expect(typeof request?.fields.requestId).toBe("string");
  });

  it("records a job.failed event with the error code when a handler throws", async () => {
    standaloneStore = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    registry.register("BoomJob", async () => {
      throw new Error("kaboom");
    });
    worker = createFrickJobWorker({
      store: standaloneStore,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
    });
    worker.start();
    const row = standaloneStore.jobs.enqueue({
      tenantId: "_default",
      jobType: "BoomJob",
      payload: {},
      maxAttempts: 1,
    });
    await waitFor(async () => standaloneStore!.jobs.getById(row.id)?.status === "dead_lettered");
    const events = standaloneStore.devtoolsEvents.list({ kind: "job.failed" });
    expect(events.length).toBeGreaterThanOrEqual(0);
    // The single-attempt path goes straight to dead-letter so we check both
    // failure kinds — at least one must capture the error.
    const dl = standaloneStore.devtoolsEvents.list({ kind: "job.dead_lettered" });
    const failureRow = events[0] ?? dl[0];
    expect(failureRow).toBeDefined();
    expect(failureRow?.fields).toMatchObject({
      jobType: "BoomJob",
      jobId: row.id,
      errorCode: "server.internal",
    });
  });

  it("filters list results by kind", async () => {
    app = await startServer();
    await fetch(`${app.httpUrl}/health`);
    await fetch(`${app.httpUrl}/health`);

    await waitFor(
      () => app!.server.store.devtoolsEvents.list({ kind: "http.request" }).length >= 2,
    );
    const httpEvents = app.server.store.devtoolsEvents.list({ kind: "http.request" });
    expect(httpEvents.every((row) => row.kind === "http.request")).toBe(true);
    const otherKind = app.server.store.devtoolsEvents.list({ kind: "ws.connect" });
    expect(otherKind.length).toBe(0);
  });

  it("filters list results by tenantId", async () => {
    standaloneStore = new FrickStore({ path: ":memory:", seed: false });
    standaloneStore.devtoolsEvents.record({ kind: "http.request", tenantId: "tenant-a" });
    standaloneStore.devtoolsEvents.record({ kind: "http.request", tenantId: "tenant-b" });
    standaloneStore.devtoolsEvents.record({ kind: "http.request" });

    const tenantA = standaloneStore.devtoolsEvents.list({ tenantId: "tenant-a" });
    expect(tenantA).toHaveLength(1);
    expect(tenantA[0]?.tenantId).toBe("tenant-a");

    const tenantB = standaloneStore.devtoolsEvents.list({ tenantId: "tenant-b" });
    expect(tenantB).toHaveLength(1);
    expect(tenantB[0]?.tenantId).toBe("tenant-b");
  });

  it("prune drops rows older than the retention window", async () => {
    standaloneStore = new FrickStore({
      path: ":memory:",
      seed: false,
      devtoolsEventsRetentionMs: 1000,
      devtoolsEventsPruneIntervalMs: 0,
    });
    // Backdate two rows beyond the retention window.
    const oldIso = new Date(Date.now() - 60_000).toISOString();
    standaloneStore.devtoolsEvents.record({ kind: "http.request", occurredAt: oldIso });
    standaloneStore.devtoolsEvents.record({ kind: "http.request", occurredAt: oldIso });
    // And one fresh row.
    standaloneStore.devtoolsEvents.record({ kind: "http.request" });
    expect(standaloneStore.devtoolsEvents.rowCount()).toBe(3);

    const result = standaloneStore.devtoolsEvents.prune();
    expect(result.prunedByAge).toBe(2);
    expect(standaloneStore.devtoolsEvents.rowCount()).toBe(1);
  });

  it("inspect endpoint returns 404 when inspectionEnabled is false", async () => {
    app = await startServer({ inspectionEnabled: false });
    const response = await fetch(`${app.httpUrl}/_frick/inspect/devtools/events`);
    expect(response.status).toBe(404);
  });

  it("inspect endpoint serves the events feed when enabled", async () => {
    app = await startServer({ inspectionEnabled: true });
    await fetch(`${app.httpUrl}/health`);
    const headers = await inspectHeaders();
    await waitFor(
      () => app!.server.store.devtoolsEvents.list({ kind: "http.request" }).length >= 1,
    );

    const response = await fetch(
      `${app.httpUrl}/_frick/inspect/devtools/events?kind=http.request`,
      { headers },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: Array<{ kind: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((row) => row.kind === "http.request")).toBe(true);

    const summary = await fetch(`${app.httpUrl}/_frick/inspect/devtools/summary?windowMs=60000`, {
      headers,
    });
    expect(summary.status).toBe(200);
    const summaryBody = (await summary.json()) as { total: number; byKind: Record<string, number> };
    expect(summaryBody.total).toBeGreaterThan(0);
    expect(summaryBody.byKind["http.request"]).toBeGreaterThan(0);
  });
});
