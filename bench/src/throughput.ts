import { performance } from "node:perf_hooks";
import {
  FrameKind,
  encodeFrame,
  productTestSchema,
  type FrickSchema,
} from "@fricken/protocol";
import {
  closeSocket,
  connectAndHello,
  devLogin,
  resolveTarget,
  waitForAck,
  type BenchTarget,
  type ConnectedSocket,
} from "./server-target.js";

/**
 * FR-98 — Throughput + resource-growth benchmark suite.
 *
 * Drives a sustained append/upsert workload across N concurrent WS connections
 * and measures:
 *
 *   - **Throughput** — completed ops/sec (appends, upserts, and combined),
 *     measured over the wall-clock of the sustained run.
 *   - **Resource growth** — `process.memoryUsage()` (rss + heapUsed), the
 *     SQLite database byte size + per-table row counts, and the in-process
 *     idempotency cache row count — sampled before and after the run, with
 *     deltas reported.
 *
 * Resource sampling requires the in-process `store`, so the suite only reports
 * growth when it spins the server up itself (the default). Driving an external
 * server still measures throughput but omits the growth section.
 *
 * Correctness lives in the test suites; this module only measures.
 */

export interface ThroughputConfig {
  /** Concurrent WS connections issuing ops. */
  readonly connections: number;
  /** Total ops issued per connection (split between appends and upserts). */
  readonly opsPerConnection: number;
  /**
   * Fraction of ops that are object upserts (0..1); the remainder are stream
   * appends. Defaults to 0.2 (a write-heavy stream workload with some upserts).
   */
  readonly upsertRatio: number;
  /**
   * Await a durable Ack for every op before issuing the next on that
   * connection. When false (default), ops are pipelined and only counted as
   * they ack, which yields higher throughput numbers.
   */
  readonly awaitAcks: boolean;
  /** Deterministic seed for synthetic payloads. */
  readonly seed: number;
  /** Schema to drive. Defaults to the product test schema fixture. */
  readonly schema?: FrickSchema;
  /** Drive an external server instead of spinning one up in-process. */
  readonly target?: {
    readonly httpUrl: string;
    readonly wsUrl: string;
  };
}

export const DEFAULT_THROUGHPUT_CONFIG: ThroughputConfig = {
  connections: 8,
  opsPerConnection: 100,
  upsertRatio: 0.2,
  awaitAcks: true,
  seed: 1,
};

export interface MemorySample {
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
}

export interface ResourceSnapshot {
  readonly memory: MemorySample;
  /** SQLite database size in bytes (page_count * page_size). */
  readonly dbBytes: number;
  /** Row counts for the rows-bearing tables we track for growth. */
  readonly rowCounts: Record<string, number>;
  /** In-process idempotency front-cache durable row count. */
  readonly idempotencyCacheRows: number;
}

export interface ResourceGrowth {
  readonly before: ResourceSnapshot;
  readonly after: ResourceSnapshot;
  readonly delta: {
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly dbBytes: number;
    readonly rowCounts: Record<string, number>;
    readonly idempotencyCacheRows: number;
  };
}

export interface ThroughputResult {
  readonly schemaVersion: 1;
  readonly tool: "frick-throughput-bench";
  readonly startedAt: string;
  readonly config: ThroughputConfig;
  readonly env: {
    readonly node: string;
    readonly platform: string;
    readonly inProcessServer: boolean;
  };
  readonly durationMs: number;
  readonly ops: {
    readonly appends: number;
    readonly upserts: number;
    readonly total: number;
    readonly errors: number;
  };
  readonly throughputPerSec: {
    readonly appends: number;
    readonly upserts: number;
    readonly total: number;
  };
  /** Present only when the server was spun up in-process (store accessible). */
  readonly resources?: ResourceGrowth;
}

const STREAM = "MessageStream";
const OBJECT_TYPE = "Conversation";
const TRACKED_TABLES = ["stream_events", "objects", "idempotency_keys"] as const;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
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

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
function synthWord(rng: () => number): string {
  return WORDS[Math.floor(rng() * WORDS.length)]!;
}

/**
 * Run the throughput + resource-growth suite and return a structured JSON
 * result. Spins up an in-process server unless `config.target` is provided;
 * always cleans up.
 */
export async function runThroughput(
  configIn: Partial<ThroughputConfig> = {},
): Promise<ThroughputResult> {
  const config: ThroughputConfig = { ...DEFAULT_THROUGHPUT_CONFIG, ...configIn };
  const schema = config.schema ?? productTestSchema;
  const startedAt = new Date().toISOString();
  const target = await resolveTarget(config.target, schema);
  const inProcessServer = target.server !== undefined;

  let appends = 0;
  let upserts = 0;
  let errors = 0;
  let durationMs = 0;
  let resources: ResourceGrowth | undefined;

  const sockets: ConnectedSocket[] = [];
  try {
    for (let c = 0; c < config.connections; c += 1) {
      const login = await devLogin(target.httpUrl, `bench-tput-user-${c}`);
      sockets.push(await connectAndHello(target.wsUrl, login.sessionToken, schema, `bench-tput-${c}`));
    }

    const before = sampleResources(target);

    const runStart = performance.now();
    const results = await Promise.all(
      sockets.map((connected, c) => driveConnection(connected, c, config)),
    );
    durationMs = performance.now() - runStart;

    for (const r of results) {
      appends += r.appends;
      upserts += r.upserts;
      errors += r.errors;
    }

    const after = sampleResources(target);
    if (before && after) {
      resources = buildGrowth(before, after);
    }
  } finally {
    for (const connected of sockets) closeSocket(connected.socket);
    await target.close();
  }

  const total = appends + upserts;
  const perSec = (n: number) => (durationMs > 0 ? round((n / durationMs) * 1000) : 0);

  return {
    schemaVersion: 1,
    tool: "frick-throughput-bench",
    startedAt,
    config,
    env: {
      node: process.version,
      platform: process.platform,
      inProcessServer,
    },
    durationMs: round(durationMs),
    ops: { appends, upserts, total, errors },
    throughputPerSec: {
      appends: perSec(appends),
      upserts: perSec(upserts),
      total: perSec(total),
    },
    ...(resources ? { resources } : {}),
  };
}

interface ConnectionResult {
  appends: number;
  upserts: number;
  errors: number;
}

async function driveConnection(
  connected: ConnectedSocket,
  connectionIndex: number,
  config: ThroughputConfig,
): Promise<ConnectionResult> {
  const { socket } = connected;
  const rng = makeRng(config.seed + connectionIndex);
  const key = `bench-tput-conv-${connectionIndex}`;
  let appends = 0;
  let upserts = 0;
  let errors = 0;

  const pending: Promise<void>[] = [];

  for (let i = 0; i < config.opsPerConnection; i += 1) {
    const isUpsert = rng() < config.upsertRatio;
    const requestId = isUpsert
      ? `tput-obj-${connectionIndex}-${i}`
      : `tput-app-${connectionIndex}-${i}`;

    const ack = waitForAck(socket, requestId);
    if (isUpsert) {
      socket.send(
        encodeFrame([
          FrameKind.ObjectUpsert,
          {
            requestId,
            objectType: OBJECT_TYPE,
            objectId: `${key}-obj-${i}`,
            value: {
              kind: "group",
              title: `Room ${connectionIndex} rev ${i} ${synthWord(rng)}`,
              createdBy: `bench-tput-user-${connectionIndex}`,
            },
          },
        ]),
      );
    } else {
      socket.send(
        encodeFrame([
          FrameKind.Append,
          {
            requestId,
            stream: STREAM,
            key,
            event: "MessageSent",
            payload: {
              messageId: `tput-msg-${connectionIndex}-${i}`,
              senderId: `bench-tput-user-${connectionIndex}`,
              body: `sustained ${synthWord(rng)} #${i}`,
              createdAt: new Date().toISOString(),
            },
          },
        ]),
      );
    }

    const settle = ack.then(
      () => {
        if (isUpsert) upserts += 1;
        else appends += 1;
      },
      () => {
        errors += 1;
      },
    );

    if (config.awaitAcks) {
      await settle;
    } else {
      pending.push(settle);
    }
  }

  if (pending.length > 0) {
    await Promise.all(pending);
  }

  return { appends, upserts, errors };
}

/** Sample process + store resource gauges, or `undefined` for external targets. */
function sampleResources(target: BenchTarget): ResourceSnapshot | undefined {
  const mem = process.memoryUsage();
  const memory: MemorySample = {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    external: mem.external,
  };

  if (!target.server) {
    return undefined;
  }
  const store = target.server.store;
  const db = store.rawDatabase();

  const pageCount = scalar(db, "PRAGMA page_count");
  const pageSize = scalar(db, "PRAGMA page_size");
  const dbBytes = pageCount * pageSize;

  const rowCounts: Record<string, number> = {};
  for (const table of TRACKED_TABLES) {
    rowCounts[table] = tableRowCount(db, table);
  }

  return {
    memory,
    dbBytes,
    rowCounts,
    idempotencyCacheRows: store.idempotencyKeyRowCount(),
  };
}

interface MinimalDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

function scalar(db: MinimalDb, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function tableRowCount(db: MinimalDb, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
      | { count: number }
      | undefined;
    return Number(row?.count ?? 0);
  } catch {
    // Table may not exist for a given schema; report 0 rather than throwing.
    return 0;
  }
}

function buildGrowth(before: ResourceSnapshot, after: ResourceSnapshot): ResourceGrowth {
  const rowCounts: Record<string, number> = {};
  for (const table of TRACKED_TABLES) {
    rowCounts[table] = (after.rowCounts[table] ?? 0) - (before.rowCounts[table] ?? 0);
  }
  return {
    before,
    after,
    delta: {
      rssBytes: after.memory.rss - before.memory.rss,
      heapUsedBytes: after.memory.heapUsed - before.memory.heapUsed,
      dbBytes: after.dbBytes - before.dbBytes,
      rowCounts,
      idempotencyCacheRows: after.idempotencyCacheRows - before.idempotencyCacheRows,
    },
  };
}
