import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { FrameKind, decodeFrame, encodeFrame, foundationSchema, type FrickFrame } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import type {
  FrickHttpTelemetryRequest,
  FrickHttpTelemetryResult,
  FrickWebSocketConnectionTelemetry,
  FrickWebSocketConnectionTelemetryResult,
  FrickWebSocketConnectionTelemetryPrincipal,
  FrickWebSocketFrameTelemetry,
  FrickTelemetryRuntime,
} from "../src/telemetry/runtime.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("server OTel runtime", () => {
  it("records WebSocket connections and inbound frame metrics", async () => {
    const telemetry = new RecordingTelemetryRuntime();
    app = await startServer({ telemetry });
    const login = await devLogin(app.httpUrl);
    const socket = await connect(app.wsUrl, login.sessionToken);

    const hello = encodeFrame([
      FrameKind.Hello,
      {
        replicaId: login.replicaId,
        deviceId: login.deviceId,
        schemaHash: foundationSchema.hash,
        knownCursors: {},
      },
    ]);
    socket.send(hello);

    await waitFor(() => telemetry.wsFrames.length > 0);
    expect(telemetry.wsFrames).toEqual([
      expect.objectContaining({
        kind: "Hello",
        byteLength: hello.byteLength,
        tenantId: "_default",
        userId: "user-ada",
      }),
    ]);
    expect(telemetry.wsConnections).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          tenantId: "_default",
          userId: "user-ada",
        }),
      }),
    ]);

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
    await waitFor(() => telemetry.wsConnections[0]?.result);
    expect(telemetry.wsConnections[0]?.result).toMatchObject({
      durationMs: expect.any(Number),
      frameCounts: { Hello: 1 },
    });
  });

  it("updates WebSocket connection telemetry when Hello authenticates the client", async () => {
    const telemetry = new RecordingTelemetryRuntime();
    app = await startServer({ telemetry });
    const login = await devLogin(app.httpUrl);
    const socket = await connect(app.wsUrl);
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
          sessionToken: login.sessionToken,
        },
      ]),
    );

    await waitFor(() => frames.find((frame) => frame[0] === FrameKind.HelloAck));
    expect(telemetry.wsConnections[0]).toMatchObject({
      input: {
        tenantId: undefined,
        userId: undefined,
      },
      principal: {
        tenantId: "_default",
        userId: "user-ada",
      },
    });
    socket.close();
  });

  it("collapses unknown WebSocket frame kinds to a bounded telemetry label", async () => {
    const telemetry = new RecordingTelemetryRuntime();
    app = await startServer({ telemetry });
    const login = await devLogin(app.httpUrl);
    const socket = await connect(app.wsUrl, login.sessionToken);
    const payload = msgpackEncode([999_999, {}]);

    socket.send(payload);

    await waitFor(() => telemetry.wsFrames.length > 0);
    expect(telemetry.wsFrames).toEqual([
      expect.objectContaining({
        kind: "unknown",
        byteLength: payload.byteLength,
      }),
    ]);
    socket.close();
  });

  it("does not export raw WebSocket close reasons", async () => {
    const telemetry = new RecordingTelemetryRuntime();
    app = await startServer({ telemetry });
    const login = await devLogin(app.httpUrl);
    const socket = await connect(app.wsUrl, login.sessionToken);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    socket.close(1000, "secret=session-token");
    await closed;
    await waitFor(() => telemetry.wsConnections[0]?.result);

    expect(telemetry.wsConnections[0]?.result).toMatchObject({
      closeCode: 1000,
      closeCategory: "normal",
    });
    expect(JSON.stringify(telemetry.wsConnections[0]?.result)).not.toContain("secret=session-token");
  });

  it("keeps WebSocket frame handling alive when frame telemetry throws", async () => {
    const telemetry = new ThrowingWebSocketFrameTelemetryRuntime();
    app = await startServer({ telemetry });
    const login = await devLogin(app.httpUrl);
    const socket = await connect(app.wsUrl, login.sessionToken);
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

    await waitFor(() => frames.find((frame) => frame[0] === FrameKind.HelloAck));
    socket.close();
  });

  it("shuts telemetry down when the HTTP listener fails to bind", async () => {
    const occupied = createFrickServer({ port: 0, dbPath: ":memory:", config: { env: "test" } });
    await occupied.listen();
    const address = occupied.server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected occupied server to bind a TCP address");
    }

    const telemetry = new RecordingTelemetryRuntime();
    const conflicted = createFrickServer({
      port: address.port,
      dbPath: ":memory:",
      config: { env: "test" },
      telemetry,
    });

    await expect(withTimeout(conflicted.listen(), 500)).rejects.toThrow();
    expect(telemetry.startCalls).toBe(1);
    expect(telemetry.shutdownCalls).toBe(1);

    await occupied.close();
  });

  it("keeps request handling alive when telemetry span creation throws", async () => {
    const telemetry = new ThrowingStartTelemetryRuntime();
    app = await startServer({ telemetry });

    const response = await fetch(`${app.httpUrl}/health`);

    expect(response.status).toBe(200);
  });

  it("starts, records HTTP request boundaries, and shuts down with the server", async () => {
    const telemetry = new RecordingTelemetryRuntime();
    app = await startServer({ telemetry });

    expect(telemetry.startCalls).toBe(1);

    const response = await fetch(`${app.httpUrl}/health`);

    expect(response.status).toBe(200);
    expect(telemetry.requests).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          method: "GET",
          path: "/health",
          requestId: expect.any(String),
        }),
        result: expect.objectContaining({
          statusCode: 200,
          durationMs: expect.any(Number),
        }),
      }),
    ]);

    await app.close();
    app = undefined;
    expect(telemetry.shutdownCalls).toBe(1);
  });
});

class RecordingTelemetryRuntime implements FrickTelemetryRuntime {
  readonly enabled = true;
  startCalls = 0;
  shutdownCalls = 0;
  readonly requests: Array<{
    input: FrickHttpTelemetryRequest;
    result: FrickHttpTelemetryResult;
  }> = [];
  readonly wsFrames: FrickWebSocketFrameTelemetry[] = [];
  readonly wsConnections: Array<{
    input: FrickWebSocketConnectionTelemetry;
    principal?: FrickWebSocketConnectionTelemetryPrincipal;
    result?: FrickWebSocketConnectionTelemetryResult;
  }> = [];

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  startHttpRequest(input: FrickHttpTelemetryRequest) {
    return {
      end: (result: FrickHttpTelemetryResult) => {
        this.requests.push({ input, result });
      },
    };
  }

  startWebSocketConnection(input: FrickWebSocketConnectionTelemetry) {
    const record: {
      input: FrickWebSocketConnectionTelemetry;
      principal?: FrickWebSocketConnectionTelemetryPrincipal;
      result?: FrickWebSocketConnectionTelemetryResult;
    } = { input };
    this.wsConnections.push(record);
    return {
      authenticate: (principal: FrickWebSocketConnectionTelemetryPrincipal) => {
        record.principal = principal;
      },
      end: (result: FrickWebSocketConnectionTelemetryResult) => {
        record.result = result;
      },
    };
  }

  recordWebSocketFrame(input: FrickWebSocketFrameTelemetry): void {
    this.wsFrames.push(input);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

class ThrowingStartTelemetryRuntime extends RecordingTelemetryRuntime {
  override startHttpRequest(): never {
    throw new Error("span start failed");
  }
}

class ThrowingWebSocketFrameTelemetryRuntime extends RecordingTelemetryRuntime {
  override recordWebSocketFrame(): void {
    throw new Error("frame telemetry failed");
  }
}

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { env: "test" },
    ...options,
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected test server to bind a TCP address");
  }
  return {
    server,
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/_frick/sync`,
    close: () => server.close(),
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

async function devLogin(httpUrl: string): Promise<{
  sessionToken: string;
  deviceId: string;
  replicaId: string;
}> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-ada" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    sessionToken: string;
    deviceId: string;
    replicaId: string;
  };
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined && value !== null && value !== false) {
      return value as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}
