import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import type {
  FrickHttpTelemetryRequest,
  FrickHttpTelemetryResult,
  FrickTelemetryRuntime,
} from "../src/telemetry/runtime.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("server OTel runtime", () => {
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

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

class ThrowingStartTelemetryRuntime extends RecordingTelemetryRuntime {
  override startHttpRequest(): never {
    throw new Error("span start failed");
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
    close: () => server.close(),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}
