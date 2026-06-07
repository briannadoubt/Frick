import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  productTestSchema,
  type FrickFrame,
  type FrickSchema,
} from "@fricken/protocol";
import { createFrickServer, createNoopLogger } from "@fricken/server";

/**
 * FR-96 — reusable synthetic load harness.
 *
 * Drives configurable synthetic load against a Frick server (spun up
 * in-process on an ephemeral port by default, against a local SQLite
 * `:memory:` store) and returns a machine-readable JSON result with counts,
 * durations, and latency percentiles. This is the foundation for the later
 * benchmark stories (FR-97–100); keep it reusable, not a one-off.
 *
 * The workload is intentionally simple and deterministic given a seed:
 *   - spin up N synthetic users (each dev-logs-in over HTTP),
 *   - each user opens a WS connection, Hello-handshakes, and subscribes to a
 *     stream key (conversation),
 *   - each user appends `appendsPerUser` events to its conversation stream and
 *     `objectWritesPerUser` object upserts, measuring per-operation latency.
 *
 * All correctness checks live in the regular test suites; this module only
 * measures throughput/latency and never asserts product behavior.
 */

export interface LoadHarnessConfig {
  /** Number of synthetic users. Each gets its own WS connection + conversation. */
  readonly users: number;
  /** Stream appends each user performs (the MessageSent hot path). */
  readonly appendsPerUser: number;
  /** Object upserts each user performs (the Conversation upsert path). */
  readonly objectWritesPerUser: number;
  /** Whether each user opens a WS subscription before writing. */
  readonly subscribe: boolean;
  /** Deterministic seed for synthetic payload generation. */
  readonly seed: number;
  /**
   * Optional pre-bound server origin to drive instead of spinning one up
   * in-process. When omitted the harness creates an in-process server on an
   * ephemeral port backed by an in-memory SQLite store.
   */
  readonly target?: {
    readonly httpUrl: string;
    readonly wsUrl: string;
  };
  /** Schema to drive. Defaults to the product test schema fixture. */
  readonly schema?: FrickSchema;
}

export const DEFAULT_LOAD_CONFIG: LoadHarnessConfig = {
  users: 10,
  appendsPerUser: 20,
  objectWritesPerUser: 5,
  subscribe: true,
  seed: 1,
};

export interface LatencySummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}

export interface OperationSummary {
  /** Number of completed operations of this kind. */
  readonly count: number;
  /** Number of operations that failed (errored or timed out). */
  readonly errors: number;
  /** Wall-clock latency percentiles, in milliseconds. */
  readonly latencyMs: LatencySummary;
  /** Completed operations per second (count / totalDurationMs * 1000). */
  readonly throughputPerSec: number;
}

export interface LoadHarnessResult {
  readonly schemaVersion: 1;
  readonly tool: "frick-load-harness";
  readonly startedAt: string;
  readonly config: LoadHarnessConfig;
  readonly env: {
    readonly node: string;
    readonly platform: string;
    /** Whether the server was spun up in-process by the harness. */
    readonly inProcessServer: boolean;
  };
  /** Total wall-clock duration of the measured workload, in milliseconds. */
  readonly totalDurationMs: number;
  readonly operations: {
    readonly connect: OperationSummary;
    readonly objectUpsert: OperationSummary;
    readonly streamAppend: OperationSummary;
  };
  /** Aggregate counts for quick scanning. */
  readonly totals: {
    readonly users: number;
    readonly connections: number;
    readonly objectUpserts: number;
    readonly streamAppends: number;
    readonly errors: number;
  };
}

/** Tiny seeded PRNG (mulberry32) for deterministic synthetic payloads. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Recorder {
  private readonly samples: number[] = [];
  errors = 0;

  record(ms: number): void {
    this.samples.push(ms);
  }

  fail(): void {
    this.errors += 1;
  }

  summarize(totalDurationMs: number): OperationSummary {
    return {
      count: this.samples.length,
      errors: this.errors,
      latencyMs: summarizeLatency(this.samples),
      throughputPerSec:
        totalDurationMs > 0 ? (this.samples.length / totalDurationMs) * 1000 : 0,
    };
  }
}

export function summarizeLatency(samplesIn: readonly number[]): LatencySummary {
  if (samplesIn.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p99: 0 };
  }
  const samples = [...samplesIn].sort((x, y) => x - y);
  const sum = samples.reduce((acc, v) => acc + v, 0);
  return {
    count: samples.length,
    min: round(samples[0]!),
    max: round(samples[samples.length - 1]!),
    mean: round(sum / samples.length),
    p50: round(percentile(samples, 0.5)),
    p90: round(percentile(samples, 0.9)),
    p99: round(percentile(samples, 0.99)),
  };
}

function percentile(sorted: readonly number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface DevLoginResult {
  sessionToken: string;
  tenantId: string;
}

async function devLogin(httpUrl: string, userId: string): Promise<DevLoginResult> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) {
    throw new Error(`dev-login failed for ${userId}: HTTP ${response.status}`);
  }
  return (await response.json()) as DevLoginResult;
}

function waitForFrames(socket: WebSocket, count: number): Promise<void> {
  return new Promise((resolve) => {
    let received = 0;
    const onMessage = () => {
      received += 1;
      if (received >= count) {
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
  });
}

function waitForFrameKind(socket: WebSocket, kind: FrameKind): Promise<FrickFrame> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const frame = decodeFrame(data);
      if (frame[0] === kind) {
        socket.off("message", onMessage);
        resolve(frame);
      }
    };
    socket.on("message", onMessage);
  });
}

async function connectAndHello(
  wsUrl: string,
  sessionToken: string,
  schema: FrickSchema,
): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    encodeFrame([
      FrameKind.Hello,
      {
        replicaId: "bench-replica",
        deviceId: "bench-device",
        schemaHash: schema.hash,
        knownCursors: {},
      },
    ]),
  );
  // Drain HelloAck + Schema before we hand the socket to the workload.
  await waitForFrames(socket, 2);
  return socket;
}

/**
 * Run the synthetic load workload and return a structured JSON result.
 *
 * Spins up an in-process server unless `config.target` is provided. Always
 * cleans up sockets and the server it created.
 */
export async function runLoad(
  configIn: Partial<LoadHarnessConfig> = {},
): Promise<LoadHarnessResult> {
  const config: LoadHarnessConfig = { ...DEFAULT_LOAD_CONFIG, ...configIn };
  const schema = config.schema ?? productTestSchema;
  const startedAt = new Date().toISOString();

  let httpUrl: string;
  let wsUrl: string;
  let inProcessServer = false;
  let server: ReturnType<typeof createFrickServer> | undefined;

  if (config.target) {
    httpUrl = config.target.httpUrl;
    wsUrl = config.target.wsUrl;
  } else {
    // Silence the server's structured logger: stdout is reserved for the
    // harness's single JSON result so CI/tooling can consume it cleanly.
    server = createFrickServer({
      port: 0,
      dbPath: ":memory:",
      schema,
      logger: createNoopLogger(),
    });
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind an ephemeral port");
    }
    httpUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/_frick/sync`;
    inProcessServer = true;
  }

  const connect = new Recorder();
  const objectUpsert = new Recorder();
  const streamAppend = new Recorder();
  const sockets: WebSocket[] = [];
  const rng = makeRng(config.seed);

  const workloadStart = performance.now();
  try {
    for (let u = 0; u < config.users; u += 1) {
      const userId = `bench-user-${u}`;
      const conversationKey = `bench-conv-${u}`;

      const connectStart = performance.now();
      let socket: WebSocket;
      try {
        const login = await devLogin(httpUrl, userId);
        socket = await connectAndHello(wsUrl, login.sessionToken, schema);
        if (config.subscribe) {
          const page = waitForFrameKind(socket, FrameKind.StreamPage);
          socket.send(
            encodeFrame([
              FrameKind.Subscribe,
              {
                subscriptionId: `sub-${u}`,
                kind: "stream",
                name: "MessageStream",
                key: conversationKey,
                cursor: 0,
              },
            ]),
          );
          await page;
        }
        connect.record(performance.now() - connectStart);
      } catch {
        connect.fail();
        continue;
      }
      sockets.push(socket);

      for (let o = 0; o < config.objectWritesPerUser; o += 1) {
        const start = performance.now();
        try {
          socket.send(
            encodeFrame([
              FrameKind.ObjectUpsert,
              {
                requestId: `obj-${u}-${o}`,
                objectType: "Conversation",
                objectId: conversationKey,
                value: {
                  kind: "group",
                  title: `Room ${u} rev ${o} ${synthWord(rng)}`,
                  createdBy: userId,
                },
              },
            ]),
          );
          objectUpsert.record(performance.now() - start);
        } catch {
          objectUpsert.fail();
        }
      }

      for (let a = 0; a < config.appendsPerUser; a += 1) {
        const start = performance.now();
        try {
          socket.send(
            encodeFrame([
              FrameKind.Append,
              {
                requestId: `app-${u}-${a}`,
                stream: "MessageStream",
                key: conversationKey,
                event: "MessageSent",
                payload: {
                  messageId: `msg-${u}-${a}`,
                  senderId: userId,
                  body: `hello ${synthWord(rng)} #${a}`,
                  createdAt: new Date().toISOString(),
                },
              },
            ]),
          );
          streamAppend.record(performance.now() - start);
        } catch {
          streamAppend.fail();
        }
      }
    }
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    if (server) {
      await server.close();
    }
  }
  const totalDurationMs = performance.now() - workloadStart;

  const connectSummary = connect.summarize(totalDurationMs);
  const objectSummary = objectUpsert.summarize(totalDurationMs);
  const streamSummary = streamAppend.summarize(totalDurationMs);

  return {
    schemaVersion: 1,
    tool: "frick-load-harness",
    startedAt,
    config,
    env: {
      node: process.version,
      platform: process.platform,
      inProcessServer,
    },
    totalDurationMs: round(totalDurationMs),
    operations: {
      connect: connectSummary,
      objectUpsert: objectSummary,
      streamAppend: streamSummary,
    },
    totals: {
      users: config.users,
      connections: connectSummary.count,
      objectUpserts: objectSummary.count,
      streamAppends: streamSummary.count,
      errors: connectSummary.errors + objectSummary.errors + streamSummary.errors,
    },
  };
}

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
];

function synthWord(rng: () => number): string {
  return WORDS[Math.floor(rng() * WORDS.length)]!;
}
