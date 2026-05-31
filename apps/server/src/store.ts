import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encode } from "@msgpack/msgpack";
import {
  foundationSchema,
  resolveObjectMergePolicy,
  validateSchema,
  type FrickObjectMergePolicy,
  type FrickSchema,
  type PlainObject,
} from "@frick/protocol";
import { AccountStore, type StoredAccount } from "./storage/account-store.js";
import { PasswordResetTokenStore } from "./storage/password-reset-store.js";
import { AdminAuditStore } from "./storage/admin-audit-store.js";
import { BlobStore, type BlobMetadata, type BlobMetadataInput } from "./storage/blob-store.js";
import {
  createBlobBytesDriver,
  type FrickBlobDriver,
} from "./storage/blob-bytes-driver.js";
import { BlobDerivativeStore } from "./storage/blob-derivative-store.js";
import {
  createFrickBlobProcessorRegistry,
  type FrickBlobProcessorRegistry,
} from "./blobs/processor.js";
import { JobStore, type StoredJob } from "./storage/job-store.js";
import { ObjectStore, type ObjectUpsertResult } from "./storage/object-store.js";
import { PresenceStore } from "./storage/presence-store.js";
import { PushRegistrationStore } from "./storage/push-registration-store.js";
import { initializeStorage } from "./storage/schema.js";
import { SessionStore, type StoredSession } from "./storage/session-store.js";
import { TenantStore } from "./storage/tenant-store.js";
import { InvitationStore } from "./storage/invitation-store.js";
import { GrantStore } from "./storage/grant-store.js";
import { TenantSettingsStore } from "./storage/tenant-settings-store.js";
import { SignalStore } from "./storage/signal-store.js";
import {
  StreamStore,
  type AppendInput,
  type AppendResult,
  type CachedIdempotentEvent,
  type StoredEvent,
} from "./storage/stream-store.js";
import { BoundedIdempotencyCache } from "./storage/idempotency-cache.js";
import { listAppliedMigrations, type AppliedMigrationRow } from "./storage/migrations.js";
import { createNoopLogger, type FrickLogger } from "./logger.js";
import {
  createFrickProjectionRegistry,
  type FrickProjectionContext,
  type FrickProjectionRegistry,
  type FrickProjectionWriteEvent,
} from "./projections/registry.js";
import {
  createFrickSearchIndexRegistry,
  type FrickSearchAdapter,
  type FrickSearchIndexRegistry,
  type FrickSearchProjectInput,
} from "./search/types.js";
import { createSqliteFtsSearchAdapter } from "./search/sqlite-fts.js";
import { withSearchSourceFields } from "./search/source-fields.js";
import {
  DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS,
  DEFAULT_DEVTOOLS_EVENTS_PRUNE_INTERVAL_MS,
  DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS,
  DevToolsEventStore,
} from "./devtools/event-store.js";
import {
  DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
  DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS,
  DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
  SqlitePlatformEventPipeline,
} from "./platform-events/sqlite.js";
import { AnalyticsEventStore } from "./analytics/summary.js";
import { DEFAULT_TENANT_ID } from "./tenant.js";

/**
 * Default capacity of the in-process idempotency front-cache. Sized to absorb
 * the request-id working set of a moderately busy server (~10k recent appends)
 * while keeping worst-case memory bounded. Capacity-evicted entries fall
 * through to the durable `idempotency_keys` SQLite table on the next lookup,
 * so this is purely a hot-path optimisation — never a correctness boundary.
 */
export const DEFAULT_IDEMPOTENCY_CACHE_CAPACITY = 10_000;

/** Default retention window for durable idempotency records: 24 hours. */
export const DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Default hard cap on `idempotency_keys` rows, independent of age. */
export const DEFAULT_IDEMPOTENCY_KEY_MAX_ROWS = 100_000;
/** Default interval between background prune passes: 15 minutes. */
export const DEFAULT_IDEMPOTENCY_KEY_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
/**
 * Default replay window for `requestId` idempotency: 24 hours. Enforced at
 * lookup time so a requestId whose record is older than the window is no longer
 * deduped, independent of when the durable retention prune actually removes the
 * row.
 */
export const DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PruneResult {
  /** Rows removed because their `created_at` was older than `retentionMs`. */
  prunedByAge: number;
  /** Rows removed to bring the table down to `maxRows` after the age sweep. */
  prunedByCap: number;
}

export interface StoreOptions {
  path: string;
  schema?: FrickSchema;
  seed?: boolean;
  /**
   * Blob-bytes storage driver (FR-53). `sqlite` (the default) keeps blob bytes
   * in the SQLite `blob_content` table; `filesystem` writes them under
   * {@link StoreOptions.blobStoragePath}. Blob metadata always lives in SQLite
   * regardless of this setting.
   */
  blobDriver?: FrickBlobDriver;
  /**
   * Filesystem root for blob bytes. Required and validated (writable directory)
   * when {@link StoreOptions.blobDriver} is `filesystem`; ignored otherwise.
   */
  blobStoragePath?: string;
  /**
   * Capacity of the in-process LRU front cache for idempotency lookups.
   * Defaults to {@link DEFAULT_IDEMPOTENCY_CACHE_CAPACITY}. Eviction is purely
   * recency-based; evicted entries simply fall through to the SQLite source
   * of truth on the next access.
   */
  idempotencyCacheCapacity?: number;
  /**
   * How long a durable idempotency record is retained before it becomes
   * eligible for pruning. Defaults to 24h. Once a record is pruned, a retry
   * with the same `(replicaId, requestId)` produces a fresh result — the
   * idempotency guarantee only applies within this window.
   */
  idempotencyKeyRetentionMs?: number;
  /**
   * Hard upper bound on the size of the durable `idempotency_keys` table,
   * applied after the age-based sweep. Defaults to 100,000 rows.
   */
  idempotencyKeyMaxRows?: number;
  /**
   * Interval between background prune passes. Defaults to 15 minutes. Set to
   * `0` to disable the timer (prune still runs once during construction).
   */
  idempotencyKeyPruneIntervalMs?: number;
  /**
   * Replay window (ms) for `requestId` idempotency, enforced on lookup. A
   * record whose `created_at` is older than this window is treated as
   * not-seen, so a retry beyond the window produces a fresh event. This is the
   * lookup-time bound and is independent of {@link StoreOptions.idempotencyKeyRetentionMs}
   * (which drives durable row pruning on a timer): the window holds even when
   * pruning is disabled or has not yet run. Defaults to
   * {@link DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS} (24h).
   */
  idempotencyReplayWindowMs?: number;
  /**
   * Projection registry that receives notify(...) calls after every
   * object/stream write through this FrickStore facade. When omitted, the
   * store constructs an empty registry — callers (typically
   * `createFrickServer`) can register projections via `store.projections`
   * before issuing writes.
   */
  projections?: FrickProjectionRegistry;
  /**
   * Optional search adapter. When omitted, the store constructs the default
   * {@link createSqliteFtsSearchAdapter} bound to its own SQLite handle.
   */
  searchAdapter?: FrickSearchAdapter;
  /**
   * Optional search-index registry. Apps register indexes against source
   * primitives (objects, streams, projections). When omitted, the store
   * creates an empty registry.
   */
  searchIndexes?: FrickSearchIndexRegistry;
  /**
   * Logger threaded into projection contexts so handler failures surface
   * through the same structured-logging pipeline as the rest of the server.
   * Defaults to a no-op logger.
   */
  logger?: FrickLogger;
  /**
   * Retention window (ms) for the DevTools event feed. Older rows are dropped
   * by the prune timer. Defaults to {@link DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS}
   * (1 hour).
   */
  devtoolsEventsRetentionMs?: number;
  /**
   * Hard upper bound on the size of the `devtools_events` table, applied after
   * the age-based sweep. Defaults to {@link DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS}.
   */
  devtoolsEventsMaxRows?: number;
  /**
   * Interval between background DevTools-event prune passes. Defaults to
   * {@link DEFAULT_DEVTOOLS_EVENTS_PRUNE_INTERVAL_MS} (60s). Set to `0` to
   * disable the timer (prune still runs once at construction).
   */
  devtoolsEventsPruneIntervalMs?: number;
  /**
   * Retention window (ms) for the platform event pipeline. Older rows are
   * dropped by the prune timer. Defaults to
   * {@link DEFAULT_PLATFORM_EVENTS_RETENTION_MS} (7 days).
   */
  platformEventsRetentionMs?: number;
  /**
   * Hard upper bound on the size of the `platform_events` table, applied after
   * the age-based sweep. Defaults to
   * {@link DEFAULT_PLATFORM_EVENTS_MAX_ROWS}.
   */
  platformEventsMaxRows?: number;
  /**
   * Interval between background platform-event prune passes. Defaults to
   * {@link DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS} (15 min). Set to `0` to
   * disable the timer (prune still runs once at construction).
   */
  platformEventsPruneIntervalMs?: number;
}

/**
 * Change notification emitted by the store on every successful object upsert
 * and stream append, regardless of which caller drove the write (a client WS
 * frame, an HTTP route, or a server-side job calling `store.upsertObject` /
 * `store.appendEvent` directly). It carries exactly what the sync gateway
 * needs to build the on-the-wire delta frame, so the gateway can fan out
 * server-originated writes to already-subscribed connections — closing the
 * gap where background jobs/app routes persisted data but never live-pushed
 * it (FR-114).
 *
 * The store does NOT broadcast itself: it only emits. A single consumer (the
 * sync gateway) registers via {@link FrickStore.setWriteListener} and owns
 * the fan-out + cluster-bus forwarding. Keeping the store as the *only*
 * emission point means every write path broadcasts through exactly one funnel
 * — there is no second inline broadcast to double-fire.
 */
export type FrickStoreWriteEvent =
  | {
      kind: "objectUpsert";
      tenantId: string;
      objectType: string;
      objectId: string;
      /** Stored (post-merge) object state, including its `id` field. */
      object: PlainObject;
    }
  | {
      kind: "streamAppend";
      tenantId: string;
      /** The freshly-appended, persisted event. */
      event: StoredEvent;
    };

/** Consumer of {@link FrickStoreWriteEvent}s — the sync gateway. */
export type FrickStoreWriteListener = (event: FrickStoreWriteEvent) => void;

export class FrickStore {
  readonly schema: FrickSchema;
  readonly objects: ObjectStore;
  // `streams` and `idempotencyCache` are rebuilt by `prune()` when an
  // age-based sweep removes durable rows: the in-memory LRU may still hold
  // stale `(tenantId, replicaId, requestId)` mappings that — after retention
  // — must not satisfy a retry. Rebuilding both together swaps a fresh cache
  // into the StreamStore without violating the cache module's encapsulation.
  streams: StreamStore;
  idempotencyCache: BoundedIdempotencyCache<CachedIdempotentEvent>;
  readonly presence: PresenceStore;
  readonly signals: SignalStore;
  readonly blobs: BlobStore;
  readonly blobDerivatives: BlobDerivativeStore;
  readonly blobProcessors: FrickBlobProcessorRegistry;
  readonly jobs: JobStore;
  readonly sessions: SessionStore;
  readonly accounts: AccountStore;
  readonly passwordResetTokens: PasswordResetTokenStore;
  readonly tenants: TenantStore;
  readonly invitations: InvitationStore;
  readonly grants: GrantStore;
  readonly tenantSettings: TenantSettingsStore;
  readonly adminAudit: AdminAuditStore;
  readonly pushRegistrations: PushRegistrationStore;
  readonly devtoolsEvents: DevToolsEventStore;
  readonly platformEvents: SqlitePlatformEventPipeline;
  readonly analyticsEvents: AnalyticsEventStore;
  readonly projections: FrickProjectionRegistry;
  readonly searchAdapter: FrickSearchAdapter;
  readonly searchIndexes: FrickSearchIndexRegistry;
  readonly #logger: FrickLogger;

  readonly #db: DatabaseSync;
  /**
   * Narrow accessor for the underlying SQLite handle. Exposed for the
   * compliance module which needs raw cross-table read/write access for
   * data-subject export and erase — building a per-table API for every
   * GDPR-shaped query would balloon the store surface. Treat this as a
   * private extension point: do not reach in from feature code, and never
   * cross tenant boundaries without resolving them through the existing
   * stores' tenant validation first.
   */
  get db(): DatabaseSync {
    return this.#db;
  }
  readonly #idempotencyCacheCapacity: number;
  readonly #idempotencyKeyRetentionMs: number;
  readonly #idempotencyKeyMaxRows: number;
  readonly #idempotencyReplayWindowMs: number;
  #pruneTimer: ReturnType<typeof setInterval> | undefined;
  #devtoolsPruneTimer: ReturnType<typeof setInterval> | undefined;
  #platformEventsPruneTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  /**
   * Single optional consumer of object-upsert / stream-append change events,
   * set by the sync gateway at boot via {@link setWriteListener}. The store
   * never broadcasts directly; it only fires this hook so the gateway can fan
   * the change out to subscribers (and onto the cluster bus) — see
   * {@link FrickStoreWriteEvent}.
   */
  #writeListener: FrickStoreWriteListener | undefined;

  constructor(options: StoreOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }

    this.schema = validateSchema(options.schema ?? foundationSchema);
    this.#db = new DatabaseSync(options.path);
    initializeStorage(this.#db, this.schema.schemaRevision);
    this.#recordSchema();

    this.#idempotencyCacheCapacity =
      options.idempotencyCacheCapacity ?? DEFAULT_IDEMPOTENCY_CACHE_CAPACITY;
    this.#idempotencyKeyRetentionMs =
      options.idempotencyKeyRetentionMs ?? DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS;
    this.#idempotencyKeyMaxRows =
      options.idempotencyKeyMaxRows ?? DEFAULT_IDEMPOTENCY_KEY_MAX_ROWS;
    this.#idempotencyReplayWindowMs =
      options.idempotencyReplayWindowMs ?? DEFAULT_IDEMPOTENCY_REPLAY_WINDOW_MS;

    this.idempotencyCache = new BoundedIdempotencyCache<CachedIdempotentEvent>(
      this.#idempotencyCacheCapacity,
    );
    this.objects = new ObjectStore(this.#db, this.schema);
    this.streams = new StreamStore(this.#db, this.schema, this.idempotencyCache, {
      replayWindowMs: this.#idempotencyReplayWindowMs,
    });
    this.presence = new PresenceStore(this.#db, this.schema);
    this.signals = new SignalStore(this.#db, this.schema);
    this.blobs = new BlobStore(
      this.#db,
      createBlobBytesDriver({
        driver: options.blobDriver ?? "sqlite",
        db: this.#db,
        blobStoragePath: options.blobStoragePath,
      }),
    );
    this.blobDerivatives = new BlobDerivativeStore(this.#db);
    this.blobProcessors = createFrickBlobProcessorRegistry();
    this.jobs = new JobStore(this.#db);
    this.sessions = new SessionStore(this.#db);
    this.accounts = new AccountStore(this.#db);
    this.passwordResetTokens = new PasswordResetTokenStore(this.#db);
    this.tenants = new TenantStore(this.#db);
    this.invitations = new InvitationStore(this.#db);
    this.grants = new GrantStore(this.#db);
    this.tenantSettings = new TenantSettingsStore(this.#db);
    this.adminAudit = new AdminAuditStore(this.#db);
    this.pushRegistrations = new PushRegistrationStore(this.#db);
    this.devtoolsEvents = new DevToolsEventStore(this.#db, {
      retentionMs:
        options.devtoolsEventsRetentionMs ?? DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS,
      maxRows: options.devtoolsEventsMaxRows ?? DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS,
    });
    this.platformEvents = new SqlitePlatformEventPipeline(this.#db, {
      retentionMs:
        options.platformEventsRetentionMs ?? DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
      maxRows: options.platformEventsMaxRows ?? DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
    });
    this.analyticsEvents = new AnalyticsEventStore(this.#db);
    this.projections = options.projections ?? createFrickProjectionRegistry();
    this.searchAdapter = options.searchAdapter ?? createSqliteFtsSearchAdapter(this.#db);
    this.searchIndexes = options.searchIndexes ?? createFrickSearchIndexRegistry();
    this.#logger = options.logger ?? createNoopLogger();
    void options.seed;

    // Run once at startup to mop up after a crashed previous run, then on a
    // recurring timer. Both are guarded against post-close calls.
    this.#safePrune();
    const intervalMs =
      options.idempotencyKeyPruneIntervalMs ?? DEFAULT_IDEMPOTENCY_KEY_PRUNE_INTERVAL_MS;
    if (intervalMs > 0) {
      this.#pruneTimer = setInterval(() => this.#safePrune(), intervalMs);
      // Don't keep the event loop alive just to run a maintenance timer.
      this.#pruneTimer.unref?.();
    }

    // DevTools event log retention. Same shape as the idempotency-keys prune
    // (one shot at boot to mop up after a previous run, then on a recurring
    // timer). The DevTools feed accumulates faster than idempotency keys —
    // one row per HTTP request — so the default cadence is tighter (60s vs
    // 15 min) to keep the rolling window honest.
    this.#safeDevToolsPrune();
    const devtoolsIntervalMs =
      options.devtoolsEventsPruneIntervalMs ?? DEFAULT_DEVTOOLS_EVENTS_PRUNE_INTERVAL_MS;
    if (devtoolsIntervalMs > 0) {
      this.#devtoolsPruneTimer = setInterval(
        () => this.#safeDevToolsPrune(),
        devtoolsIntervalMs,
      );
      this.#devtoolsPruneTimer.unref?.();
    }

    this.#safePlatformEventsPrune();
    const platformEventsIntervalMs =
      options.platformEventsPruneIntervalMs ?? DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS;
    if (platformEventsIntervalMs > 0) {
      this.#platformEventsPruneTimer = setInterval(
        () => this.#safePlatformEventsPrune(),
        platformEventsIntervalMs,
      );
      this.#platformEventsPruneTimer.unref?.();
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#pruneTimer) {
      clearInterval(this.#pruneTimer);
      this.#pruneTimer = undefined;
    }
    if (this.#devtoolsPruneTimer) {
      clearInterval(this.#devtoolsPruneTimer);
      this.#devtoolsPruneTimer = undefined;
    }
    if (this.#platformEventsPruneTimer) {
      clearInterval(this.#platformEventsPruneTimer);
      this.#platformEventsPruneTimer = undefined;
    }
    this.#db.close();
  }

  #safeDevToolsPrune(): void {
    if (this.#closed) return;
    try {
      this.devtoolsEvents.prune();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[frick] devtools_events prune failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  #safePlatformEventsPrune(): void {
    if (this.#closed) return;
    try {
      this.platformEvents.prune();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[frick] platform_events prune failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Prune the durable `idempotency_keys` table.
   *
   * Two passes, in a single transaction:
   *   1. Delete rows whose `created_at` is older than the retention window.
   *   2. If row count still exceeds the configured max, delete the oldest
   *      rows until the table is at or below the cap.
   *
   * After an age-based sweep, the in-memory LRU front cache may still hold
   * `(tenantId, replicaId, requestId)` entries whose durable backing was just
   * deleted. Returning those from the cache would defeat retention — so on
   * any age-driven prune we rebuild the cache (and the StreamStore that
   * holds a reference to it). The cap-only pass is treated the same way for
   * simplicity; both are rare maintenance events.
   */
  prune(): PruneResult {
    if (this.#closed) {
      return { prunedByAge: 0, prunedByCap: 0 };
    }
    const now = Date.now();
    const globalCutoffIso = new Date(now - this.#idempotencyKeyRetentionMs).toISOString();
    // Per-tenant retention overrides: any tenant with a `retentionMs` row in
    // tenant_settings uses its own cutoff instead of the global one.
    const overrides = this.#db
      .prepare(
        `SELECT tenant_id, setting_value FROM tenant_settings
          WHERE setting_key = 'retentionMs'`,
      )
      .all() as Array<{ tenant_id: string; setting_value: string }>;
    const tenantCutoffs = new Map<string, string>();
    for (const row of overrides) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.setting_value);
      } catch {
        continue;
      }
      if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
        continue;
      }
      tenantCutoffs.set(row.tenant_id, new Date(now - parsed).toISOString());
    }
    this.#db.exec("BEGIN IMMEDIATE");
    let prunedByAge = 0;
    let prunedByCap = 0;
    try {
      for (const [tenantId, cutoffIso] of tenantCutoffs) {
        const r = this.#db
          .prepare(
            "DELETE FROM idempotency_keys WHERE tenant_id = ? AND created_at < ?",
          )
          .run(tenantId, cutoffIso);
        prunedByAge += Number(r.changes ?? 0);
      }
      // Remaining tenants use the global cutoff. Build an `NOT IN (...)`
      // clause; with no overrides this collapses to a plain WHERE clause.
      let ageResult;
      if (tenantCutoffs.size === 0) {
        ageResult = this.#db
          .prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
          .run(globalCutoffIso);
      } else {
        const placeholders = Array.from(tenantCutoffs.keys()).map(() => "?").join(",");
        ageResult = this.#db
          .prepare(
            `DELETE FROM idempotency_keys
              WHERE created_at < ?
                AND tenant_id NOT IN (${placeholders})`,
          )
          .run(globalCutoffIso, ...tenantCutoffs.keys());
      }
      prunedByAge += Number(ageResult.changes ?? 0);

      const remaining = this.#db
        .prepare("SELECT COUNT(*) AS count FROM idempotency_keys")
        .get() as { count: number };
      const overflow = Number(remaining.count) - this.#idempotencyKeyMaxRows;
      if (overflow > 0) {
        const capResult = this.#db
          .prepare(
            `DELETE FROM idempotency_keys
              WHERE rowid IN (
                SELECT rowid FROM idempotency_keys
                  ORDER BY created_at ASC, rowid ASC
                  LIMIT ?
              )`,
          )
          .run(overflow);
        prunedByCap = Number(capResult.changes ?? 0);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Swallow — surface the original cause.
      }
      throw error;
    }

    if (prunedByAge > 0 || prunedByCap > 0) {
      // Rebuild the front cache so stale entries can't survive retention.
      this.idempotencyCache = new BoundedIdempotencyCache<CachedIdempotentEvent>(
        this.#idempotencyCacheCapacity,
      );
      this.streams = new StreamStore(this.#db, this.schema, this.idempotencyCache, {
        replayWindowMs: this.#idempotencyReplayWindowMs,
      });
    }

    return { prunedByAge, prunedByCap };
  }

  /** Current row count of the durable `idempotency_keys` table. Read-only. */
  idempotencyKeyRowCount(): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM idempotency_keys")
      .get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  #safePrune(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.prune();
    } catch (error) {
      // Never let a maintenance failure tear down the process.
      // eslint-disable-next-line no-console
      console.warn(
        `[frick] idempotency_keys prune failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Cheap liveness probe used by the `/ready` endpoint. Returns true if the
   * database responds to a trivial `SELECT 1`. Surfaced here rather than
   * exposing the DatabaseSync handle directly.
   */
  pingDatabase(): boolean {
    try {
      const row = this.#db.prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  /** List applied migrations recorded in the `frick_migrations` ledger. */
  listAppliedMigrations(): AppliedMigrationRow[] {
    return listAppliedMigrations(this.#db);
  }

  /**
   * Internal escape hatch used by the backup/restore subsystem. The dump
   * format needs to read every row of every framework table in a fixed
   * order, and the restore needs to insert rows directly without going
   * through the higher-level typed APIs (which apply seeding semantics, fire
   * projection notifications, etc.). Both modules accept a raw
   * {@link DatabaseSync} handle so they can stream rows efficiently.
   *
   * NOT part of the public store API — `apps/server/src/backup/*` is the
   * only consumer. Treat it like a `package private` member.
   */
  rawDatabase(): DatabaseSync {
    return this.#db;
  }

  // ---- Tenant-scoped facades --------------------------------------------
  //
  // The legacy API used method names like `upsertObject(type, id, value)`
  // with no tenant argument. The framework still supports those — they
  // implicitly target {@link DEFAULT_TENANT_ID}. For new tenant-aware code,
  // every method also has a leading-`tenantId` variant. This keeps existing
  // tests (which all operate in the default tenant) green while threading a
  // tenant boundary through every public surface.

  upsertObject(type: string, id: string, value: PlainObject, version?: number): void;
  upsertObject(tenantId: string, type: string, id: string, value: PlainObject, version?: number): void;
  upsertObject(
    a: string,
    b: string | PlainObject,
    c?: string | PlainObject | number,
    d?: PlainObject | number,
    e?: number,
  ): void {
    if (typeof b === "string" && (typeof c === "string" || c === undefined)) {
      // 5-arg form: (tenantId, type, id, value, version?)
      const tenantId = a;
      const type = b;
      const id = c as string;
      const value = d as PlainObject;
      const version = (e as number | undefined) ?? 0;
      this.objects.upsert(tenantId, type, id, value, version);
      const stored = this.objects.read(tenantId, type, id) ?? value;
      this.#notifyProjections({
        kind: "objectUpsert",
        tenantId,
        objectType: type,
        objectId: id,
        object: stored,
      });
      this.#notifySearchForObject(tenantId, type, id, stored);
      this.#notifyWriteListener({
        kind: "objectUpsert",
        tenantId,
        objectType: type,
        objectId: id,
        object: stored,
      });
      return;
    }
    // 4-arg form: (type, id, value, version?)
    const type = a;
    const id = b as string;
    const value = c as PlainObject;
    const version = (d as number | undefined) ?? 0;
    this.objects.upsert(DEFAULT_TENANT_ID, type, id, value, version);
    const stored = this.objects.read(DEFAULT_TENANT_ID, type, id) ?? value;
    this.#notifyProjections({
      kind: "objectUpsert",
      tenantId: DEFAULT_TENANT_ID,
      objectType: type,
      objectId: id,
      object: stored,
    });
    this.#notifySearchForObject(DEFAULT_TENANT_ID, type, id, stored);
    this.#notifyWriteListener({
      kind: "objectUpsert",
      tenantId: DEFAULT_TENANT_ID,
      objectType: type,
      objectId: id,
      object: stored,
    });
  }

  #notifySearchForObject(tenantId: string, type: string, id: string, value: PlainObject): void {
    this.#notifySearch(
      (input) => input,
      ({ source }) => source.kind === "object" && source.type === type,
      { tenantId, object: { type, id, value } },
    );
  }

  /**
   * Tenant-aware object write that honors the schema-declared merge policy.
   *
   * Resolves `mergePolicy` from the schema (defaulting to "lastWriteWins"
   * when the {@link ObjectDef} omits the field) and delegates to the
   * underlying {@link ObjectStore.upsertWithPolicy}. Throws
   * {@link FrickObjectVersionConflictError} when a versionPrecondition write
   * disagrees with the on-disk version.
   *
   * The legacy positional {@link upsertObject} signature still works for
   * existing callers — that path is unconditional (lastWriteWins semantics).
   */
  upsertObjectWithPolicy(args: {
    tenantId?: string;
    type: string;
    id: string;
    value: PlainObject;
    expectedVersion?: number;
  }): ObjectUpsertResult {
    const tenantId = args.tenantId ?? DEFAULT_TENANT_ID;
    const mergePolicy: FrickObjectMergePolicy = resolveObjectMergePolicy(
      this.schema,
      args.type,
    );
    const result = this.objects.upsertWithPolicy({
      tenantId,
      objectType: args.type,
      objectId: args.id,
      value: args.value,
      ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
      mergePolicy,
    });
    // Fan a write notification to projections + search on every successful
    // upsert (the policy path throws on conflict, so reaching here means the
    // row was written). This mirrors the legacy positional `upsertObject` and
    // the `appendEvent` stream path — without it, object-sourced projections
    // and search indexes would never observe writes made through the HTTP
    // object route or the WebSocket ObjectUpsert frame.
    const stored = this.objects.read(tenantId, args.type, args.id) ?? args.value;
    this.#notifyProjections({
      kind: "objectUpsert",
      tenantId,
      objectType: args.type,
      objectId: args.id,
      object: stored,
    });
    this.#notifySearchForObject(tenantId, args.type, args.id, stored);
    this.#notifyWriteListener({
      kind: "objectUpsert",
      tenantId,
      objectType: args.type,
      objectId: args.id,
      object: stored,
    });
    return result;
  }

  /** Effective merge policy for an object type, resolved from the schema. */
  objectMergePolicy(type: string): FrickObjectMergePolicy {
    return resolveObjectMergePolicy(this.schema, type);
  }

  /**
   * Remove an object row. Returns true when a row was actually deleted,
   * false when the (type, id) tuple was already absent — idempotent.
   * Mirrors the positional/tenant-aware overload set of {@link readObject}.
   */
  deleteObject(type: string, id: string): boolean;
  deleteObject(tenantId: string, type: string, id: string): boolean;
  deleteObject(a: string, b: string, c?: string): boolean {
    if (c !== undefined) {
      return this.objects.delete(a, b, c);
    }
    return this.objects.delete(DEFAULT_TENANT_ID, a, b);
  }

  readObject(type: string, id: string): PlainObject | undefined;
  readObject(tenantId: string, type: string, id: string): PlainObject | undefined;
  readObject(a: string, b: string, c?: string): PlainObject | undefined {
    if (c !== undefined) {
      return this.objects.read(a, b, c);
    }
    return this.objects.read(DEFAULT_TENANT_ID, a, b);
  }

  listObjects(type: string): PlainObject[];
  listObjects(tenantId: string, type: string): PlainObject[];
  listObjects(a: string, b?: string): PlainObject[] {
    if (b !== undefined) {
      return this.objects.list(a, b);
    }
    return this.objects.list(DEFAULT_TENANT_ID, a);
  }

  listObjectsForUser(type: string, userId: string): PlainObject[];
  listObjectsForUser(tenantId: string, type: string, userId: string): PlainObject[];
  listObjectsForUser(a: string, b: string, c?: string): PlainObject[] {
    const tenantId = c !== undefined ? a : DEFAULT_TENANT_ID;
    const type = c !== undefined ? b : a;
    const userId = c !== undefined ? c : b;
    return this.listObjects(tenantId, type).filter((object) =>
      this.isObjectVisibleToUser(tenantId, type, object, userId),
    );
  }

  isObjectVisibleToUser(type: string, object: PlainObject, userId: string): boolean;
  isObjectVisibleToUser(
    tenantId: string,
    type: string,
    object: PlainObject,
    userId: string,
  ): boolean;
  isObjectVisibleToUser(
    a: string,
    b: string | PlainObject,
    c: PlainObject | string,
    d?: string,
  ): boolean {
    const tenantId = d !== undefined ? a : DEFAULT_TENANT_ID;
    const type = d !== undefined ? (b as string) : a;
    const object = d !== undefined ? (c as PlainObject) : (b as PlainObject);
    const userId = d !== undefined ? d : (c as string);
    void tenantId;
    void type;
    void object;
    void userId;
    return true;
  }

  appendEvent(input: Omit<AppendInput, "tenantId"> & { tenantId?: string }): AppendResult {
    const result = this.streams.append({
      ...input,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
    });
    if (result.created) {
      this.#notifyProjections({
        kind: "streamEvent",
        tenantId: result.event.tenantId,
        streamType: result.event.stream,
        streamId: result.event.streamId,
        streamEvent: result.event,
      });
      this.#notifySearch(
        (i) => i,
        ({ source }) => source.kind === "stream" && source.type === result.event.stream,
        {
          tenantId: result.event.tenantId,
          streamEvent: {
            stream: result.event.stream,
            streamId: result.event.streamId,
            sequence: result.event.sequence,
            eventId: result.event.eventId,
            event: result.event.event,
            payload: result.event.payload,
          },
        },
      );
      this.#notifyWriteListener({
        kind: "streamAppend",
        tenantId: result.event.tenantId,
        event: result.event,
      });
    }
    return result;
  }

  /**
   * Dispatch a search-indexer notification after a write. Iterates every
   * registered index whose `source` matches the event kind/type and, for
   * each non-null doc returned by `project()`, calls `searchAdapter.upsert`.
   * Adapter failures are logged and swallowed — never let an indexer hiccup
   * tear down the originating write.
   */
  #notifySearch(
    pick: (def: FrickSearchProjectInput) => FrickSearchProjectInput,
    matches: (def: { source: { kind: string; type?: string; name?: string } }) => boolean,
    input: FrickSearchProjectInput,
  ): void {
    for (const def of this.searchIndexes.list()) {
      const source = def.source as { kind: string; type?: string; name?: string };
      if (!matches({ source })) continue;
      let doc: ReturnType<typeof def.project>;
      try {
        doc = def.project(pick(input));
      } catch (error) {
        this.#logger.warn("frick.search.project_failed", {
          index: def.name,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!doc) continue;
      try {
        this.searchAdapter.upsert(input.tenantId, def.name, withSearchSourceFields(input, doc));
      } catch (error) {
        this.#logger.warn("frick.search.upsert_failed", {
          index: def.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Fire a projection-notify event with the FrickStore-level context.
   * Wrapped in a private method so each write path stays a one-liner and
   * the construction of {@link FrickProjectionContext} lives in a single
   * spot — easier to extend (e.g. attach request-scoped logger fields) later.
   */
  #notifyProjections(event: FrickProjectionWriteEvent): void {
    const ctx: FrickProjectionContext = {
      tenantId: event.tenantId,
      store: this,
      logger: this.#logger,
    };
    this.projections.notify(event, ctx);
  }

  /**
   * Register the single store-write listener (the sync gateway). Passing
   * `undefined` detaches it — the gateway does this on close so a torn-down
   * gateway never fans out after its sockets are gone. Replaces any existing
   * listener; only one consumer is expected, matching the projection
   * delta-listener model.
   */
  setWriteListener(listener: FrickStoreWriteListener | undefined): void {
    this.#writeListener = listener;
  }

  /**
   * Fire the store-write listener for a successful object/stream write. Any
   * listener throw is swallowed and logged — a fan-out hiccup must never tear
   * down the originating write, mirroring how {@link #notifySearch} isolates
   * indexer failures.
   */
  #notifyWriteListener(event: FrickStoreWriteEvent): void {
    if (!this.#writeListener) {
      return;
    }
    try {
      this.#writeListener(event);
    } catch (error) {
      this.#logger.warn("frick.store.write_listener_failed", {
        kind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  readEvents(stream: string, streamId: string, after: number, limit?: number): StoredEvent[];
  readEvents(
    tenantId: string,
    stream: string,
    streamId: string,
    after: number,
    limit?: number,
  ): StoredEvent[];
  readEvents(
    a: string,
    b: string,
    c: string | number,
    d?: number,
    e?: number,
  ): StoredEvent[] {
    if (typeof c === "number") {
      return this.streams.read(DEFAULT_TENANT_ID, a, b, c, d);
    }
    return this.streams.read(a, b, c, d ?? 0, e);
  }

  /**
   * Backwards-paginated event read for `loadOlder`-style scrollback. Forwards
   * to {@link StreamStore.readBefore}. `before` is exclusive; `limit` is
   * clamped server-side to `[1, 500]`.
   */
  readEventsBefore(
    tenantId: string,
    stream: string,
    streamId: string,
    before: number,
    limit: number,
  ): StoredEvent[] {
    return this.streams.readBefore(tenantId, stream, streamId, before, limit);
  }

  setPresence(type: string, key: string, value: PlainObject, ttlMs: number): void;
  setPresence(
    tenantId: string,
    type: string,
    key: string,
    value: PlainObject,
    ttlMs: number,
  ): void;
  setPresence(
    a: string,
    b: string,
    c: string | PlainObject,
    d: PlainObject | number,
    e?: number,
  ): void {
    if (e !== undefined) {
      this.presence.set(a, b, c as string, d as PlainObject, e);
      return;
    }
    this.presence.set(DEFAULT_TENANT_ID, a, b, c as PlainObject, d as number);
  }

  readPresence(type: string, key: string): PlainObject | undefined;
  readPresence(tenantId: string, type: string, key: string): PlainObject | undefined;
  readPresence(a: string, b: string, c?: string): PlainObject | undefined {
    if (c !== undefined) {
      return this.presence.read(a, b, c);
    }
    return this.presence.read(DEFAULT_TENANT_ID, a, b);
  }

  clearPresence(type: string, key: string): void;
  clearPresence(tenantId: string, type: string, key: string): void;
  clearPresence(a: string, b: string, c?: string): void {
    if (c !== undefined) {
      this.presence.clear(a, b, c);
      return;
    }
    this.presence.clear(DEFAULT_TENANT_ID, a, b);
  }

  enqueueSignal(type: string, key: string, value: PlainObject, ttlMs?: number): void;
  enqueueSignal(
    tenantId: string,
    type: string,
    key: string,
    value: PlainObject,
    ttlMs?: number,
  ): void;
  enqueueSignal(
    a: string,
    b: string,
    c: string | PlainObject,
    d?: PlainObject | number,
    e?: number,
  ): void {
    // Disambiguate: 5-arg overload has `c: string`; 4-arg overload has `c: PlainObject`.
    if (typeof c === "string") {
      this.signals.enqueue(a, b, c, d as PlainObject, e ?? 30_000);
      return;
    }
    this.signals.enqueue(DEFAULT_TENANT_ID, a, b, c, (d as number | undefined) ?? 30_000);
  }

  drainSignals(type: string, key: string): PlainObject[];
  drainSignals(tenantId: string, type: string, key: string): PlainObject[];
  drainSignals(a: string, b: string, c?: string): PlainObject[] {
    if (c !== undefined) {
      return this.signals.drain(a, b, c);
    }
    return this.signals.drain(DEFAULT_TENANT_ID, a, b);
  }

  createBlobMetadata(metadata: BlobMetadataInput): void;
  createBlobMetadata(tenantId: string, metadata: BlobMetadataInput): void;
  createBlobMetadata(a: string | BlobMetadataInput, b?: BlobMetadataInput): void {
    if (typeof a === "string" && b) {
      this.blobs.create(a, b);
      return;
    }
    this.blobs.create(DEFAULT_TENANT_ID, a as BlobMetadataInput);
  }

  readBlobMetadata(blobId: string): BlobMetadata | undefined;
  readBlobMetadata(tenantId: string, blobId: string): BlobMetadata | undefined;
  readBlobMetadata(a: string, b?: string): BlobMetadata | undefined {
    if (b !== undefined) {
      return this.blobs.read(a, b);
    }
    return this.blobs.read(DEFAULT_TENANT_ID, a);
  }

  /**
   * Legacy single-tenant facade. The single-arg form treats `ownerId` as a
   * filter within {@link DEFAULT_TENANT_ID}. For explicit tenant scoping
   * call `store.blobs.list(tenantId, ownerId)` directly.
   */
  listBlobMetadata(ownerId?: string): BlobMetadata[] {
    return this.blobs.list(DEFAULT_TENANT_ID, ownerId);
  }

  writeBlobContent(blobId: string, content: Uint8Array): void;
  writeBlobContent(tenantId: string, blobId: string, content: Uint8Array): void;
  writeBlobContent(a: string, b: string | Uint8Array, c?: Uint8Array): void {
    if (c !== undefined) {
      this.blobs.writeContent(a, b as string, c);
      return;
    }
    this.blobs.writeContent(DEFAULT_TENANT_ID, a, b as Uint8Array);
  }

  readBlobContent(blobId: string): Uint8Array | undefined;
  readBlobContent(tenantId: string, blobId: string): Uint8Array | undefined;
  readBlobContent(a: string, b?: string): Uint8Array | undefined {
    if (b !== undefined) {
      return this.blobs.readContent(a, b);
    }
    return this.blobs.readContent(DEFAULT_TENANT_ID, a);
  }

  hasUser(userId: string): boolean;
  hasUser(tenantId: string, userId: string): boolean;
  hasUser(a: string, b?: string): boolean {
    if (b !== undefined) {
      return this.accounts.readByIdentity(a, b) !== undefined;
    }
    return this.accounts.readByIdentity(DEFAULT_TENANT_ID, a) !== undefined;
  }

  createAccountUser(input: {
    userId: string;
    handle: string;
    displayName: string;
    password: string;
    tenantId?: string;
  }): StoredAccount {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    return this.accounts.create({
      tenantId,
      userId: input.userId,
      handle: input.handle,
      displayName: input.displayName,
      password: input.password,
    });
  }

  verifyAccountPassword(identity: string, password: string): StoredAccount | undefined;
  verifyAccountPassword(
    tenantId: string,
    identity: string,
    password: string,
  ): StoredAccount | undefined;
  verifyAccountPassword(a: string, b: string, c?: string): StoredAccount | undefined {
    if (c !== undefined) {
      return this.accounts.verifyPassword(a, b, c);
    }
    return this.accounts.verifyPassword(DEFAULT_TENANT_ID, a, b);
  }

  createSession(input: {
    sessionToken: string;
    userId: string;
    deviceId: string;
    replicaId: string;
    expiresAt: string;
    tenantId?: string;
  }): StoredSession {
    return this.sessions.create({
      ...input,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
    });
  }

  readActiveSession(sessionToken: string): StoredSession | undefined {
    return this.sessions.readActive(sessionToken);
  }

  readAnySession(sessionToken: string): StoredSession | undefined {
    return this.sessions.readAny(sessionToken);
  }

  deleteSession(sessionToken: string): boolean {
    return this.sessions.delete(sessionToken);
  }

  /**
   * Invalidate every session belonging to a user. Used by app-level
   * revoke flows (e.g. Apple's server-to-server consent-revoked
   * notification). Returns the number of session rows removed.
   *
   * Scope optionally to a single tenant; omit `tenantId` to kill all.
   */
  deleteSessionsForUser(userId: string, tenantId?: string): number {
    return this.sessions.deleteForUser(userId, tenantId);
  }

  enqueueJob(type: string, value: PlainObject): void;
  enqueueJob(tenantId: string, type: string, value: PlainObject): void;
  enqueueJob(a: string, b: string | PlainObject, c?: PlainObject): void {
    if (c !== undefined) {
      this.jobs.enqueue(a, b as string, c);
      return;
    }
    this.jobs.enqueue(DEFAULT_TENANT_ID, a, b as PlainObject);
  }

  nextJob(type: string): StoredJob | undefined;
  nextJob(tenantId: string, type: string): StoredJob | undefined;
  nextJob(a: string, b?: string): StoredJob | undefined {
    if (b !== undefined) {
      return this.jobs.next(a, b);
    }
    return this.jobs.next(DEFAULT_TENANT_ID, a);
  }

  #recordSchema(): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO schema_versions (schema_hash, manifest, created_at)
          VALUES (?, ?, ?)`,
      )
      .run(this.schema.hash, Buffer.from(encode(this.schema)), new Date().toISOString());
  }
}
