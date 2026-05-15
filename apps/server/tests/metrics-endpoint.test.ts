import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  foundationSchema,
  type FrickFrame,
} from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface MetricEntry {
  name: string;
  fields?: Record<string, string>;
  value: number;
}

function findCounter(
  counters: MetricEntry[],
  name: string,
  fields?: Record<string, string>,
): MetricEntry | undefined {
  return counters.find((entry) => {
    if (entry.name !== name) return false;
    if (!fields) return true;
    if (!entry.fields) return false;
    return Object.entries(fields).every(([k, v]) => entry.fields![k] === v);
  });
}

describe("/_frick/inspect/metrics endpoint", () => {
  it("reports http request counters by method and status", async () => {
    app = await startServer();
    // generate a few requests
    await fetch(`${app.httpUrl}/health`);
    await fetch(`${app.httpUrl}/health`);

    const headers = await inspectHeaders(app.httpUrl);
    const response = await fetch(`${app.httpUrl}/_frick/inspect/metrics`, { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      snapshotAt: string;
      uptimeSeconds: number;
      counters: MetricEntry[];
      gauges: MetricEntry[];
    };
    expect(typeof body.snapshotAt).toBe("string");
    expect(body.uptimeSeconds).toBeGreaterThan(0);
    const hit = findCounter(body.counters, "frick.http.requests.total", {
      method: "GET",
      status: "200",
    });
    expect(hit).toBeDefined();
    expect(hit!.value).toBeGreaterThan(0);
  });

  it("records frick.http.errors.total when a 401 envelope is returned", async () => {
    app = await startServer();
    // Hit a protected route without a token -> 401 envelope, auth.unauthenticated.
    const r = await fetch(`${app.httpUrl}/objects?type=Conversation`);
    expect(r.status).toBe(401);

    const headers = await inspectHeaders(app.httpUrl);
    const response = await fetch(`${app.httpUrl}/_frick/inspect/metrics`, { headers });
    const body = (await response.json()) as { counters: MetricEntry[] };
    const err = findCounter(body.counters, "frick.http.errors.total", {
      code: "auth.unauthenticated",
    });
    expect(err).toBeDefined();
    expect(err!.value).toBeGreaterThan(0);
  });

  it("tracks ws connection gauge and frame counter, and resets gauge on close", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });
    const socket = await connect(app.wsUrl, login.sessionToken);

    // Allow the gateway "connection" event a tick to fire.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const frames: FrickFrame[] = [];
    socket.on("message", (data) => frames.push(decodeFrame(data as Buffer)));

    socket.send(
      encodeFrame([
        FrameKind.Hello,
        {
          replicaId: login.replicaId,
          deviceId: login.deviceId,
          schemaHash: foundationSchema.hash,
          knownCursors: {},
        },
      ]),
    );
    await waitForFrameCount(frames, 2);

    const headers = { authorization: `Bearer ${login.sessionToken}` };
    let response = await fetch(`${app.httpUrl}/_frick/inspect/metrics`, { headers });
    let body = (await response.json()) as { counters: MetricEntry[]; gauges: MetricEntry[] };
    const gaugeOpen = body.gauges.find((g) => g.name === "frick.ws.connections.current");
    expect(gaugeOpen?.value).toBe(1);
    const hello = findCounter(body.counters, "frick.ws.frames.total", { kind: "Hello" });
    expect(hello).toBeDefined();
    expect(hello!.value).toBeGreaterThan(0);

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
    // Allow the close handler to settle.
    await new Promise((resolve) => setTimeout(resolve, 25));

    response = await fetch(`${app.httpUrl}/_frick/inspect/metrics`, { headers });
    body = (await response.json()) as { counters: MetricEntry[]; gauges: MetricEntry[] };
    const gaugeAfter = body.gauges.find((g) => g.name === "frick.ws.connections.current");
    expect(gaugeAfter?.value).toBe(0);
  });

  it("returns 404 when inspectionEnabled is false", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "frick-metrics-"));
    const dbPath = path.join(dir, "frick.sqlite");
    try {
      app = await startServer({
        dbPath,
        config: { env: "production", dbPath, inspectionEnabled: false },
      });
      const r = await fetch(`${app.httpUrl}/_frick/inspect/metrics`);
      expect(r.status).toBe(404);
    } finally {
      await app?.close();
      app = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshot ordering is stable across successive calls", async () => {
    app = await startServer();
    await fetch(`${app.httpUrl}/health`);
    await fetch(`${app.httpUrl}/ready`);
    const headers = await inspectHeaders(app.httpUrl);
    const a = await (await fetch(`${app.httpUrl}/_frick/inspect/metrics`, { headers })).json();
    const b = await (await fetch(`${app.httpUrl}/_frick/inspect/metrics`, { headers })).json();
    expect(a.counters.map((c: MetricEntry) => [c.name, c.fields])).toEqual(
      b.counters.map((c: MetricEntry) => [c.name, c.fields]),
    );
  });
});

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const merged = { port: 0, dbPath: ":memory:", ...options } as Parameters<typeof createFrickServer>[0];
  const server = createFrickServer(merged);
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/_frick/sync`,
    store: server.store,
    close: server.close,
  };
}

async function connect(url: string, sessionToken?: string): Promise<WebSocket> {
  const socket = new WebSocket(
    url,
    sessionToken ? { headers: { authorization: `Bearer ${sessionToken}` } } : undefined,
  );
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

async function waitForFrameCount(frames: FrickFrame[], target: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (frames.length < target) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${target} frames (got ${frames.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function devLogin(
  httpUrl: string,
  body: { userId: string },
): Promise<{
  sessionToken: string;
  userId: string;
  deviceId: string;
  replicaId: string;
}> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(`dev-login failed with ${response.status}`);
  }
  return (await response.json()) as {
    sessionToken: string;
    userId: string;
    deviceId: string;
    replicaId: string;
  };
}

async function inspectHeaders(httpUrl: string): Promise<Record<string, string>> {
  const login = await devLogin(httpUrl, { userId: "user-ada" });
  return { authorization: `Bearer ${login.sessionToken}` };
}
