# Frick Platform Event Pipeline Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Frick's first platform event pipeline as a durable, adapter-backed runtime surface for analytics, telemetry enrichment, audit consumers, async aggregation, and export.

**Architecture:** The pipeline is separate from realtime sync, DevTools, metrics, and admin audit. It defines one typed platform event envelope and adapter contract, then ships memory and SQLite adapters under a shared conformance suite. The server wires SQLite as the default local/lightweight implementation and exposes health through authenticated dashboard/inspection surfaces; a Kafka/Redpanda adapter module lands behind explicit config so production profiles can use broker delivery without changing app code.

**Tech Stack:** TypeScript, Vitest, `node:sqlite`, existing `FrickStore` migrations, optional KafkaJS for broker-backed Redpanda/Kafka delivery.

---

## File Structure

- `apps/server/src/platform-events/types.ts`  
  Owns the public server-side event envelope, event-family union, publish input, delivery state, adapter contract, and validation helpers.
- `apps/server/src/platform-events/memory.ts`  
  In-memory adapter for conformance tests and isolated unit tests. Not a runtime default.
- `apps/server/src/platform-events/sqlite.ts`  
  SQLite adapter backed by framework migrations and `DatabaseSync`. Implements publish, claim, ack, retry, dead-letter, retention prune, and health/lag metadata.
- `apps/server/src/platform-events/kafka.ts`  
  Redpanda/Kafka-compatible adapter behind explicit config. Uses Kafka protocol topics for publish/subscribe and mirrors the same event envelope. Tests are gated behind broker env vars.
- `apps/server/src/platform-events/factory.ts`  
  Builds the configured pipeline from `FrickConfig`, the store SQLite handle, and optional overrides.
- `apps/server/tests/platform-events.conformance.ts`  
  Reusable conformance tests for any adapter factory.
- `apps/server/tests/platform-events-memory.test.ts`  
  Runs the conformance suite against the memory adapter.
- `apps/server/tests/platform-events-sqlite.test.ts`  
  Runs the conformance suite against the SQLite adapter and covers retention/table behavior.
- `apps/server/tests/platform-events-kafka.test.ts`  
  Optional Redpanda/Kafka conformance when `FRICK_TEST_KAFKA_BROKERS` is set; otherwise skipped.
- `apps/server/tests/platform-events-routes.test.ts`  
  Server integration tests for default wiring and authenticated health metadata.
- `apps/server/src/storage/migrations.ts`  
  Adds append-only migration `0014_platform_events` and `FRAMEWORK_TABLES` entries.
- `apps/server/src/store.ts`  
  Adds platform event retention options, SQLite adapter property, prune timer, and close behavior.
- `apps/server/src/config.ts`  
  Adds platform event driver/topic/broker/retention config.
- `apps/server/src/server.ts`  
  Accepts optional `platformEvents`, wires configured pipeline, closes it, and exposes health under `/_frick/inspect/platform-events` and `/_frick/dashboard/api/platform-events/health`.
- `apps/server/src/dashboard/metadata.ts`  
  Adds a small platform-events health summary to mounted dashboard metadata.
- `docs/operations.md`, `docs/status.md`, `CHANGELOG.md`  
  Document runtime defaults, config, and current limitations.

## Event Contract

Use this event family union in `types.ts`:

```ts
export const PLATFORM_EVENT_FAMILIES = [
  "analytics.user_event",
  "telemetry.client_error",
  "audit.dashboard_action",
  "jobs.lifecycle",
  "sync.lifecycle",
  "notifications.delivery",
  "dashboard.operator_action",
] as const;

export type PlatformEventFamily = (typeof PLATFORM_EVENT_FAMILIES)[number];
```

Use this envelope shape:

```ts
export interface PlatformEventInput {
  readonly family: PlatformEventFamily;
  readonly name: string;
  readonly source: string;
  readonly tenantId?: string;
  readonly accountId?: string;
  readonly subjectId?: string;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
  readonly occurredAt?: string;
  readonly payload?: Record<string, unknown>;
  readonly attributes?: Record<string, string | number | boolean>;
}

export interface PlatformEventEnvelope extends Required<Pick<PlatformEventInput, "family" | "name" | "source">> {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly tenantId: string | null;
  readonly accountId: string | null;
  readonly subjectId: string | null;
  readonly traceId: string | null;
  readonly idempotencyKey: string | null;
  readonly payload: Record<string, unknown>;
  readonly attributes: Record<string, string | number | boolean>;
}
```

Adapter contract:

```ts
export interface PlatformEventPublishReceipt {
  readonly id: string;
  readonly sequence: number;
  readonly acceptedAt: string;
  readonly duplicate: boolean;
}

export interface PlatformEventDelivery {
  readonly event: PlatformEventEnvelope;
  readonly consumer: string;
  readonly attempt: number;
  readonly claimedAt: string;
}

export interface PlatformEventClaimOptions {
  readonly batchSize?: number;
  readonly availableAt?: string;
}

export interface PlatformEventRetryOptions {
  readonly error: string;
  readonly availableAt?: string;
}

export interface PlatformEventDeadLetterOptions {
  readonly error: string;
}

export interface PlatformEventHealth {
  readonly adapter: "memory" | "sqlite" | "kafka";
  readonly ok: boolean;
  readonly pending: number;
  readonly claimed: number;
  readonly deadLettered: number;
  readonly retained: number | undefined;
  readonly consumers: readonly {
    readonly name: string;
    readonly pending: number;
    readonly claimed: number;
    readonly deadLettered: number;
    readonly lag: number;
  }[];
}

export interface PlatformEventPipeline {
  readonly adapter: PlatformEventHealth["adapter"];
  publish(input: PlatformEventInput): Promise<PlatformEventPublishReceipt>;
  claim(consumer: string, options?: PlatformEventClaimOptions): Promise<PlatformEventDelivery[]>;
  ack(consumer: string, eventId: string): Promise<void>;
  retry(consumer: string, eventId: string, options: PlatformEventRetryOptions): Promise<void>;
  deadLetter(consumer: string, eventId: string, options: PlatformEventDeadLetterOptions): Promise<void>;
  health(): Promise<PlatformEventHealth>;
  close(): Promise<void>;
}
```

## Task 1: Contract, Validation, and Memory Adapter

**Files:**

- Create: `apps/server/src/platform-events/types.ts`
- Create: `apps/server/src/platform-events/memory.ts`
- Create: `apps/server/tests/platform-events.conformance.ts`
- Create: `apps/server/tests/platform-events-memory.test.ts`

- [ ] **Step 1: Write failing conformance tests**

Create `apps/server/tests/platform-events.conformance.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  PlatformEventInput,
  PlatformEventPipeline,
} from "../src/platform-events/types.js";

export interface PlatformEventConformanceHarness {
  readonly name: string;
  create(): Promise<PlatformEventPipeline>;
  close?(pipeline: PlatformEventPipeline): Promise<void>;
}

const baseEvent: PlatformEventInput = {
  family: "analytics.user_event",
  name: "message.sent",
  source: "test",
  tenantId: "tenant-a",
  accountId: "account-a",
  payload: { messageId: "message-1" },
  attributes: { platform: "web", beta: true, count: 1 },
};

export function definePlatformEventPipelineConformance(harness: PlatformEventConformanceHarness): void {
  describe(`${harness.name} platform event pipeline`, () => {
    it("publishes typed events and claims them for a named consumer", async () => {
      const pipeline = await harness.create();
      try {
        const receipt = await pipeline.publish(baseEvent);

        expect(receipt.duplicate).toBe(false);
        expect(receipt.sequence).toBeGreaterThan(0);
        const deliveries = await pipeline.claim("analytics-worker", { batchSize: 10 });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.event).toMatchObject({
          id: receipt.id,
          sequence: receipt.sequence,
          family: "analytics.user_event",
          name: "message.sent",
          tenantId: "tenant-a",
          accountId: "account-a",
          payload: { messageId: "message-1" },
          attributes: { platform: "web", beta: true, count: 1 },
        });
        expect(deliveries[0]?.attempt).toBe(1);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });

    it("does not redeliver an acked event to the same consumer", async () => {
      const pipeline = await harness.create();
      try {
        const receipt = await pipeline.publish(baseEvent);
        const [delivery] = await pipeline.claim("analytics-worker");
        expect(delivery?.event.id).toBe(receipt.id);

        await pipeline.ack("analytics-worker", receipt.id);

        expect(await pipeline.claim("analytics-worker")).toEqual([]);
        const secondConsumer = await pipeline.claim("export-worker");
        expect(secondConsumer[0]?.event.id).toBe(receipt.id);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });

    it("retries a failed delivery after its availability time", async () => {
      const pipeline = await harness.create();
      try {
        const receipt = await pipeline.publish(baseEvent);
        const [delivery] = await pipeline.claim("analytics-worker");
        expect(delivery?.attempt).toBe(1);

        await pipeline.retry("analytics-worker", receipt.id, {
          error: "temporary failure",
          availableAt: "2099-01-01T00:00:00.000Z",
        });
        expect(await pipeline.claim("analytics-worker", { availableAt: "2026-01-01T00:00:00.000Z" })).toEqual([]);

        const [retry] = await pipeline.claim("analytics-worker", { availableAt: "2099-01-01T00:00:00.000Z" });
        expect(retry?.event.id).toBe(receipt.id);
        expect(retry?.attempt).toBe(2);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });

    it("dead-letters poison events per consumer", async () => {
      const pipeline = await harness.create();
      try {
        const receipt = await pipeline.publish(baseEvent);
        await pipeline.claim("analytics-worker");

        await pipeline.deadLetter("analytics-worker", receipt.id, { error: "bad payload" });

        expect(await pipeline.claim("analytics-worker")).toEqual([]);
        const health = await pipeline.health();
        expect(health.deadLettered).toBeGreaterThanOrEqual(1);
        expect(health.consumers.find((row) => row.name === "analytics-worker")?.deadLettered).toBe(1);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });

    it("deduplicates publishes by idempotencyKey", async () => {
      const pipeline = await harness.create();
      try {
        const first = await pipeline.publish({ ...baseEvent, idempotencyKey: "dedupe-1" });
        const second = await pipeline.publish({ ...baseEvent, idempotencyKey: "dedupe-1" });

        expect(second.id).toBe(first.id);
        expect(second.sequence).toBe(first.sequence);
        expect(second.duplicate).toBe(true);
        expect(await pipeline.claim("analytics-worker", { batchSize: 10 })).toHaveLength(1);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });
  });
}
```

Create `apps/server/tests/platform-events-memory.test.ts`:

```ts
import { definePlatformEventPipelineConformance } from "./platform-events.conformance.js";
import { MemoryPlatformEventPipeline } from "../src/platform-events/memory.js";

definePlatformEventPipelineConformance({
  name: "memory",
  async create() {
    return new MemoryPlatformEventPipeline({ now: () => new Date("2026-05-17T00:00:00.000Z") });
  },
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-memory.test.ts
```

Expected: FAIL because `../src/platform-events/memory.js` and `../src/platform-events/types.js` do not exist.

- [ ] **Step 3: Implement types and memory adapter**

Create `apps/server/src/platform-events/types.ts` with the contract from the “Event Contract” section. Add:

```ts
export class PlatformEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformEventValidationError";
  }
}

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function normalizePlatformEventInput(
  input: PlatformEventInput,
  now: () => Date = () => new Date(),
): Omit<PlatformEventEnvelope, "id" | "sequence"> {
  if (!isPlatformEventFamily(input.family)) {
    throw new PlatformEventValidationError(`Unknown platform event family ${JSON.stringify(input.family)}`);
  }
  const name = input.name.trim();
  if (!EVENT_NAME_PATTERN.test(name)) {
    throw new PlatformEventValidationError(`platform event name must match ${EVENT_NAME_PATTERN.toString()}`);
  }
  const source = input.source.trim();
  if (source.length === 0 || source.length > 120) {
    throw new PlatformEventValidationError("platform event source must be between 1 and 120 characters");
  }
  return {
    schemaVersion: 1,
    family: input.family,
    name,
    source,
    occurredAt: input.occurredAt ?? now().toISOString(),
    tenantId: input.tenantId ?? null,
    accountId: input.accountId ?? null,
    subjectId: input.subjectId ?? null,
    traceId: input.traceId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: input.payload ?? {},
    attributes: input.attributes ?? {},
  };
}

export function isPlatformEventFamily(value: string): value is PlatformEventFamily {
  return (PLATFORM_EVENT_FAMILIES as readonly string[]).includes(value);
}
```

Create `apps/server/src/platform-events/memory.ts` implementing the contract with arrays/maps:

- `events: PlatformEventEnvelope[]`
- `deliveries: Map<string, Map<string, DeliveryState>>`
- `idempotency: Map<string, PlatformEventEnvelope>`
- `publish()` increments `sequence`, creates a random UUID event id, and dedupes when `idempotencyKey` is present.
- `claim()` materializes missing delivery states for the consumer, claims pending/retryable deliveries up to `batchSize`, increments attempts, and returns deliveries.
- `ack()`, `retry()`, `deadLetter()` update only the named consumer’s state.
- `health()` returns aggregate pending/claimed/dead-letter counts and per-consumer lag.
- `close()` clears all in-memory data.

Use `randomUUID` from `node:crypto`.

- [ ] **Step 4: Run memory conformance**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-memory.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform-events/types.ts apps/server/src/platform-events/memory.ts apps/server/tests/platform-events.conformance.ts apps/server/tests/platform-events-memory.test.ts
git commit -m "feat(server): define platform event pipeline contract"
```

## Task 2: SQLite Platform Event Adapter

**Files:**

- Modify: `apps/server/src/storage/migrations.ts`
- Create: `apps/server/src/platform-events/sqlite.ts`
- Modify: `apps/server/src/store.ts`
- Create: `apps/server/tests/platform-events-sqlite.test.ts`
- Modify: `apps/server/tests/migrations.test.ts`

- [ ] **Step 1: Write failing SQLite conformance and migration tests**

Create `apps/server/tests/platform-events-sqlite.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { definePlatformEventPipelineConformance } from "./platform-events.conformance.js";
import { SqlitePlatformEventPipeline } from "../src/platform-events/sqlite.js";
import { initializeStorage } from "../src/storage/schema.js";
import { foundationSchema } from "@frick/protocol";
import { FrickStore } from "../src/store.js";

let db: DatabaseSync | undefined;
let store: FrickStore | undefined;

function openPipeline(now = () => new Date("2026-05-17T00:00:00.000Z")) {
  db = new DatabaseSync(":memory:");
  initializeStorage(db, foundationSchema.schemaRevision);
  return new SqlitePlatformEventPipeline(db, {
    retentionMs: 60 * 60 * 1000,
    maxRows: 10_000,
    now,
  });
}

afterEach(() => {
  store?.close();
  store = undefined;
  db?.close();
  db = undefined;
});

definePlatformEventPipelineConformance({
  name: "sqlite",
  async create() {
    return openPipeline();
  },
});

describe("SQLite platform events", () => {
  it("FrickStore exposes the default SQLite platform event pipeline", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });

    const receipt = await store.platformEvents.publish({
      family: "jobs.lifecycle",
      name: "job.completed",
      source: "test",
      tenantId: "_default",
      payload: { jobType: "Example" },
    });

    const [delivery] = await store.platformEvents.claim("dashboard");
    expect(delivery?.event.id).toBe(receipt.id);
    expect(delivery?.event.payload).toEqual({ jobType: "Example" });
  });

  it("prunes old rows by retention and caps newest rows", async () => {
    const now = new Date("2026-05-17T00:00:00.000Z");
    const pipeline = openPipeline(() => now);
    await pipeline.publish({
      family: "analytics.user_event",
      name: "old.event",
      source: "test",
      occurredAt: "2026-05-16T00:00:00.000Z",
    });
    await pipeline.publish({
      family: "analytics.user_event",
      name: "fresh.one",
      source: "test",
    });
    await pipeline.publish({
      family: "analytics.user_event",
      name: "fresh.two",
      source: "test",
    });

    const result = pipeline.prune({ retentionMs: 60 * 60 * 1000, maxRows: 1 });

    expect(result.prunedByAge).toBe(1);
    expect(result.prunedByCap).toBe(1);
    expect((await pipeline.health()).retained).toBe(1);
  });
});
```

Modify `apps/server/tests/migrations.test.ts` expected migration ids to include `0014_platform_events` and assert `platform_events` / `platform_event_deliveries` tables exist.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-sqlite.test.ts tests/migrations.test.ts
```

Expected: FAIL because SQLite platform event module and migration do not exist.

- [ ] **Step 3: Add migration**

Append this migration to `FRAMEWORK_MIGRATIONS` after `0013_auth_session_token_digests`:

```ts
{
  id: "0014_platform_events",
  schemaRevision: 1,
  description: "Create platform event pipeline tables.",
  sql: `
    CREATE TABLE IF NOT EXISTS platform_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      family TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      tenant_id TEXT,
      account_id TEXT,
      subject_id TEXT,
      trace_id TEXT,
      idempotency_key TEXT UNIQUE,
      payload TEXT NOT NULL,
      attributes TEXT NOT NULL
    );
    CREATE INDEX idx_platform_events_family_at ON platform_events (family, occurred_at DESC);
    CREATE INDEX idx_platform_events_tenant_at ON platform_events (tenant_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS platform_event_deliveries (
      consumer TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      acked_at TEXT,
      dead_lettered_at TEXT,
      last_error TEXT,
      PRIMARY KEY (consumer, event_id)
    );
    CREATE INDEX idx_platform_event_deliveries_status_available
      ON platform_event_deliveries (consumer, status, available_at);
    CREATE INDEX idx_platform_event_deliveries_event
      ON platform_event_deliveries (event_id);
  `,
}
```

Add to `FRAMEWORK_TABLES`:

```ts
"platform_events",
"platform_event_deliveries",
```

- [ ] **Step 4: Implement SQLite adapter**

Create `apps/server/src/platform-events/sqlite.ts`:

- Constructor accepts `DatabaseSync` and `{ retentionMs, maxRows, now? }`.
- `publish()` normalizes input, writes to `platform_events`, handles duplicate `idempotency_key` by returning the existing row with `duplicate: true`.
- `claim()` runs a transaction:
  - inserts missing pending delivery rows for the consumer from all retained events
  - selects pending/retryable rows by `status IN ('pending', 'retry') AND available_at <= ?`
  - updates them to `claimed`, increments attempt count, sets `claimed_at`
  - returns joined event rows mapped to `PlatformEventDelivery`
- `ack()` sets delivery status to `acked`.
- `retry()` sets delivery status to `retry`, stores `last_error`, and sets `available_at`.
- `deadLetter()` sets status `dead_lettered`, `dead_lettered_at`, and `last_error`.
- `health()` aggregates total retained events and delivery statuses by consumer.
- `prune()` mirrors `DevToolsEventStore.prune()`:
  - delete deliveries for pruned event ids first
  - delete old events by `occurred_at`
  - cap oldest events after age pruning
  - wrap in `BEGIN IMMEDIATE` / `COMMIT`, rollback on error.

- [ ] **Step 5: Wire FrickStore**

Modify `apps/server/src/store.ts`:

- Import `SqlitePlatformEventPipeline`, defaults, and types.
- Add store options:

```ts
platformEventsRetentionMs?: number;
platformEventsMaxRows?: number;
platformEventsPruneIntervalMs?: number;
```

- Add readonly property:

```ts
readonly platformEvents: SqlitePlatformEventPipeline;
```

- Add timer:

```ts
#platformEventsPruneTimer: ReturnType<typeof setInterval> | undefined;
```

- Construct after `devtoolsEvents`:

```ts
this.platformEvents = new SqlitePlatformEventPipeline(this.#db, {
  retentionMs: options.platformEventsRetentionMs ?? DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
  maxRows: options.platformEventsMaxRows ?? DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
});
```

- Add safe prune and close timer logic mirroring `#safeDevToolsPrune()`.

- [ ] **Step 6: Run SQLite tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-sqlite.test.ts tests/migrations.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/storage/migrations.ts apps/server/src/platform-events/sqlite.ts apps/server/src/store.ts apps/server/tests/platform-events-sqlite.test.ts apps/server/tests/migrations.test.ts
git commit -m "feat(server): add sqlite platform event pipeline"
```

## Task 3: Server Defaults and Authenticated Health Routes

**Files:**

- Modify: `apps/server/src/config.ts`
- Create: `apps/server/src/platform-events/factory.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/dashboard/metadata.ts`
- Create: `apps/server/tests/platform-events-routes.test.ts`
- Modify: `docs/operations.md`

- [ ] **Step 1: Write failing server route tests**

Create `apps/server/tests/platform-events-routes.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("platform event pipeline routes", () => {
  it("uses sqlite platform events by default and exposes authenticated inspection health", async () => {
    app = await startServer();
    await app.server.store.platformEvents.publish({
      family: "analytics.user_event",
      name: "message.sent",
      source: "test",
      tenantId: "_default",
    });

    const denied = await fetch(`${app.httpUrl}/_frick/inspect/platform-events`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${app.httpUrl}/_frick/inspect/platform-events`, {
      headers: await inspectHeaders(app.httpUrl),
    });
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    expect(body.adapter).toBe("sqlite");
    expect(body.ok).toBe(true);
    expect(body.retained).toBeGreaterThanOrEqual(1);
  });

  it("exposes mounted dashboard platform-event health with dashboard auth", async () => {
    app = await startServer();

    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/platform-events/health`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.adapter).toBe("sqlite");
    expect(body.ok).toBe(true);
  });
});

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...options,
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

async function inspectHeaders(httpUrl: string): Promise<Record<string, string>> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-ada" }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
  return { authorization: `Bearer ${body.sessionToken}` };
}
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-routes.test.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Add config and factory**

Modify `apps/server/src/config.ts`:

```ts
export type FrickPlatformEventsDriver = "sqlite" | "kafka";
```

Add to `FrickConfig`:

```ts
platformEventsDriver: FrickPlatformEventsDriver;
platformEventsTopic: string;
platformEventsKafkaBrokers: string[];
platformEventsRetentionMs: number;
platformEventsMaxRows: number;
```

Parse env vars:

- `FRICK_PLATFORM_EVENTS_DRIVER` default: `kafka` if `FRICK_PLATFORM_EVENTS_KAFKA_BROKERS` is non-empty, otherwise `sqlite`.
- `FRICK_PLATFORM_EVENTS_TOPIC` default: `frick.platform.events`.
- `FRICK_PLATFORM_EVENTS_KAFKA_BROKERS` comma-separated.
- `FRICK_PLATFORM_EVENTS_RETENTION_MS` default: 7 days.
- `FRICK_PLATFORM_EVENTS_MAX_ROWS` default: 1,000,000.

Create `apps/server/src/platform-events/factory.ts`:

```ts
import type { FrickConfig } from "../config.js";
import type { PlatformEventPipeline } from "./types.js";

export interface CreatePlatformEventPipelineInput {
  readonly config: FrickConfig;
  readonly sqlite: PlatformEventPipeline;
  readonly kafkaFactory?: () => PlatformEventPipeline;
}

export function createPlatformEventPipeline(input: CreatePlatformEventPipelineInput): PlatformEventPipeline {
  if (input.config.platformEventsDriver === "kafka") {
    if (!input.kafkaFactory) {
      throw new Error("Kafka platform events require a kafkaFactory until the Kafka adapter is wired");
    }
    return input.kafkaFactory();
  }
  return input.sqlite;
}
```

Task 4 replaces the temporary Kafka factory error with the real Kafka adapter.

- [ ] **Step 4: Wire server and routes**

Modify `ServerOptions` in `apps/server/src/server.ts`:

```ts
platformEvents?: PlatformEventPipeline;
```

Create:

```ts
const platformEvents = options.platformEvents ?? createPlatformEventPipeline({
  config,
  sqlite: store.platformEvents,
});
```

Return it from `createFrickServer` as `platformEvents`.

Close it only if it is not `store.platformEvents`:

```ts
if (platformEvents !== store.platformEvents) await platformEvents.close();
```

Add authenticated inspection route:

```ts
if (sub === "platform-events") {
  sendJson(response, 200, await platformEvents.health());
  return;
}
```

Add mounted dashboard route support by passing `platformEvents` into `handleDashboardRoute` and serving `/_frick/dashboard/api/platform-events/health` using the same auth path as metadata.

Modify `apps/server/src/dashboard/metadata.ts` input to optionally accept `platformEventsHealth` and include:

```ts
platformEvents?: PlatformEventHealth;
```

- [ ] **Step 5: Run server route tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-routes.test.ts tests/dashboard-routes.test.ts tests/ops-endpoints.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/platform-events/factory.ts apps/server/src/server.ts apps/server/src/dashboard/metadata.ts apps/server/tests/platform-events-routes.test.ts docs/operations.md
git commit -m "feat(server): expose platform event pipeline health"
```

## Task 4: Redpanda/Kafka Adapter Boundary

**Files:**

- Modify: `apps/server/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/server/src/platform-events/kafka.ts`
- Modify: `apps/server/src/platform-events/factory.ts`
- Create: `apps/server/tests/platform-events-kafka.test.ts`
- Modify: `docs/operations.md`

- [ ] **Step 1: Add dependency**

Run:

```bash
pnpm --filter @frick/server add kafkajs
```

Expected: `apps/server/package.json` and `pnpm-lock.yaml` update.

- [ ] **Step 2: Write optional Kafka conformance test**

Create `apps/server/tests/platform-events-kafka.test.ts`:

```ts
import { describe } from "vitest";
import { definePlatformEventPipelineConformance } from "./platform-events.conformance.js";
import { KafkaPlatformEventPipeline } from "../src/platform-events/kafka.js";

const brokers = process.env.FRICK_TEST_KAFKA_BROKERS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];

describe.skipIf(brokers.length === 0)("Kafka platform event pipeline", () => {
  definePlatformEventPipelineConformance({
    name: "kafka",
    async create() {
      return new KafkaPlatformEventPipeline({
        brokers,
        topic: `frick-platform-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        consumerGroup: `frick-platform-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
    },
  });
});
```

- [ ] **Step 3: Implement Kafka adapter**

Create `apps/server/src/platform-events/kafka.ts`:

- Use KafkaJS `Kafka`, `Producer`, and `Consumer`.
- Constructor accepts `{ brokers, topic, consumerGroup }` synchronously. Producer/admin/consumer connections are lazy so `createFrickServer()` remains synchronous.
- `publish()` writes normalized envelope JSON to Kafka with key `tenantId ?? id`.
- `claim()` in Kafka mode returns events buffered by the consumer loop. For this baseline, `claim()` starts a paused consumer and drains up to `batchSize` from an in-memory queue.
- `ack()` commits the Kafka offset associated with the event id for the consumer.
- `retry()` requeues by publishing the same event with an incremented attempt header and delayed retry is approximated by in-memory `availableAt` in the queue for this baseline.
- `deadLetter()` publishes the envelope plus error to `${topic}.dlq`.
- `health()` reports adapter `kafka`, `ok`, broker/topic metadata, pending queue length, and dead-letter count.
- `close()` disconnects producer, admin, and consumers.

Keep comments explicit: Kafka adapter is the production-profile baseline in this slice, while delayed retries and consumer-group lag parity require a separate follow-up plan.

- [ ] **Step 4: Wire factory**

Modify `apps/server/src/platform-events/factory.ts`:

```ts
import { KafkaPlatformEventPipeline } from "./kafka.js";
```

When `platformEventsDriver === "kafka"`:

```ts
return new KafkaPlatformEventPipeline({
  brokers: input.config.platformEventsKafkaBrokers,
  topic: input.config.platformEventsTopic,
  consumerGroup: "frick-server",
});
```

If brokers are empty, throw `FrickConfigError("FRICK_PLATFORM_EVENTS_KAFKA_BROKERS is required when FRICK_PLATFORM_EVENTS_DRIVER=kafka")`.

- [ ] **Step 5: Run Kafka tests without broker and typecheck**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-kafka.test.ts
pnpm typecheck
```

Expected: PASS with Kafka test skipped when `FRICK_TEST_KAFKA_BROKERS` is unset.

If a local Redpanda/Kafka broker is available, also run:

```bash
FRICK_TEST_KAFKA_BROKERS=127.0.0.1:9092 pnpm --filter @frick/server test -- tests/platform-events-kafka.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/platform-events/kafka.ts apps/server/src/platform-events/factory.ts apps/server/tests/platform-events-kafka.test.ts docs/operations.md
git commit -m "feat(server): add kafka platform event adapter"
```

## Task 5: Initial Runtime Publishers

**Files:**

- Modify: `apps/server/src/jobs/worker.ts`
- Modify: `apps/server/src/sync/gateway.ts`
- Modify: `apps/server/src/server.ts`
- Create: `apps/server/tests/platform-events-runtime.test.ts`

- [ ] **Step 1: Write failing runtime publishing tests**

Create `apps/server/tests/platform-events-runtime.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createFrickJobRegistry } from "../src/jobs/registry.js";
import { createFrickJobWorker, type FrickJobWorker } from "../src/jobs/worker.js";
import { createNoopLogger } from "../src/logger.js";
import { FrickStore } from "../src/store.js";

let store: FrickStore | undefined;
let worker: FrickJobWorker | undefined;

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  store?.close();
  store = undefined;
});

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

describe("runtime platform event publishers", () => {
  it("emits jobs.lifecycle events for completed jobs", async () => {
    store = new FrickStore({ path: ":memory:", seed: false });
    const registry = createFrickJobRegistry();
    registry.register("ExampleJob", async () => undefined);
    worker = createFrickJobWorker({
      store,
      registry,
      logger: createNoopLogger(),
      pollIntervalMs: 10,
      platformEvents: store.platformEvents,
    });
    worker.start();
    store.jobs.enqueue({ tenantId: "_default", jobType: "ExampleJob", payload: {} });

    await waitFor(() => store!.jobs.list({ status: "completed" }).length > 0 ? true : undefined);

    const [delivery] = await store.platformEvents.claim("test-observer");
    expect(delivery?.event).toMatchObject({
      family: "jobs.lifecycle",
      name: "job.completed",
      source: "frick.jobs",
      tenantId: "_default",
    });
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-runtime.test.ts
```

Expected: FAIL because worker does not accept/publish `platformEvents`.

- [ ] **Step 3: Wire job lifecycle publisher**

Modify `createFrickJobWorker` options in `apps/server/src/jobs/worker.ts`:

```ts
platformEvents?: PlatformEventPipeline;
```

After completed/dead-letter paths, call best-effort:

```ts
void platformEvents?.publish({
  family: "jobs.lifecycle",
  name: "job.completed",
  source: "frick.jobs",
  tenantId: job.tenantId,
  payload: { jobId: job.id, jobType: job.jobType, attemptCount: job.attemptCount },
}).catch(() => undefined);
```

Use `job.failed` and `job.dead_lettered` names for the other terminal/failure paths.

Modify `apps/server/src/server.ts` when creating the job worker to pass `platformEvents`.

- [ ] **Step 4: Run runtime tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-events-runtime.test.ts tests/jobs-worker.test.ts tests/devtools-events.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs/worker.ts apps/server/src/server.ts apps/server/tests/platform-events-runtime.test.ts
git commit -m "feat(server): emit job lifecycle platform events"
```

## Task 6: Dashboard and Docs

**Files:**

- Modify: `apps/dev-dashboard/dashboard.js`
- Modify: `apps/server/tests/dashboard-routes.test.ts`
- Modify: `docs/operations.md`
- Modify: `docs/status.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write failing dashboard asset assertion**

Append to the mounted dashboard metadata/script assertion in `apps/server/tests/dashboard-routes.test.ts`:

```ts
expect(await scriptResponse.text()).toContain("platform-events/health");
```

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-routes.test.ts
```

Expected: FAIL because the dashboard script does not fetch platform event health.

- [ ] **Step 2: Add dashboard fetch and summary**

Modify `apps/dev-dashboard/dashboard.js`:

- Add task:

```js
platformEvents: () => fetchJson("/_frick/dashboard/api/platform-events/health", { auth: true }),
```

only when mounted:

```js
async function fetchPlatformEventsHealth() {
  if (!isMountedDashboard()) return undefined;
  return fetchJson("/_frick/dashboard/api/platform-events/health", { auth: true });
}
```

- Skip `undefined` exactly like `dashboardMetadata`.
- Add `platformEvents` to `inspectionSummary()` with adapter, pending, deadLettered, and consumers length.

- [ ] **Step 3: Update docs**

Add to `docs/operations.md` under mounted dashboard/platform event config:

```md
The platform event pipeline defaults to SQLite for local and lightweight
self-hosted deployments. Set `FRICK_PLATFORM_EVENTS_DRIVER=kafka` plus
`FRICK_PLATFORM_EVENTS_KAFKA_BROKERS=host:9092` to use a Redpanda/Kafka-compatible
broker profile. The authenticated `/_frick/inspect/platform-events` and
`/_frick/dashboard/api/platform-events/health` routes report adapter health,
retained rows, pending deliveries, and dead-letter counts.
```

Update `docs/status.md` stable-enough bullet to mention platform event pipeline baseline.

Add `CHANGELOG.md` Unreleased repository bullet:

```md
- Added a platform event pipeline baseline with shared event contract, memory
  and SQLite adapters, Redpanda/Kafka adapter boundary, authenticated health
  routes, and initial job lifecycle events.
```

- [ ] **Step 4: Run dashboard/docs checks**

Run:

```bash
node --check apps/dev-dashboard/dashboard.js
pnpm --filter @frick/server test -- tests/dashboard-routes.test.ts tests/platform-events-routes.test.ts
rg -n "platform event|FRICK_PLATFORM_EVENTS|/_frick/inspect/platform-events|platform-events/health" docs CHANGELOG.md
```

Expected: PASS; grep shows new docs.

- [ ] **Step 5: Commit**

```bash
git add apps/dev-dashboard/dashboard.js apps/server/tests/dashboard-routes.test.ts docs/operations.md docs/status.md CHANGELOG.md
git commit -m "docs: document platform event pipeline baseline"
```

## Task 7: Final Verification

**Files:** no new files unless verification reveals a defect.

- [ ] **Step 1: Run focused tests**

```bash
pnpm --filter @frick/server test -- tests/platform-events-memory.test.ts tests/platform-events-sqlite.test.ts tests/platform-events-routes.test.ts tests/platform-events-runtime.test.ts tests/dashboard-routes.test.ts tests/migrations.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run dashboard parse check**

```bash
node --check apps/dev-dashboard/dashboard.js
```

Expected: PASS with no output.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full tests**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Check formatting hazards**

```bash
git diff --check
git status --short
```

Expected: no output from both commands.

- [ ] **Step 6: Boundary review**

Run:

```bash
git diff --name-only HEAD~6..HEAD
```

Expected:

- Event contract/adapters are under `apps/server/src/platform-events/*`.
- SQLite storage changes are migration/store-only.
- Server route changes are limited to option wiring, health routes, and job lifecycle publisher injection.
- No product analytics aggregation, OTel SDK, client SDK auto-tracking, or deployment generation appears in this slice.
