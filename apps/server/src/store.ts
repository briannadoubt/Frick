import { encode } from "@msgpack/msgpack";
import {
  foundationSchema,
  resolveObjectMergePolicy,
  validateSchema,
  type FrickObjectMergePolicy,
  type FrickSchema,
  type ObjectDef,
  type PlainObject,
} from "@fricken/protocol";
import { AccountStore, type StoredAccount } from "./storage/account-store.js";
import {
  createPasswordHasher,
  type FrickPasswordHasher,
  type FrickPasswordHasherId,
} from "./storage/password-hasher.js";
import { PasswordResetTokenStore } from "./storage/password-reset-store.js";
import { RefreshTokenStore } from "./storage/refresh-token-store.js";
import { SamlAssertionStore } from "./storage/saml-assertion-store.js";
import { ServicePrincipalStore } from "./storage/service-principal-store.js";
import { AdminAuditStore } from "./storage/admin-audit-store.js";
import { BlobStore, type BlobMetadata, type BlobMetadataInput } from "./storage/blob-store.js";
import {
  createBlobBytesDriver,
  type BlobBytesDriver,
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
import { createSqlDriver, isSqliteSqlDriver, type SqlDriver } from "./storage/sql-driver.js";
import type { DatabaseSync } from "node:sqlite";
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
  type StreamRetentionPolicies,
} from "./storage/stream-store.js";

/** Default cadence for the opt-in per-stream retention sweep (FR-145). */
const DEFAULT_STREAM_RETENTION_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Resolve the {@link StoreOptions.passwordHasher} option into a concrete
 * {@link FrickPasswordHasher}: a string id is mapped through
 * {@link createPasswordHasher}; an already-built hasher is used as-is;
 * `undefined` falls back to the Argon2id default.
 */
function resolvePasswordHasher(
  selection: FrickPasswordHasherId | FrickPasswordHasher | undefined,
): FrickPasswordHasher | undefined {
  if (selection === undefined) return undefined;
  if (typeof selection === "string") return createPasswordHasher(selection);
  return selection;
}
import { BoundedIdempotencyCache } from "./storage/idempotency-cache.js";
import type { AppliedMigrationRow } from "./storage/migrations.js";
import { createNoopLogger, type FrickLogger } from "./logger.js";
import {
  createFrickProjectionRegistry,
  type FrickProjectionContext,
  type FrickProjectionRegistry,
  type FrickProjectionWriteEvent,
} from "./projections/registry.js";
import { DEFAULT_APP_ID } from "./app-id.js";
import { createAppScopedStore } from "./store-app-scoped.js";
import type { FrickPerAppRegistries } from "./apps/per-app-registries.js";
import {
  createFrickSearchIndexRegistry,
  type FrickSearchAdapter,
  type FrickSearchIndexRegistry,
  type FrickSearchProjectInput,
} from "./search/types.js";
import { createSqliteFtsSearchAdapter } from "./search/sqlite-fts.js";
import { createPgFtsSearchAdapter } from "./search/pg-fts.js";
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
/** Default interval between background expired-session prune passes: 15 minutes. */
export const DEFAULT_EXPIRED_SESSION_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
/**
 * Default grace period kept before an expired session row is pruned: 0, i.e.
 * a session is eligible the moment it expires (it is already unusable). Raise
 * it to retain recently-expired rows for a window (e.g. forensics).
 */
export const DEFAULT_EXPIRED_SESSION_RETENTION_GRACE_MS = 0;
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
  /**
   * Storage driver selector. Defaults to `"sqlite"`. `"postgres"` is not yet
   * implemented (FR-119) and will throw `FrickConfigError` at construction.
   */
  dbDriver?: "sqlite" | "postgres";
  /** Postgres connection string. Required when `dbDriver === "postgres"`. */
  dbUrl?: string | undefined;
  schema?: FrickSchema;
  seed?: boolean;
  /**
   * Password-hashing algorithm for new/updated account credentials (FR-35).
   * Defaults to `"argon2"` (Argon2id). `"scrypt"` keeps the pre-FR-35
   * behavior. Existing scrypt credentials always verify and are transparently
   * re-hashed to the active algorithm on the next successful login. Pass a
   * fully-built {@link FrickPasswordHasher} instead for custom parameters.
   */
  passwordHasher?: FrickPasswordHasherId | FrickPasswordHasher;
  /**
   * Blob-bytes storage driver (FR-53/FR-54). `sqlite` (the default) keeps blob
   * bytes in the SQLite `blob_content` table; `filesystem` writes them under
   * {@link StoreOptions.blobStoragePath}; `s3` stores them in an S3-compatible
   * object store (pass the pre-built driver via {@link StoreOptions.blobS3Driver}).
   * Blob metadata always lives in SQLite regardless of this setting.
   */
  blobDriver?: FrickBlobDriver;
  /**
   * Filesystem root for blob bytes. Required and validated (writable directory)
   * when {@link StoreOptions.blobDriver} is `filesystem`; ignored otherwise.
   */
  blobStoragePath?: string;
  /**
   * Pre-built S3 bytes driver (FR-54). Required when
   * {@link StoreOptions.blobDriver} is `s3`. The driver is built asynchronously
   * (it lazily imports the AWS SDK) via `createS3BlobBytesDriver`, so it cannot
   * be constructed inside this synchronous store constructor — the server builds
   * it during its async setup and injects it here.
   */
  blobS3Driver?: BlobBytesDriver;
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
   * Optional per-app registry container (FR-153). When supplied, every
   * projection `notify(...)` is routed to the originating app's projection
   * registry via `perAppRegistries.for(appId)` instead of the shared
   * {@link FrickStore.projections}, so app A's projections never fire on app
   * B's writes. When omitted (the single-app default), notifies go to the
   * shared `projections` registry exactly as before — byte-for-byte unchanged.
   */
  perAppRegistries?: FrickPerAppRegistries;
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
  /**
   * Opt-in per-stream retention policies (FR-145), keyed by stream type. Stream
   * events are durable application data, so the stream-store keeps everything
   * by default; only stream types named here are pruned. See
   * {@link StreamRetentionPolicies}.
   */
  streamRetention?: StreamRetentionPolicies;
  /**
   * Interval between background stream-retention sweeps. Only runs when
   * {@link StoreOptions.streamRetention} declares at least one policy. Defaults
   * to {@link DEFAULT_STREAM_RETENTION_PRUNE_INTERVAL_MS} (15 min); `0` disables
   * the timer (a sweep still runs once at construction / initialize).
   */
  streamRetentionPruneIntervalMs?: number;
  /**
   * Grace period kept before an expired `auth_sessions` row is pruned.
   * Defaults to {@link DEFAULT_EXPIRED_SESSION_RETENTION_GRACE_MS} (0 — prune
   * as soon as a session expires, since it is already unusable).
   */
  expiredSessionRetentionGraceMs?: number;
  /**
   * Interval between background expired-session prune passes. Defaults to
   * {@link DEFAULT_EXPIRED_SESSION_PRUNE_INTERVAL_MS} (15 min). Set to `0` to
   * disable the timer (prune still runs once at construction).
   */
  expiredSessionPruneIntervalMs?: number;
  /**
   * Object read-visibility configuration (FR-235). By default the framework
   * owner-scopes reads of any object type that declares an owner field (see
   * {@link FrickObjectVisibilityOptions}); pass `{ mode: "tenantWide" }` to
   * explicitly restore the pre-0.2.1 allow-all behavior for genuinely
   * shared-tenant apps.
   */
  objectVisibility?: FrickObjectVisibilityOptions;
}

/**
 * How {@link FrickStore.isObjectVisibleToUser} scopes object reads (FR-235).
 *
 * Until 0.2.1 the framework's baseline visibility was tenant-wide allow-all
 * unless an app policy hook tightened it — which silently served every
 * tenant user's rows to every other user in single-tenant, per-user-data
 * deployments. The default is now `"ownerScoped"`: a type whose schema
 * declares an owner field (explicitly via `ObjectDef.ownerField`, or by the
 * convention of a string field named `ownerUserId`) is visible only to the
 * user its row names as owner. Admins, sharing grantees, and policy hooks are
 * layered on top by the read pipeline (gateway snapshot/fan-out, HTTP list,
 * search) — this store-level check is the ownership baseline only.
 *
 * Rows that predate owner scoping and carry no owner value at all remain
 * visible (fail-open) so a migrated pre-0.2.0 database keeps working — see
 * FR-234.
 */
export interface FrickObjectVisibilityOptions {
  /**
   * `"ownerScoped"` (default): owner-field-bearing types are scoped to their
   * owner. `"tenantWide"`: every in-tenant row is visible to every tenant
   * user — the explicit opt-in to the pre-0.2.1 behavior.
   */
  mode?: "ownerScoped" | "tenantWide";
  /**
   * Per-type owner-field overrides, taking precedence over the schema's
   * `ownerField` and the `ownerUserId` convention. Map a type name to the
   * field carrying its owner's userId, or to `null` to opt that type out of
   * owner scoping entirely.
   */
  ownerFields?: Record<string, string | null>;
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
      /** Storage app id of the write (FR-153); `_default` for single-app. */
      appId?: string;
      objectType: string;
      objectId: string;
      /** Stored (post-merge) object state, including its `id` field. */
      object: PlainObject;
      /**
       * The userId of the principal whose request performed the write, when
       * the write path knows it (WS ObjectUpsert, HTTP object PUT/POST).
       * The sync gateway uses it to guarantee the writer always receives
       * their own delta echo regardless of owner-field state (FR-234).
       * Undefined for server-originated writes (jobs, app routes calling the
       * store directly).
       */
      writerUserId?: string;
    }
  | {
      kind: "objectDelete";
      tenantId: string;
      /** Storage app id of the write (FR-153); `_default` for single-app. */
      appId?: string;
      objectType: string;
      objectId: string;
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
  readonly refreshTokens: RefreshTokenStore;
  readonly samlAssertions: SamlAssertionStore;
  readonly servicePrincipals: ServicePrincipalStore;
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
  /**
   * Per-app projection/job registry container (FR-153). Undefined for
   * single-app servers, in which case projection notifies use the shared
   * {@link projections} registry.
   */
  readonly perAppRegistries?: FrickPerAppRegistries;
  readonly searchAdapter: FrickSearchAdapter;
  readonly searchIndexes: FrickSearchIndexRegistry;
  readonly #logger: FrickLogger;

  readonly #sqlDriver: SqlDriver;
  #schemaReady = false;
  /** `"ownerScoped"` unless the deployment explicitly opted into allow-all. */
  readonly #objectVisibilityMode: "ownerScoped" | "tenantWide";
  /**
   * Resolved owner field per object type (FR-235). Absent entry = the type
   * has no owner field and stays tenant-visible. Resolution order: server
   * `objectVisibility.ownerFields` override → schema `ObjectDef.ownerField` →
   * convention (a declared string field named `ownerUserId`).
   */
  readonly #ownerFieldByType = new Map<string, string>();

  /**
   * Narrow accessor for the underlying SQLite handle. Exposed for the
   * compliance module which needs raw cross-table read/write access for
   * data-subject export and erase — building a per-table API for every
   * GDPR-shaped query would balloon the store surface. Treat this as a
   * private extension point: do not reach in from feature code, and never
   * cross tenant boundaries without resolving them through the existing
   * stores' tenant validation first.
   *
   * NOTE: This is SQLite-only. The 6 subsystems that use this handle directly
   * (devtools/event-store, platform-events/sqlite, backup/dump, backup/restore,
   * analytics/summary, compliance/data-subject-erase) are out of scope for the
   * async seam refactor (FR-118). Postgres support for those subsystems is
   * tracked separately. The `createSqlDriver` factory already throws if
   * `dbDriver === "postgres"`, so `rawDatabase()` will only ever be called on a
   * SQLite-backed store.
   */
  get db(): DatabaseSync {
    if (!isSqliteSqlDriver(this.#sqlDriver)) {
      throw new Error(
        "FrickStore.db (raw SQLite handle) is only available on the SQLite driver; " +
          "this store is Postgres-backed.",
      );
    }
    return this.#sqlDriver.rawDb;
  }
  readonly #idempotencyCacheCapacity: number;
  readonly #idempotencyKeyRetentionMs: number;
  readonly #idempotencyKeyMaxRows: number;
  readonly #idempotencyReplayWindowMs: number;
  #pruneTimer: ReturnType<typeof setInterval> | undefined;
  #devtoolsPruneTimer: ReturnType<typeof setInterval> | undefined;
  #platformEventsPruneTimer: ReturnType<typeof setInterval> | undefined;
  #expiredSessionPruneTimer: ReturnType<typeof setInterval> | undefined;
  #streamRetentionPruneTimer: ReturnType<typeof setInterval> | undefined;
  #streamRetention: StreamRetentionPolicies | undefined;
  #expiredSessionGraceMs = DEFAULT_EXPIRED_SESSION_RETENTION_GRACE_MS;
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
    this.schema = validateSchema(options.schema ?? foundationSchema);

    this.#objectVisibilityMode = options.objectVisibility?.mode ?? "ownerScoped";
    const ownerFieldOverrides = options.objectVisibility?.ownerFields ?? {};
    for (const objectDef of this.schema.objects) {
      const resolved = resolveOwnerField(objectDef, ownerFieldOverrides[objectDef.name]);
      if (resolved !== undefined) {
        this.#ownerFieldByType.set(objectDef.name, resolved);
      }
    }

    // Build the async storage driver. The factory creates a SQLite handle or a
    // Postgres pool (the pool connects lazily, so construction stays sync).
    this.#sqlDriver = createSqlDriver({
      dbDriver: options.dbDriver ?? "sqlite",
      dbPath: options.path,
      dbUrl: options.dbUrl,
    });
    // SQLite DDL is synchronous, so the schema is ready immediately and every
    // `new FrickStore()` caller (the entire test suite) keeps working without
    // an await. Postgres schema setup is async and runs in `initialize()`
    // (awaited from the server's listen()); until then `#schemaReady` is false
    // so the maintenance prunes no-op instead of querying missing tables.
    if (isSqliteSqlDriver(this.#sqlDriver)) {
      initializeStorage(this.#sqlDriver.rawDb, this.schema.schemaRevision);
      this.#recordSchema();
      this.#schemaReady = true;
    }

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
    const sql = this.#sqlDriver;
    this.objects = new ObjectStore(sql, this.schema);
    this.streams = new StreamStore(sql, this.schema, this.idempotencyCache, {
      replayWindowMs: this.#idempotencyReplayWindowMs,
    });
    this.presence = new PresenceStore(sql, this.schema);
    this.signals = new SignalStore(sql, this.schema);
    this.blobs = new BlobStore(
      sql,
      createBlobBytesDriver({
        driver: options.blobDriver ?? "sqlite",
        db: sql,
        blobStoragePath: options.blobStoragePath,
        s3Driver: options.blobS3Driver,
      }),
    );
    this.blobDerivatives = new BlobDerivativeStore(sql);
    this.blobProcessors = createFrickBlobProcessorRegistry();
    this.jobs = new JobStore(sql);
    this.sessions = new SessionStore(sql);
    this.accounts = new AccountStore(sql, resolvePasswordHasher(options.passwordHasher));
    this.passwordResetTokens = new PasswordResetTokenStore(sql);
    this.refreshTokens = new RefreshTokenStore(sql);
    this.samlAssertions = new SamlAssertionStore(sql);
    this.servicePrincipals = new ServicePrincipalStore(sql);
    this.tenants = new TenantStore(sql);
    this.invitations = new InvitationStore(sql);
    this.grants = new GrantStore(sql);
    this.tenantSettings = new TenantSettingsStore(sql);
    this.adminAudit = new AdminAuditStore(sql);
    this.pushRegistrations = new PushRegistrationStore(sql);
    this.devtoolsEvents = new DevToolsEventStore(sql, {
      retentionMs:
        options.devtoolsEventsRetentionMs ?? DEFAULT_DEVTOOLS_EVENTS_RETENTION_MS,
      maxRows: options.devtoolsEventsMaxRows ?? DEFAULT_DEVTOOLS_EVENTS_MAX_ROWS,
    });
    this.platformEvents = new SqlitePlatformEventPipeline(sql, {
      retentionMs:
        options.platformEventsRetentionMs ?? DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
      maxRows: options.platformEventsMaxRows ?? DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
    });
    this.analyticsEvents = new AnalyticsEventStore(sql);
    this.projections = options.projections ?? createFrickProjectionRegistry();
    if (options.perAppRegistries !== undefined) {
      this.perAppRegistries = options.perAppRegistries;
    }
    this.searchAdapter =
      options.searchAdapter ??
      (isSqliteSqlDriver(sql)
        ? createSqliteFtsSearchAdapter(sql.rawDb)
        : createPgFtsSearchAdapter(sql));
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

    // Opt-in per-stream retention (FR-145). Only armed when at least one policy
    // is declared — stream events are durable application data, so the default
    // is keep-forever.
    this.#streamRetention =
      options.streamRetention && Object.keys(options.streamRetention).length > 0
        ? options.streamRetention
        : undefined;
    if (this.#streamRetention) {
      this.#safeStreamRetentionPrune();
      const streamRetentionIntervalMs =
        options.streamRetentionPruneIntervalMs ?? DEFAULT_STREAM_RETENTION_PRUNE_INTERVAL_MS;
      if (streamRetentionIntervalMs > 0) {
        this.#streamRetentionPruneTimer = setInterval(
          () => this.#safeStreamRetentionPrune(),
          streamRetentionIntervalMs,
        );
        this.#streamRetentionPruneTimer.unref?.();
      }
    }

    // Expired-session retention. `auth_sessions` rows are filtered by expiry
    // on read but were never deleted, so the table grew unbounded; sweep them
    // on the same one-shot-at-boot-then-timer shape as the caches above (FR-42).
    this.#expiredSessionGraceMs =
      options.expiredSessionRetentionGraceMs ?? DEFAULT_EXPIRED_SESSION_RETENTION_GRACE_MS;
    this.#safeExpiredSessionPrune();
    const expiredSessionIntervalMs =
      options.expiredSessionPruneIntervalMs ?? DEFAULT_EXPIRED_SESSION_PRUNE_INTERVAL_MS;
    if (expiredSessionIntervalMs > 0) {
      this.#expiredSessionPruneTimer = setInterval(
        () => this.#safeExpiredSessionPrune(),
        expiredSessionIntervalMs,
      );
      this.#expiredSessionPruneTimer.unref?.();
    }
  }

  /**
   * Async schema setup for backends that cannot initialize synchronously in the
   * constructor (Postgres runs its migration runner; the SQLite path already
   * initialized in the constructor and this is a no-op). Idempotent. The server
   * awaits this in `listen()` before serving traffic. Once it completes, the
   * maintenance prunes (which no-op until the schema exists) begin doing work.
   */
  async initialize(): Promise<void> {
    if (this.#schemaReady || this.#closed) {
      return;
    }
    await this.#sqlDriver.initializeSchema(this.schema.schemaRevision);
    await this.#recordSchemaAsync();
    this.#schemaReady = true;
    // The constructor's one-shot maintenance sweeps no-op'd because the schema
    // wasn't ready; run them now that the tables exist. The recurring timers
    // were already scheduled and stop no-op'ing from here on.
    this.#safePrune();
    this.#safeDevToolsPrune();
    this.#safePlatformEventsPrune();
    this.#safeExpiredSessionPrune();
    this.#safeStreamRetentionPrune();
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
    if (this.#expiredSessionPruneTimer) {
      clearInterval(this.#expiredSessionPruneTimer);
      this.#expiredSessionPruneTimer = undefined;
    }
    if (this.#streamRetentionPruneTimer) {
      clearInterval(this.#streamRetentionPruneTimer);
      this.#streamRetentionPruneTimer = undefined;
    }
    // SQLite closes synchronously; the Postgres pool's end() is async — fire it
    // and don't block close() (callers that need to await teardown can await
    // the driver directly). Both are exposed behind SqlDriver.close().
    void this.#sqlDriver.close();
  }

  #safeDevToolsPrune(): void {
    if (this.#closed || !this.#schemaReady) return;
    void this.devtoolsEvents.prune().catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[frick] devtools_events prune failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  #safePlatformEventsPrune(): void {
    if (this.#closed || !this.#schemaReady) return;
    void this.platformEvents.prune().catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[frick] platform_events prune failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  #safeStreamRetentionPrune(): void {
    if (this.#closed || !this.#schemaReady || !this.#streamRetention) return;
    void this.streams.pruneRetention(this.#streamRetention).catch((error) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[frick] stream retention prune failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async #safeExpiredSessionPrune(): Promise<void> {
    if (this.#closed || !this.#schemaReady) return;
    try {
      const cutoffIso = new Date(Date.now() - this.#expiredSessionGraceMs).toISOString();
      await this.sessions.pruneExpired(cutoffIso);
    } catch (error) {
      // Never let a maintenance failure tear down the process.
      // eslint-disable-next-line no-console
      console.warn(
        `[frick] auth_sessions prune failed: ${
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
    const overrides = this.db
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
    this.db.exec("BEGIN IMMEDIATE");
    let prunedByAge = 0;
    let prunedByCap = 0;
    try {
      for (const [tenantId, cutoffIso] of tenantCutoffs) {
        const r = this.db
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
        ageResult = this.db
          .prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
          .run(globalCutoffIso);
      } else {
        const placeholders = Array.from(tenantCutoffs.keys()).map(() => "?").join(",");
        ageResult = this.db
          .prepare(
            `DELETE FROM idempotency_keys
              WHERE created_at < ?
                AND tenant_id NOT IN (${placeholders})`,
          )
          .run(globalCutoffIso, ...tenantCutoffs.keys());
      }
      prunedByAge += Number(ageResult.changes ?? 0);

      const remaining = this.db
        .prepare("SELECT COUNT(*) AS count FROM idempotency_keys")
        .get() as { count: number };
      const overflow = Number(remaining.count) - this.#idempotencyKeyMaxRows;
      if (overflow > 0) {
        const capResult = this.db
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
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
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
      this.streams = new StreamStore(this.#sqlDriver, this.schema, this.idempotencyCache, {
        replayWindowMs: this.#idempotencyReplayWindowMs,
      });
    }

    return { prunedByAge, prunedByCap };
  }

  /** Current row count of the durable `idempotency_keys` table. Read-only. */
  idempotencyKeyRowCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM idempotency_keys")
      .get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  #safePrune(): void {
    if (this.#closed || !this.#schemaReady) {
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
      const row = this.db.prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  /**
   * List applied migrations recorded in the `frick_migrations` ledger. Reads
   * through the {@link SqlDriver} so it works on SQLite and Postgres alike.
   */
  async listAppliedMigrations(): Promise<AppliedMigrationRow[]> {
    const rows = await this.#sqlDriver.all<{
      id: string;
      schema_revision: number;
      applied_at: string;
      checksum: string;
      duration_ms: number;
    }>(
      `SELECT id, schema_revision, applied_at, checksum, duration_ms
          FROM frick_migrations
          ORDER BY schema_revision ASC, id ASC`,
    );
    return rows.map((row) => ({
      id: row.id,
      schemaRevision: Number(row.schema_revision),
      appliedAt: row.applied_at,
      checksum: row.checksum,
      durationMs: Number(row.duration_ms),
    }));
  }

  /**
   * Internal escape hatch for the backup/restore subsystem: the {@link
   * SqlDriver} the store reads/writes through. Backup needs to stream every row
   * of every framework table (and restore needs to insert directly) on both
   * SQLite and Postgres. NOT part of the public store API.
   */
  get sqlDriver(): SqlDriver {
    return this.#sqlDriver;
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
    return this.db;
  }

  /**
   * Return a view of this store whose object/stream/presence/signal/job write
   * facades default to `appId` instead of {@link DEFAULT_APP_ID}
   * (tenant-app-isolation-2). A per-app background-job handler receives one of
   * these as `ctx.store`, so a write it makes through the legacy
   * `store.upsertObject(...)` / `store.appendEvent({...})` / `store.setPresence`
   * / `store.enqueueSignal` / `store.jobs.enqueue` facades lands in the
   * originating app's partition rather than `_default`. A handler that passes
   * an explicit `appId` still wins — the injection only fills the omitted
   * default. Reads and every other facade delegate to the underlying store
   * unchanged; `forApp(DEFAULT_APP_ID)` (or the single-app default) returns the
   * store itself so existing single-app behaviour is byte-for-byte identical.
   */
  forApp(appId: string | undefined): FrickStore {
    if (appId === undefined || appId === DEFAULT_APP_ID) {
      return this;
    }
    return createAppScopedStore(this, appId);
  }

  // ---- Tenant-scoped facades --------------------------------------------
  //
  // The legacy API used method names like `upsertObject(type, id, value)`
  // with no tenant argument. The framework still supports those — they
  // implicitly target {@link DEFAULT_TENANT_ID}. For new tenant-aware code,
  // every method also has a leading-`tenantId` variant. This keeps existing
  // tests (which all operate in the default tenant) green while threading a
  // tenant boundary through every public surface.

  async upsertObject(type: string, id: string, value: PlainObject, version?: number): Promise<void>;
  async upsertObject(tenantId: string, type: string, id: string, value: PlainObject, version?: number, appId?: string): Promise<void>;
  async upsertObject(
    a: string,
    b: string | PlainObject,
    c?: string | PlainObject | number,
    d?: PlainObject | number,
    e?: number,
    f?: string,
  ): Promise<void> {
    if (typeof b === "string" && (typeof c === "string" || c === undefined)) {
      // 6-arg form: (tenantId, type, id, value, version?, appId?)
      const tenantId = a;
      const type = b;
      const id = c as string;
      const value = d as PlainObject;
      const version = (e as number | undefined) ?? 0;
      // App partition (FR-153). Trailing `appId` is additive — omitted callers
      // keep writing the `_default` partition byte-for-byte. The app-scoped
      // store facade (see `forApp`) injects the job/connection's app here so a
      // per-app job handler's legacy `upsertObject` write lands in its own app.
      const appId = f ?? DEFAULT_APP_ID;
      await this.objects.upsert(tenantId, type, id, value, version, appId);
      const stored = (await this.objects.read(tenantId, type, id, appId)) ?? value;
      await this.#notifyProjections({
        kind: "objectUpsert",
        tenantId,
        appId,
        objectType: type,
        objectId: id,
        object: stored,
      });
      await this.#notifySearchForObject(tenantId, type, id, stored);
      this.#notifyWriteListener({
        kind: "objectUpsert",
        tenantId,
        appId,
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
    await this.objects.upsert(DEFAULT_TENANT_ID, type, id, value, version);
    const stored = (await this.objects.read(DEFAULT_TENANT_ID, type, id)) ?? value;
    await this.#notifyProjections({
      kind: "objectUpsert",
      tenantId: DEFAULT_TENANT_ID,
      objectType: type,
      objectId: id,
      object: stored,
    });
    await this.#notifySearchForObject(DEFAULT_TENANT_ID, type, id, stored);
    this.#notifyWriteListener({
      kind: "objectUpsert",
      tenantId: DEFAULT_TENANT_ID,
      objectType: type,
      objectId: id,
      object: stored,
    });
  }

  async #notifySearchForObject(
    tenantId: string,
    type: string,
    id: string,
    value: PlainObject,
  ): Promise<void> {
    await this.#notifySearch(
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
  async upsertObjectWithPolicy(args: {
    tenantId?: string;
    appId?: string;
    type: string;
    id: string;
    value: PlainObject;
    expectedVersion?: number;
    /**
     * userId of the principal performing the write, when known. Carried on
     * the emitted write event so the sync gateway always echoes the delta
     * back to the writer's own subscriptions (FR-234).
     */
    writerUserId?: string;
  }): Promise<ObjectUpsertResult> {
    const tenantId = args.tenantId ?? DEFAULT_TENANT_ID;
    const appId = args.appId ?? DEFAULT_APP_ID;
    const mergePolicy: FrickObjectMergePolicy = resolveObjectMergePolicy(
      this.schema,
      args.type,
    );
    const result = await this.objects.upsertWithPolicy({
      tenantId,
      appId,
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
    const stored = (await this.objects.read(tenantId, args.type, args.id, appId)) ?? args.value;
    await this.#notifyProjections({
      kind: "objectUpsert",
      tenantId,
      appId,
      objectType: args.type,
      objectId: args.id,
      object: stored,
    });
    await this.#notifySearchForObject(tenantId, args.type, args.id, stored);
    this.#notifyWriteListener({
      kind: "objectUpsert",
      tenantId,
      appId,
      objectType: args.type,
      objectId: args.id,
      object: stored,
      ...(args.writerUserId !== undefined ? { writerUserId: args.writerUserId } : {}),
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
  async deleteObject(type: string, id: string): Promise<boolean>;
  async deleteObject(tenantId: string, type: string, id: string, appId?: string): Promise<boolean>;
  async deleteObject(a: string, b: string, c?: string, d?: string): Promise<boolean> {
    const tenantId = c !== undefined ? a : DEFAULT_TENANT_ID;
    const type = c !== undefined ? b : a;
    const id = c !== undefined ? c : b;
    const appId = d ?? DEFAULT_APP_ID;
    const existed = await this.objects.delete(tenantId, type, id, appId);
    // Notify only when a row actually went away (parity with the upsert
    // path) so the sync gateway can broadcast the removal live — clients
    // drop the row immediately instead of waiting for the next cold
    // refetch (FR-142).
    if (existed) {
      this.#notifyWriteListener({
        kind: "objectDelete",
        tenantId,
        appId,
        objectType: type,
        objectId: id,
      });
    }
    return existed;
  }

  async readObject(type: string, id: string): Promise<PlainObject | undefined>;
  async readObject(tenantId: string, type: string, id: string, appId?: string): Promise<PlainObject | undefined>;
  async readObject(a: string, b: string, c?: string, d?: string): Promise<PlainObject | undefined> {
    if (c !== undefined) {
      return this.objects.read(a, b, c, d ?? DEFAULT_APP_ID);
    }
    return this.objects.read(DEFAULT_TENANT_ID, a, b);
  }

  async listObjects(type: string): Promise<PlainObject[]>;
  async listObjects(tenantId: string, type: string, appId?: string): Promise<PlainObject[]>;
  async listObjects(a: string, b?: string, c?: string): Promise<PlainObject[]> {
    if (b !== undefined) {
      return this.objects.list(a, b, c ?? DEFAULT_APP_ID);
    }
    return this.objects.list(DEFAULT_TENANT_ID, a);
  }

  async listObjectsForUser(type: string, userId: string): Promise<PlainObject[]>;
  async listObjectsForUser(tenantId: string, type: string, userId: string, appId?: string): Promise<PlainObject[]>;
  async listObjectsForUser(a: string, b: string, c?: string, d?: string): Promise<PlainObject[]> {
    const tenantId = c !== undefined ? a : DEFAULT_TENANT_ID;
    const type = c !== undefined ? b : a;
    const userId = c !== undefined ? c : b;
    const appId = c !== undefined ? (d ?? DEFAULT_APP_ID) : DEFAULT_APP_ID;
    const objects = await this.listObjects(tenantId, type, appId);
    return objects.filter((object) =>
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
    // Ownership baseline (FR-235). This is deliberately the *baseline* only:
    // the read pipeline layers admin bypass, app policy hooks, and sharing-
    // grant relaxation on top (see canSubscriberReadObjectRecord), so a
    // `false` here is not final for a grantee. Tenant scoping is enforced by
    // the callers' tenant-scoped storage lookups.
    if (this.#objectVisibilityMode === "tenantWide") {
      return true;
    }
    const ownerField = this.#ownerFieldByType.get(type);
    if (ownerField === undefined) {
      // No owner concept declared for this type — tenant-visible.
      return true;
    }
    const owner = object[ownerField];
    if (typeof owner !== "string" || owner.length === 0) {
      // Fail-open for rows that predate owner scoping (or were written
      // without an owner value): a migrated pre-0.2.0 database must keep
      // serving — and fanning out — its existing rows (FR-234).
      return true;
    }
    return owner === userId;
  }

  /**
   * The resolved owner field for an object type (FR-235), or `undefined`
   * when the type has no owner concept and is tenant-visible.
   */
  objectOwnerField(type: string): string | undefined {
    if (this.#objectVisibilityMode === "tenantWide") {
      return undefined;
    }
    return this.#ownerFieldByType.get(type);
  }

  async appendEvent(input: Omit<AppendInput, "tenantId"> & { tenantId?: string }): Promise<AppendResult> {
    const result = await this.streams.append({
      ...input,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
    });
    if (result.created) {
      await this.#notifyProjections({
        kind: "streamEvent",
        tenantId: result.event.tenantId,
        appId: result.event.appId,
        streamType: result.event.stream,
        streamId: result.event.streamId,
        streamEvent: result.event,
      });
      await this.#notifySearch(
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
  async #notifySearch(
    pick: (def: FrickSearchProjectInput) => FrickSearchProjectInput,
    matches: (def: { source: { kind: string; type?: string; name?: string } }) => boolean,
    input: FrickSearchProjectInput,
  ): Promise<void> {
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
        await this.searchAdapter.upsert(input.tenantId, def.name, withSearchSourceFields(input, doc));
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
  async #notifyProjections(event: FrickProjectionWriteEvent): Promise<void> {
    const appId = event.appId ?? DEFAULT_APP_ID;
    const ctx: FrickProjectionContext = {
      tenantId: event.tenantId,
      appId,
      store: this,
      logger: this.#logger,
    };
    // Route to the originating app's projection registry when a per-app
    // container is configured (FR-153); otherwise fall back to the single
    // shared registry, which is the only one a single-app server has.
    const registry = this.perAppRegistries
      ? this.perAppRegistries.for(appId).projections
      : this.projections;
    await registry.notify(event, ctx);
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

  async readEvents(stream: string, streamId: string, after: number, limit?: number): Promise<StoredEvent[]>;
  async readEvents(
    tenantId: string,
    stream: string,
    streamId: string,
    after: number,
    limit?: number,
    appId?: string,
  ): Promise<StoredEvent[]>;
  async readEvents(
    a: string,
    b: string,
    c: string | number,
    d?: number,
    e?: number,
    f?: string,
  ): Promise<StoredEvent[]> {
    if (typeof c === "number") {
      return this.streams.read(DEFAULT_TENANT_ID, a, b, c, d);
    }
    return this.streams.read(a, b, c, d ?? 0, e, f ?? DEFAULT_APP_ID);
  }

  /**
   * Backwards-paginated event read for `loadOlder`-style scrollback. Forwards
   * to {@link StreamStore.readBefore}. `before` is exclusive; `limit` is
   * clamped server-side to `[1, 500]`.
   */
  async readEventsBefore(
    tenantId: string,
    stream: string,
    streamId: string,
    before: number,
    limit: number,
    appId: string = DEFAULT_APP_ID,
  ): Promise<StoredEvent[]> {
    return this.streams.readBefore(tenantId, stream, streamId, before, limit, appId);
  }

  /**
   * Cheap cursor head probe for a stream (FR-116): the highest sequence and
   * total event count within a tenant, no payloads unpacked. Forwards to
   * {@link StreamStore.head}.
   */
  async streamHead(
    tenantId: string,
    stream: string,
    streamId: string,
  ): Promise<{ headSequence: number; count: number }> {
    return this.streams.head(tenantId, stream, streamId);
  }

  async setPresence(type: string, key: string, value: PlainObject, ttlMs: number): Promise<void>;
  async setPresence(
    tenantId: string,
    type: string,
    key: string,
    value: PlainObject,
    ttlMs: number,
    appId?: string,
  ): Promise<void>;
  async setPresence(
    a: string,
    b: string,
    c: string | PlainObject,
    d: PlainObject | number,
    e?: number,
    f?: string,
  ): Promise<void> {
    if (e !== undefined) {
      return this.presence.set(a, b, c as string, d as PlainObject, e, f ?? DEFAULT_APP_ID);
    }
    return this.presence.set(DEFAULT_TENANT_ID, a, b, c as PlainObject, d as number);
  }

  async readPresence(type: string, key: string): Promise<PlainObject | undefined>;
  async readPresence(tenantId: string, type: string, key: string, appId?: string): Promise<PlainObject | undefined>;
  async readPresence(a: string, b: string, c?: string, d?: string): Promise<PlainObject | undefined> {
    if (c !== undefined) {
      return this.presence.read(a, b, c, d ?? DEFAULT_APP_ID);
    }
    return this.presence.read(DEFAULT_TENANT_ID, a, b);
  }

  async clearPresence(type: string, key: string): Promise<void>;
  async clearPresence(tenantId: string, type: string, key: string, appId?: string): Promise<void>;
  async clearPresence(a: string, b: string, c?: string, d?: string): Promise<void> {
    if (c !== undefined) {
      return this.presence.clear(a, b, c, d ?? DEFAULT_APP_ID);
    }
    return this.presence.clear(DEFAULT_TENANT_ID, a, b);
  }

  async enqueueSignal(type: string, key: string, value: PlainObject, ttlMs?: number): Promise<void>;
  async enqueueSignal(
    tenantId: string,
    type: string,
    key: string,
    value: PlainObject,
    ttlMs?: number,
    appId?: string,
  ): Promise<void>;
  async enqueueSignal(
    a: string,
    b: string,
    c: string | PlainObject,
    d?: PlainObject | number,
    e?: number,
    f?: string,
  ): Promise<void> {
    // Disambiguate: 5-arg overload has `c: string`; 4-arg overload has `c: PlainObject`.
    if (typeof c === "string") {
      return this.signals.enqueue(a, b, c, d as PlainObject, e ?? 30_000, f ?? DEFAULT_APP_ID);
    }
    return this.signals.enqueue(DEFAULT_TENANT_ID, a, b, c, (d as number | undefined) ?? 30_000);
  }

  async drainSignals(type: string, key: string): Promise<PlainObject[]>;
  async drainSignals(tenantId: string, type: string, key: string, appId?: string): Promise<PlainObject[]>;
  async drainSignals(a: string, b: string, c?: string, d?: string): Promise<PlainObject[]> {
    if (c !== undefined) {
      return this.signals.drain(a, b, c, d ?? DEFAULT_APP_ID);
    }
    return this.signals.drain(DEFAULT_TENANT_ID, a, b);
  }

  async createBlobMetadata(metadata: BlobMetadataInput): Promise<void>;
  async createBlobMetadata(tenantId: string, metadata: BlobMetadataInput, appId?: string): Promise<void>;
  async createBlobMetadata(a: string | BlobMetadataInput, b?: BlobMetadataInput, c?: string): Promise<void> {
    if (typeof a === "string" && b) {
      return this.blobs.create(a, b, c ?? DEFAULT_APP_ID);
    }
    return this.blobs.create(DEFAULT_TENANT_ID, a as BlobMetadataInput);
  }

  async readBlobMetadata(blobId: string): Promise<BlobMetadata | undefined>;
  async readBlobMetadata(tenantId: string, blobId: string, appId?: string): Promise<BlobMetadata | undefined>;
  async readBlobMetadata(a: string, b?: string, c?: string): Promise<BlobMetadata | undefined> {
    if (b !== undefined) {
      return this.blobs.read(a, b, c ?? DEFAULT_APP_ID);
    }
    return this.blobs.read(DEFAULT_TENANT_ID, a);
  }

  /**
   * Legacy single-tenant facade. The single-arg form treats `ownerId` as a
   * filter within {@link DEFAULT_TENANT_ID}. For explicit tenant/app scoping
   * call `store.blobs.list(tenantId, ownerId, appId)` directly.
   */
  async listBlobMetadata(ownerId?: string): Promise<BlobMetadata[]> {
    return this.blobs.list(DEFAULT_TENANT_ID, ownerId);
  }

  writeBlobContent(blobId: string, content: Uint8Array): Promise<void>;
  writeBlobContent(tenantId: string, blobId: string, content: Uint8Array, appId?: string): Promise<void>;
  async writeBlobContent(a: string, b: string | Uint8Array, c?: Uint8Array, d?: string): Promise<void> {
    if (c !== undefined) {
      return this.blobs.writeContent(a, b as string, c, d ?? DEFAULT_APP_ID);
    }
    return this.blobs.writeContent(DEFAULT_TENANT_ID, a, b as Uint8Array);
  }

  readBlobContent(blobId: string): Promise<Uint8Array | undefined>;
  readBlobContent(tenantId: string, blobId: string, appId?: string): Promise<Uint8Array | undefined>;
  async readBlobContent(a: string, b?: string, c?: string): Promise<Uint8Array | undefined> {
    if (b !== undefined) {
      return this.blobs.readContent(a, b, c ?? DEFAULT_APP_ID);
    }
    return this.blobs.readContent(DEFAULT_TENANT_ID, a);
  }

  hasUser(userId: string): Promise<boolean>;
  hasUser(tenantId: string, userId: string): Promise<boolean>;
  async hasUser(a: string, b?: string): Promise<boolean> {
    if (b !== undefined) {
      return (await this.accounts.readByIdentity(a, b)) !== undefined;
    }
    return (await this.accounts.readByIdentity(DEFAULT_TENANT_ID, a)) !== undefined;
  }

  async createAccountUser(input: {
    userId: string;
    handle: string;
    displayName: string;
    password: string;
    tenantId?: string;
  }): Promise<StoredAccount> {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    return this.accounts.create({
      tenantId,
      userId: input.userId,
      handle: input.handle,
      displayName: input.displayName,
      password: input.password,
    });
  }

  verifyAccountPassword(identity: string, password: string): Promise<StoredAccount | undefined>;
  verifyAccountPassword(
    tenantId: string,
    identity: string,
    password: string,
  ): Promise<StoredAccount | undefined>;
  async verifyAccountPassword(a: string, b: string, c?: string): Promise<StoredAccount | undefined> {
    if (c !== undefined) {
      return this.accounts.verifyPassword(a, b, c);
    }
    return this.accounts.verifyPassword(DEFAULT_TENANT_ID, a, b);
  }

  /**
   * Constant-work dummy password verification (auth-core-2). Spends the same
   * KDF time a real verify would, always returning false. Used by the login
   * handler to keep the unknown-account / revoked-account branches timing-equal
   * with the wrong-password branch so login can't be used to enumerate accounts.
   */
  verifyDummyPassword(password: string): Promise<false> {
    return this.accounts.verifyDummyPassword(password);
  }

  async createSession(input: {
    sessionToken: string;
    userId: string;
    deviceId: string;
    replicaId: string;
    expiresAt: string;
    tenantId?: string;
  }): Promise<StoredSession> {
    return this.sessions.create({
      ...input,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
    });
  }

  async readActiveSession(sessionToken: string): Promise<StoredSession | undefined> {
    return this.sessions.readActive(sessionToken);
  }

  async readAnySession(sessionToken: string): Promise<StoredSession | undefined> {
    return this.sessions.readAny(sessionToken);
  }

  async deleteSession(sessionToken: string): Promise<boolean> {
    return this.sessions.delete(sessionToken);
  }

  /**
   * Invalidate every session belonging to a user. Used by app-level
   * revoke flows (e.g. Apple's server-to-server consent-revoked
   * notification). Returns the number of session rows removed.
   *
   * Scope optionally to a single tenant; omit `tenantId` to kill all.
   */
  async deleteSessionsForUser(userId: string, tenantId?: string): Promise<number> {
    return this.sessions.deleteForUser(userId, tenantId);
  }

  /**
   * Remove an account row, scoped to a single tenant. Used by the self-service
   * account-deletion flow ({@link deleteAccountData}). Returns true when a row
   * was removed, false when no `(tenantId, userId)` match existed — idempotent.
   */
  async deleteAccount(tenantId: string, userId: string): Promise<boolean> {
    return this.accounts.delete(tenantId, userId);
  }

  enqueueJob(type: string, value: PlainObject): Promise<void>;
  enqueueJob(tenantId: string, type: string, value: PlainObject, appId?: string): Promise<void>;
  async enqueueJob(a: string, b: string | PlainObject, c?: PlainObject, d?: string): Promise<void> {
    if (c !== undefined) {
      await this.jobs.enqueue({
        tenantId: a,
        jobType: b as string,
        payload: c,
        appId: d ?? DEFAULT_APP_ID,
      });
      return;
    }
    await this.jobs.enqueue(DEFAULT_TENANT_ID, a, b as PlainObject);
  }

  nextJob(type: string): Promise<StoredJob | undefined>;
  nextJob(tenantId: string, type: string, appId?: string): Promise<StoredJob | undefined>;
  async nextJob(a: string, b?: string, c?: string): Promise<StoredJob | undefined> {
    if (b !== undefined) {
      return this.jobs.next(a, b, c ?? DEFAULT_APP_ID);
    }
    return this.jobs.next(DEFAULT_TENANT_ID, a);
  }

  #recordSchema(): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_versions (schema_hash, manifest, created_at)
          VALUES (?, ?, ?)`,
      )
      .run(this.schema.hash, Buffer.from(encode(this.schema)), new Date().toISOString());
  }

  /** Portable `#recordSchema` for the async (Postgres) init path. */
  async #recordSchemaAsync(): Promise<void> {
    await this.#sqlDriver.run(
      `INSERT INTO schema_versions (schema_hash, manifest, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT (schema_hash) DO NOTHING`,
      [this.schema.hash, Buffer.from(encode(this.schema)), new Date().toISOString()],
    );
  }
}

/** Conventional owner-field name used when the schema declares no explicit one. */
const CONVENTIONAL_OWNER_FIELD = "ownerUserId";

/**
 * Resolve the owner field for one object type (FR-235). `undefined` means
 * the type has no owner concept (tenant-visible). Resolution order: server
 * override → schema `ObjectDef.ownerField` → `ownerUserId` convention; a
 * `null` at either configurable layer is an explicit opt-out.
 */
function resolveOwnerField(
  objectDef: ObjectDef,
  override: string | null | undefined,
): string | undefined {
  if (override !== undefined) {
    return override ?? undefined;
  }
  if (objectDef.ownerField !== undefined) {
    return objectDef.ownerField ?? undefined;
  }
  const conventional = objectDef.fields.find(
    (field) => field.name === CONVENTIONAL_OWNER_FIELD && field.kind === "string",
  );
  return conventional ? CONVENTIONAL_OWNER_FIELD : undefined;
}
