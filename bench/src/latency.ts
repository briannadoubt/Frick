import { performance } from "node:perf_hooks";
import {
  FrameKind,
  encodeFrame,
  productTestSchema,
  type FrickSchema,
} from "@fricken/protocol";
import { summarizeLatency, type LatencySummary } from "./harness.js";
import {
  closeSocket,
  connectAndHello,
  devLogin,
  resolveTarget,
  waitForAck,
  waitForFrameKind,
  type ConnectedSocket,
} from "./server-target.js";

/**
 * FR-97 — Latency benchmark suite.
 *
 * Measures end-to-end latency across the core paths, one sample per iteration,
 * and emits machine-readable JSON with p50/p90/p99 percentiles per path:
 *
 *   - `httpRequest`     — an authenticated HTTP GET round-trip.
 *   - `wsAppend`        — WS stream append → durable Ack round-trip.
 *   - `objectFanout`    — one client upserts an object, a *second* subscribed
 *                         client receives the broadcast Delta (write → fan-out).
 *   - `catchUp`         — Subscribe to a backfilled stream → first StreamPage
 *                         (the subscribe → snapshot/page catch-up path).
 *   - `reconnect`       — open a fresh WS, Hello-handshake, drain HelloAck.
 *
 * Built on the FR-96 harness's measurement utilities (`summarizeLatency`) and
 * the shared server-spin-up helpers. Correctness lives in the test suites; this
 * module only measures.
 */

export interface LatencyConfig {
  /** Iterations per measured path. Each yields one latency sample. */
  readonly iterations: number;
  /**
   * Backfilled stream events seeded before the run, used as the catch-up
   * subscription's existing history (the first StreamPage the client drains).
   */
  readonly catchUpBacklog: number;
  /** Schema to drive. Defaults to the product test schema fixture. */
  readonly schema?: FrickSchema;
  /** Drive an external server instead of spinning one up in-process. */
  readonly target?: {
    readonly httpUrl: string;
    readonly wsUrl: string;
  };
}

export const DEFAULT_LATENCY_CONFIG: LatencyConfig = {
  iterations: 50,
  catchUpBacklog: 25,
};

export interface LatencyPathResult {
  /** Completed samples for this path. */
  readonly count: number;
  /** Iterations that errored or timed out (excluded from percentiles). */
  readonly errors: number;
  readonly latencyMs: LatencySummary;
}

export interface LatencyResult {
  readonly schemaVersion: 1;
  readonly tool: "frick-latency-bench";
  readonly startedAt: string;
  readonly config: LatencyConfig;
  readonly env: {
    readonly node: string;
    readonly platform: string;
    readonly inProcessServer: boolean;
  };
  readonly totalDurationMs: number;
  readonly paths: {
    readonly httpRequest: LatencyPathResult;
    readonly wsAppend: LatencyPathResult;
    readonly objectFanout: LatencyPathResult;
    readonly catchUp: LatencyPathResult;
    readonly reconnect: LatencyPathResult;
  };
  /** Sum of errored iterations across all paths. */
  readonly totalErrors: number;
}

const STREAM = "MessageStream";
const OBJECT_TYPE = "Conversation";

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

class PathRecorder {
  private readonly samples: number[] = [];
  errors = 0;

  record(ms: number): void {
    this.samples.push(ms);
  }

  fail(): void {
    this.errors += 1;
  }

  result(): LatencyPathResult {
    return {
      count: this.samples.length,
      errors: this.errors,
      latencyMs: summarizeLatency(this.samples),
    };
  }
}

/**
 * Run the latency suite and return a structured JSON result. Spins up an
 * in-process server unless `config.target` is provided; always cleans up.
 */
export async function runLatency(
  configIn: Partial<LatencyConfig> = {},
): Promise<LatencyResult> {
  const config: LatencyConfig = { ...DEFAULT_LATENCY_CONFIG, ...configIn };
  const schema = config.schema ?? productTestSchema;
  const startedAt = new Date().toISOString();
  const target = await resolveTarget(config.target, schema);
  const inProcessServer = target.server !== undefined;

  const httpRequest = new PathRecorder();
  const wsAppend = new PathRecorder();
  const objectFanout = new PathRecorder();
  const catchUp = new PathRecorder();
  const reconnect = new PathRecorder();

  const totalStart = performance.now();
  try {
    const login = await devLogin(target.httpUrl, "bench-latency-user");

    await measureHttpRequest(target.httpUrl, login.sessionToken, config.iterations, httpRequest);
    await measureWsAppend(target.wsUrl, login.sessionToken, schema, config.iterations, wsAppend);
    await measureObjectFanout(
      target.wsUrl,
      login.sessionToken,
      schema,
      config.iterations,
      objectFanout,
    );
    await measureCatchUp(
      target.httpUrl,
      target.wsUrl,
      login.sessionToken,
      schema,
      config,
      catchUp,
    );
    await measureReconnect(target.wsUrl, login.sessionToken, schema, config.iterations, reconnect);
  } finally {
    await target.close();
  }
  const totalDurationMs = performance.now() - totalStart;

  const paths = {
    httpRequest: httpRequest.result(),
    wsAppend: wsAppend.result(),
    objectFanout: objectFanout.result(),
    catchUp: catchUp.result(),
    reconnect: reconnect.result(),
  };

  return {
    schemaVersion: 1,
    tool: "frick-latency-bench",
    startedAt,
    config,
    env: {
      node: process.version,
      platform: process.platform,
      inProcessServer,
    },
    totalDurationMs: round(totalDurationMs),
    paths,
    totalErrors: Object.values(paths).reduce((sum, p) => sum + p.errors, 0),
  };
}

async function measureHttpRequest(
  httpUrl: string,
  sessionToken: string,
  iterations: number,
  rec: PathRecorder,
): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    try {
      const response = await fetch(`${httpUrl}/objects?type=${OBJECT_TYPE}`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      // Drain the body so the round-trip is fully complete before we record.
      await response.arrayBuffer();
      if (response.status !== 200) {
        rec.fail();
        continue;
      }
      rec.record(performance.now() - start);
    } catch {
      rec.fail();
    }
  }
}

async function measureWsAppend(
  wsUrl: string,
  sessionToken: string,
  schema: FrickSchema,
  iterations: number,
  rec: PathRecorder,
): Promise<void> {
  let connected: ConnectedSocket | undefined;
  try {
    connected = await connectAndHello(wsUrl, sessionToken, schema, "bench-ws-append");
    const { socket } = connected;
    for (let i = 0; i < iterations; i += 1) {
      const requestId = `lat-append-${i}`;
      const ack = waitForAck(socket, requestId);
      const start = performance.now();
      socket.send(
        encodeFrame([
          FrameKind.Append,
          {
            requestId,
            stream: STREAM,
            key: "bench-latency-conv",
            event: "MessageSent",
            payload: {
              messageId: `lat-msg-${i}`,
              senderId: "bench-latency-user",
              body: `latency ping ${i}`,
              createdAt: new Date().toISOString(),
            },
          },
        ]),
      );
      try {
        await ack;
        rec.record(performance.now() - start);
      } catch {
        rec.fail();
      }
    }
  } catch {
    rec.fail();
  } finally {
    if (connected) closeSocket(connected.socket);
  }
}

async function measureObjectFanout(
  wsUrl: string,
  sessionToken: string,
  schema: FrickSchema,
  iterations: number,
  rec: PathRecorder,
): Promise<void> {
  let writer: ConnectedSocket | undefined;
  let subscriber: ConnectedSocket | undefined;
  try {
    writer = await connectAndHello(wsUrl, sessionToken, schema, "bench-fanout-writer");
    subscriber = await connectAndHello(wsUrl, sessionToken, schema, "bench-fanout-sub");

    // The subscriber watches the Conversation object type and drains its
    // initial Snapshot before any writes happen.
    const snapshot = waitForFrameKind(subscriber.socket, FrameKind.Snapshot);
    subscriber.socket.send(
      encodeFrame([
        FrameKind.Subscribe,
        { subscriptionId: "fanout-sub", kind: "object", name: OBJECT_TYPE },
      ]),
    );
    await snapshot;

    for (let i = 0; i < iterations; i += 1) {
      const deltaArrival = waitForFrameKind(subscriber.socket, FrameKind.Delta);
      const start = performance.now();
      writer.socket.send(
        encodeFrame([
          FrameKind.ObjectUpsert,
          {
            requestId: `fanout-obj-${i}`,
            objectType: OBJECT_TYPE,
            objectId: `bench-fanout-conv-${i}`,
            value: {
              kind: "group",
              title: `Fanout room ${i}`,
              createdBy: "bench-latency-user",
            },
          },
        ]),
      );
      try {
        await deltaArrival;
        rec.record(performance.now() - start);
      } catch {
        rec.fail();
      }
    }
  } catch {
    rec.fail();
  } finally {
    if (writer) closeSocket(writer.socket);
    if (subscriber) closeSocket(subscriber.socket);
  }
}

async function measureCatchUp(
  httpUrl: string,
  wsUrl: string,
  sessionToken: string,
  schema: FrickSchema,
  config: LatencyConfig,
  rec: PathRecorder,
): Promise<void> {
  const catchUpKey = "bench-catchup-conv";
  // Seed a backlog over HTTP so each fresh subscription has history to drain.
  for (let i = 0; i < config.catchUpBacklog; i += 1) {
    try {
      const response = await fetch(`${httpUrl}/append`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({
          requestId: `catchup-seed-${i}`,
          replicaId: "bench-catchup-seed",
          stream: STREAM,
          key: catchUpKey,
          event: "MessageSent",
          payload: {
            messageId: `catchup-seed-msg-${i}`,
            senderId: "bench-latency-user",
            body: `backlog ${i}`,
            createdAt: new Date().toISOString(),
          },
        }),
      });
      await response.arrayBuffer();
    } catch {
      // A failed seed just shortens the backlog; not fatal to the measurement.
    }
  }

  for (let i = 0; i < config.iterations; i += 1) {
    let connected: ConnectedSocket | undefined;
    try {
      connected = await connectAndHello(wsUrl, sessionToken, schema, `bench-catchup-${i}`);
      const page = waitForFrameKind(connected.socket, FrameKind.StreamPage);
      const start = performance.now();
      connected.socket.send(
        encodeFrame([
          FrameKind.Subscribe,
          {
            subscriptionId: `catchup-sub-${i}`,
            kind: "stream",
            name: STREAM,
            key: catchUpKey,
            cursor: 0,
          },
        ]),
      );
      await page;
      rec.record(performance.now() - start);
    } catch {
      rec.fail();
    } finally {
      if (connected) closeSocket(connected.socket);
    }
  }
}

async function measureReconnect(
  wsUrl: string,
  sessionToken: string,
  schema: FrickSchema,
  iterations: number,
  rec: PathRecorder,
): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    try {
      const connected = await connectAndHello(wsUrl, sessionToken, schema, `bench-reconnect-${i}`);
      rec.record(connected.connectMs);
      closeSocket(connected.socket);
    } catch {
      rec.fail();
    }
  }
}
