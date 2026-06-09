import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
  createFrickErrorEnvelope,
  foundationSchema,
  lintSchema,
  lintSchemaChange,
  DEFAULT_FRICK_INVITATION_TTL_SECONDS,
  MAX_FRICK_INVITATION_TTL_SECONDS,
  type FrickErrorCode,
  type FrickSchema,
  type FrickSharingPermission,
} from "@fricken/protocol";
import {
  AuthenticationError,
  AuthorizationError,
  SessionExpiredError,
  assertBlobOwnership,
  assertCanAppend,
  assertCanQuerySearch,
  assertCanReadBlob,
  assertCanReadSignal,
  assertCanSignal,
  assertCanSubscribe,
  assertCanWriteObject,
  canSubscriberReadObjectRecord,
  tenantMembershipReader,
  type FrickCascadeGrantLookup,
  type FrickGrantLookup,
  type FrickPolicyHook,
  type Principal,
} from "./authz.js";
import {
  DEFAULT_TENANT_ID,
  TenantIdValidationError,
  normalizeTenantId,
  validateTenantId,
} from "./tenant.js";
import {
  createFrickExtensionRegistry,
  type FrickExtensionRegistryInput,
} from "./extensions.js";
import { SyncGateway } from "./sync/gateway.js";
import {
  CallControlPlane,
  FakeMediaPlaneAdapter,
  type MediaPlaneAdapter,
} from "./calls/index.js";
import {
  createFrickAppRegistry,
  type FrickAppDefinition,
  type FrickAppRegistry,
} from "./apps/registry.js";
import { DEFAULT_APP_ID } from "./app-id.js";
import { createFrickPerAppRegistries } from "./apps/per-app-registries.js";
import {
  createFrickProjectModule,
  projectModuleToAppDefinition,
  type FrickProjectModule,
  type FrickProjectModuleInput,
} from "./platform/project.js";
import { handleDashboardRoute } from "./dashboard/routes.js";
import {
  createIdentityRouter,
  type IdentityProvidersConfig,
  type IdentityRouter,
} from "./auth/identity-routes.js";
import { SseRegistry } from "./sync/sse.js";
import {
  createFrickProjectionRegistry,
  type FrickProjection,
  type FrickProjectionContext,
  type FrickProjectionRegistry,
} from "./projections/registry.js";
import {
  createFrickSearchIndexRegistry,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type FrickSearchAdapter,
  type FrickSearchResult,
  type FrickSearchIndexDefinition,
  type FrickSearchIndexRegistry,
  type FrickSearchProjectInput,
} from "./search/types.js";
import {
  isReservedSearchField,
  searchSourceFromHit,
  stripSearchSourceFields,
} from "./search/source-fields.js";
import type { StoredAccount } from "./storage/account-store.js";
import type { StoredSession } from "./storage/session-store.js";
import { TenantAlreadyExistsError } from "./storage/tenant-store.js";
import { DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS, FrickStore } from "./store.js";
import { exportDataSubject } from "./compliance/data-subject-export.js";
import { eraseDataSubject } from "./compliance/data-subject-erase.js";
import {
  buildAccountExportBase,
  type AccountExport,
  type OnAccountExport,
} from "./compliance/account-export.js";
import {
  deleteAccountData,
  type OnAccountDelete,
} from "./compliance/account-delete.js";
import { FrickObjectVersionConflictError } from "./storage/object-errors.js";
import {
  FrickConfigError,
  isOriginInAllowlist,
  loadFrickConfig,
  type FrickConfig,
  type FrickConfigOverrides,
} from "./config.js";
import {
  createConsoleLogger,
  createNoopLogger,
  redactSensitiveFields,
  type FrickLogger,
} from "./logger.js";
import { FrickLimitError, limitsFromEnv, mergeLimits, type FrickLimits } from "./limits.js";
import { resolveTenantLimits } from "./tenant-config.js";
import { createInMemoryMetrics, type FrickMetrics } from "./metrics.js";
import {
  createFrickTelemetryRuntime,
  type FrickHttpTelemetryResult,
  type FrickHttpTelemetrySpan,
  type FrickTelemetryRuntime,
} from "./telemetry/runtime.js";
import {
  createFrickJobRegistry,
  type FrickJobHandler,
} from "./jobs/registry.js";
import { createFrickJobWorker } from "./jobs/worker.js";
import {
  createFrickRecurringRegistry,
  createRecurringScheduler,
  type FrickRecurringJob,
  type FrickRecurringRegistry,
} from "./jobs/recurring.js";
import { createFrickAnalyticsEventConsumer } from "./analytics/consumer.js";
import {
  buildAnalyticsSummary,
  normalizeAnalyticsSummaryWindowMs,
} from "./analytics/summary.js";
import {
  createFrickPushRegistry,
  type FrickPushRegistry,
} from "./push/registry.js";
import { createFrickTestPushAdapter } from "./push/test-adapter.js";
import {
  createNotificationRouter,
  PUSH_DELIVER_JOB_TYPE,
  type NotificationRouter,
} from "./push/router.js";
import type { FrickNotificationIntent, FrickPushAdapter } from "./push/types.js";
import { isPushPlatform } from "./storage/push-registration-store.js";
import { validateWebPushRegistrationToken } from "./push/web-push-adapter.js";
import {
  saveApnsCredentials,
  saveFcmCredentials,
  saveWebPushCredentials,
  type ApnsCredentials,
  type FcmCredentials,
  type PushCredentialError,
  type WebPushCredentials,
} from "./push/credentials.js";
import { dumpFrickDatabase, type FrickDumpOptions } from "./backup/dump.js";
import {
  FrickRestoreRefusedError,
  restoreFrickDatabase,
} from "./backup/restore.js";
import {
  type FrickBlobProcessor,
} from "./blobs/processor.js";
import {
  BLOB_PROCESS_JOB_TYPE,
  createBlobProcessorJobHandler,
} from "./blobs/processor-job.js";
import {
  BLOB_GC_JOB_TYPE,
  createBlobGcJobHandler,
  createBlobGcRecurringJob,
  DEFAULT_BLOB_GC_GRACE_MS,
  DEFAULT_BLOB_GC_INTERVAL_MS,
  type BlobIsReferencedHook,
} from "./blobs/gc-job.js";
import {
  encodeBlobProcessPayload,
} from "./blobs/processor-job.js";
import { emitDevToolsEvent } from "./devtools/emit.js";
import { createPlatformEventPipeline } from "./platform-events/factory.js";
import type { PlatformEventPipeline } from "./platform-events/types.js";
import type { FrickClusterBus } from "./cluster/bus.js";
import type { BlobBytesDriver } from "./storage/blob-bytes-driver.js";

export interface FrickAppRoute {
  /** URL pathname prefix this route claims. */
  pathPrefix: string;
  /** Optional HTTP method filter. Omit to match any method. */
  method?: string;
  /**
   * Returns true if the route handled the request, false to fall through to
   * the next appRoute entry (or Frick's built-in routing if all fall through).
   *
   * CORS for /api/* OPTIONS preflight: app routes are responsible for
   * setting their own CORS headers. Frick's built-in CORS headers apply only
   * after all appRoutes have returned false.
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> | boolean;
}

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  sseHeartbeatMs?: number;
  extensions?: FrickExtensionRegistryInput;
  /**
   * Runtime config. Either a fully-resolved {@link FrickConfig} or a partial
   * override object — when partial, missing fields are filled in via
   * {@link loadFrickConfig}. Omit to load entirely from env vars.
   */
  config?: FrickConfig | FrickConfigOverrides;
  /**
   * Logger to use for startup and shutdown events. Defaults to a no-op
   * logger in tests (when `config.env === "test"`) and a structured console
   * logger otherwise.
   */
  logger?: FrickLogger;
  /**
   * Maximum time `close()` waits for in-flight HTTP handlers to settle
   * before forcibly closing the underlying socket. Defaults to 5 seconds.
   */
  shutdownTimeoutMs?: number;
  /**
   * Optional ordered list of policy hooks. Each hook runs AFTER the
   * framework's default decision and can tighten — but not loosen — the
   * outcome. See {@link FrickPolicyHook}.
   */
  policyHooks?: readonly FrickPolicyHook[];
  /**
   * App augmentation hook for `GET /account/export`. The framework default
   * returns every object record the calling principal owns (grouped by object
   * type, within their tenant). Supply this hook to add app-specific data
   * (e.g. stream history, blob metadata) to the bundle — its return value is
   * attached to the response as `app`. The hook receives the resolved
   * {@link Principal} and the framework's owned-object base; it MUST scope
   * every read it performs to `principal.tenantId`/`principal.userId`. See
   * {@link OnAccountExport} and `docs/operations.md`.
   */
  onAccountExport?: OnAccountExport;
  /**
   * App cascade hook for `DELETE /account`. The framework default removes every
   * object record the calling principal owns (within their tenant), all of
   * their sessions in that tenant, and their account record. Supply this hook to
   * cascade app-specific deletion (stream history, blob content, derived
   * projections, third-party records). It runs AFTER the framework-default
   * deletion has committed, receives the resolved {@link Principal} and the
   * framework's {@link AccountDeleteResult}, and MUST scope every delete it
   * performs to `principal.tenantId`/`principal.userId`. See
   * {@link OnAccountDelete} and `docs/operations.md`.
   */
  onAccountDelete?: OnAccountDelete;
  /**
   * Bounded runtime limits. Partial — missing fields fall back to
   * {@link DEFAULT_FRICK_LIMITS}.
   */
  limits?: Partial<FrickLimits>;
  /**
   * Capacity of the in-process LRU front cache for idempotency lookups.
   * Defaults to 10,000. Tune lower for quiet single-tenant deployments,
   * higher for noisy ones. See `docs/operations.md`.
   */
  idempotencyCacheCapacity?: number;
  /**
   * In-process metrics registry. Defaults to {@link createInMemoryMetrics}.
   * Exposed at `/_frick/inspect/metrics` when `config.inspectionEnabled` is
   * true. Counters and gauges only — see `apps/server/src/metrics.ts`.
   */
  metrics?: FrickMetrics;
  /**
   * OpenTelemetry runtime. Defaults to the built-in OTel SDK integration
   * when `config.otelEnabled` is true, otherwise a no-op runtime.
   */
  telemetry?: FrickTelemetryRuntime;
  /**
   * Platform event pipeline override. Defaults to the configured pipeline
   * built from the store's SQLite adapter.
   */
  platformEvents?: PlatformEventPipeline;
  /**
   * Background-job framework configuration. Handlers are registered once at
   * boot; the worker polls the {@link JobStore} and dispatches claimed jobs
   * through them. Set `workerEnabled: false` in tests to keep the polling
   * loop quiet — the default is "on outside of test runners".
   */
  jobs?: {
    handlers?: Record<string, FrickJobHandler>;
    workerEnabled?: boolean;
    pollIntervalMs?: number;
  };
  /**
   * Product analytics aggregation worker configuration. The worker consumes
   * `analytics.user_event` envelopes from the configured platform-event
   * pipeline into the server's durable analytics read model. Defaults to on
   * outside of test runners.
   */
  analytics?: {
    workerEnabled?: boolean;
    pollIntervalMs?: number;
    claimBatchSize?: number;
  };
  /**
   * Push-notification framework configuration. Adapters supplied here are
   * registered before the default test adapter, so an app that wires its
   * own `platform: "test"` adapter overrides the framework default. The
   * built-in APNs, FCM, and Web Push reference adapters are exported from
   * `@fricken/server` and documented package subpaths.
   */
  push?: {
    adapters?: FrickPushAdapter[];
  };
  /**
   * Blob processors registered at boot. Each processor is added to the
   * store's {@link FrickBlobProcessorRegistry} in declaration order — apps
   * supply fast `validate(...)` hooks (rejected uploads short-circuit with
   * `blob.unsupportedContentType`) and/or slow `process(...)` hooks
   * (executed asynchronously as `blob.process` jobs). The `blob.process`
   * job handler is registered automatically.
   */
  blobProcessors?: FrickBlobProcessor[];
  /**
   * Orphaned-blob garbage collection (FR-57). OFF BY DEFAULT — omit this entire
   * option and no blob is ever GC'd. When `enabled: true`, the framework
   * registers the `blob.gc` job handler and a recurring sweep that, per tenant,
   * deletes `blob_metadata` rows (plus their bytes + derivatives) that are
   * unreferenced by every *declared* blob-ref field (`kind:'ref'` whose
   * `ref ∈ schema.blobs`) AND outside the grace window AND not protected by the
   * optional `isReferenced` hook.
   *
   * CAVEAT — read before enabling: the declared-ref scan CANNOT see blob ids
   * stored in untyped `string`/`json` fields. If your app does that, you MUST
   * supply `isReferenced` to protect those blobs (and/or keep a generous
   * `graceMs`). See `blobRefFields` and CHANGELOG.md for the full rationale.
   */
  blobGc?: {
    enabled: boolean;
    /** Grace window (ms). Defaults to {@link DEFAULT_BLOB_GC_GRACE_MS} (7d). */
    graceMs?: number;
    /** Sweep cadence (ms). Defaults to {@link DEFAULT_BLOB_GC_INTERVAL_MS} (1h); MUST be >= 60_000. */
    intervalMs?: number;
    /** Optional hook to protect blobs referenced via untyped fields. */
    isReferenced?: BlobIsReferencedHook;
  };
  /**
   * Search subsystem configuration. Apps register indexes via `searchIndexes`.
   * Supplying an `adapter` overrides the default SQLite FTS5 implementation —
   * useful for routing to Meilisearch or another engine.
   */
  search?: {
    adapter?: FrickSearchAdapter;
    indexes?: readonly FrickSearchIndexDefinition[];
  };
  /**
   * App-defined projections registered at boot. Each projection derives a
   * read model from one or more source object/stream types and is exposed
   * for HTTP read (`GET /projections/:name`) and live delta push over the
   * sync gateway (clients subscribe with a `projection` frame and receive an
   * initial snapshot followed by tenant-scoped `ProjectionDelta` updates).
   *
   * Every declared source `type` must reference a real object or stream type
   * in the active schema; otherwise boot throws {@link FrickConfigError}.
   */
  projections?: readonly FrickProjection[];
  /**
   * Override the schema used by the underlying store. Defaults to
   * {@link foundationSchema}. Primarily exposed for tests that need to
   * exercise behaviors (e.g. {@link FrickObjectMergePolicy}) on object
   * types not present in the foundation schema.
   */
  schema?: FrickSchema;
  /**
   * Project module loaded by the platform runtime. This is the preferred
   * Firebase-like app boundary: project code supplies schema and metadata,
   * while Frick owns the runtime. Existing `schema` and `apps` options remain
   * supported and take precedence for backwards compatibility.
   */
  project?: FrickProjectModule | FrickProjectModuleInput;
  /**
   * Third-party identity providers. When set, Frick auto-mounts the
   * matching routes (e.g. `/auth/apple/verify`, `/auth/apple/notifications`)
   * and handles JWT verification + session minting. Apps wire their own
   * User-shaped schema object via `userObject` and an optional
   * `onFirstSignIn` hook for per-user setup (tenants, memberships, etc.).
   *
   * See {@link IdentityProvidersConfig}.
   */
  identityProviders?: IdentityProvidersConfig;
  /**
   * Mount multiple Frick "apps" on the same server. Each app gets a URL
   * prefix; `GET <basePath>/schema` returns that app's schema, and Hello
   * compatibility uses the app whose schemaId the client advertises.
   *
   * When omitted, the server runs in single-app mode: one root app with
   * `basePath: ""` exposing `options.schema ?? project.schema ?? foundationSchema`.
   * Throws {@link FrickConfigError} on duplicate basePath or invalid basePath shape.
   *
   * V1 limitation: storage is server-shared. App routing affects URL
   * dispatch and Hello handshake only; reads/writes all hit the same
   * underlying store. See `docs/operations.md` for the partition follow-up.
   */
  apps?: readonly FrickAppDefinition[];
  /**
   * Optional cluster bus for horizontal-scale fan-out. When set, the
   * sync gateway forwards every locally-published stream event +
   * object delta to peer nodes (Redis / NATS / whatever the bus
   * adapter wraps) and applies peer envelopes back into local
   * subscribers. Single-node deployments can leave this unset; the
   * gateway then runs in-process only, identical to the pre-Phase 7
   * behavior.
   *
   * Bus contract: `apps/server/src/cluster/bus.ts`. The framework ships
   * `MemoryClusterBus` for tests / single-node use and `RedisClusterBus`
   * (FR-27) for production multi-node fan-out — build one with
   * `await createRedisClusterBus({ url: process.env.FRICK_REDIS_URL })`
   * and pass it here.
   */
  clusterBus?: FrickClusterBus;
  /**
   * Pre-built blob-bytes driver for the `s3` blob driver (FR-54). When
   * `config.blobDriver === "s3"`, build the driver with
   * `await createS3BlobBytesDriver({ bucket, region, endpoint, prefix })` and
   * pass it here — exactly like {@link ServerOptions.clusterBus}. The store
   * constructor is synchronous and the AWS SDK is imported asynchronously, so
   * the s3 driver must be constructed by the caller and injected. When the
   * config selects `s3` but no driver is provided here, the store factory
   * throws a clear error at construction. Ignored for the `sqlite`/`filesystem`
   * drivers.
   */
  blobBytesDriver?: BlobBytesDriver;
  /**
   * App-owned HTTP routes. Each entry handles requests with `request.url`
   * starting with `pathPrefix` (and matching `method` when set). Returning
   * `true` from `handle` claims the request; `false` falls through to
   * Frick's built-in handler. Lets apps mount their own routes (REST APIs,
   * OAuth callbacks, webhook endpoints) without monkey-patching the
   * server's `request` listener.
   *
   * CORS for /api/* OPTIONS: Frick's built-in CORS shortcut runs only
   * after all appRoutes entries have returned false. Apps that need CORS on
   * their own prefixes should handle the OPTIONS method themselves inside
   * their `handle` function.
   *
   * Routes are tested in declaration order; a more-specific route registered
   * before a less-specific one takes priority.
   */
  appRoutes?: readonly FrickAppRoute[];
  /**
   * Recurring job configuration. Jobs registered here are automatically
   * re-enqueued on a time-window schedule without requiring an external cron.
   * The scheduler fires every `tickIntervalMs` (default 30_000 ms) and
   * enqueues one job per (tenantId, window) tuple returned by
   * `resolveTargets`. Idempotency is enforced via
   * `recurring:<name>:<tenantId>:<windowStart>` so double-ticks within the
   * same window are no-ops. All jobs must have `intervalMs >= 60_000`.
   *
   * The scheduler timer is unref'd so it does not prevent the process from
   * exiting if the server is closed. Stop is called automatically on
   * `close()`.
   */
  recurring?: {
    jobs?: readonly FrickRecurringJob[];
    tickIntervalMs?: number;
  };
  /**
   * FR-15 — realtime calls. When enabled, the server stands up a
   * {@link CallControlPlane} over the active store and exposes it on the sync
   * WebSocket via the {@link FrameKind.CallCommand} frame
   * (create/join/leave/accept/end/setMediaState). Records sync as ordinary
   * objects; WebRTC SDP/ICE rides the existing `WebRTCSignal` relay.
   *
   * Defaults to ON with the deterministic {@link FakeMediaPlaneAdapter} so the
   * wire is testable without real media infra. Supply `mediaPlane` to plug in a
   * real adapter, or set `enabled: false` to leave the surface off.
   */
  calls?: {
    enabled?: boolean;
    mediaPlane?: MediaPlaneAdapter;
  };
}

export function createFrickServer(options: ServerOptions = {}) {
  const config = resolveConfig(options.config);
  const port = options.port ?? Number(process.env.PORT ?? config.port);
  const host = config.host;
  const startedAt = new Date().toISOString();
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
  const inTestRunner =
    config.env === "test" ||
    process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined;
  const logger =
    options.logger ?? (inTestRunner ? createNoopLogger() : createConsoleLogger(config));
  // Env-derived limit overrides form the base; explicit `options.limits`
  // win over them, and both win over the framework defaults.
  const limits = mergeLimits({ ...limitsFromEnv(), ...options.limits });
  const metrics = options.metrics ?? createInMemoryMetrics();
  const telemetry =
    options.telemetry ?? createFrickTelemetryRuntime({ config, logger });
  const startedAtPerf = performance.now();
  const authAttemptLimiter = new FixedWindowAuthAttemptLimiter();
  if (
    options.platformEvents === undefined &&
    config.platformEventsDriver === "kafka" &&
    config.platformEventsKafkaBrokers.length === 0
  ) {
    throw new FrickConfigError(
      "FRICK_PLATFORM_EVENTS_KAFKA_BROKERS is required when FRICK_PLATFORM_EVENTS_DRIVER=kafka",
    );
  }
  const project = options.project ? createFrickProjectModule(options.project) : undefined;
  const runtimeSchema =
    options.schema ?? (options.apps === undefined ? project?.schema : undefined) ?? foundationSchema;

  function sendErrorWithMetrics(
    response: http.ServerResponse,
    error: unknown,
    requestId: string,
  ): void {
    const code = httpErrorCode(error);
    metrics.counter("frick.http.errors.total", { code }).inc();
    sendError(response, error, requestId);
  }
  const projections = createFrickProjectionRegistry();
  registerProjections(projections, options.projections ?? [], runtimeSchema);
  const searchIndexes = createFrickSearchIndexRegistry();
  for (const def of options.search?.indexes ?? []) {
    searchIndexes.register(def);
  }

  // Per-app registries (FR-153): a multi-app server whose apps declare their
  // own projections or job handlers gets one independent projection + job
  // registry per app, so app A's projections/handlers never fire on app B's
  // writes/jobs. We only activate this when at least one app declares per-app
  // config — a single-app (or routing-only multi-app) server leaves the shared
  // `projections` registry and single job registry in place, byte-for-byte
  // unchanged. The gateway's projection-delta fan-out is routed per app through
  // a late-bound reference set once the gateway is constructed below.
  const appsWithPerAppConfig = (options.apps ?? []).some(
    (app) =>
      (app.projections && app.projections.length > 0) ||
      (app.jobs && Object.keys(app.jobs).length > 0),
  );
  let gatewayRef: SyncGateway | undefined;
  const perAppRegistries = appsWithPerAppConfig
    ? createFrickPerAppRegistries({
        projectionDeltaListenerFor: () => (notice) =>
          gatewayRef?.publishProjectionDelta(notice),
      })
    : undefined;
  if (perAppRegistries) {
    // The default app's set carries the server-wide projections (the same ones
    // registered into the shared `projections` registry above), so writes under
    // `_default` keep firing them. Per-app projections register into each app's
    // own set.
    registerProjections(
      perAppRegistries.for(DEFAULT_APP_ID).projections,
      options.projections ?? [],
      runtimeSchema,
    );
    for (const app of options.apps ?? []) {
      if (app.projections && app.projections.length > 0) {
        registerProjections(
          perAppRegistries.for(app.id).projections,
          app.projections,
          app.schema,
        );
      }
    }
  }

  const store = new FrickStore({
    path: options.dbPath ?? process.env.FRICK_DB_PATH ?? defaultDatabasePath(),
    dbDriver: config.dbDriver,
    dbUrl: config.databaseUrl,
    schema: runtimeSchema,
    seed: false,
    projections,
    ...(perAppRegistries ? { perAppRegistries } : {}),
    searchIndexes,
    ...(options.search?.adapter !== undefined ? { searchAdapter: options.search.adapter } : {}),
    logger,
    ...(options.idempotencyCacheCapacity !== undefined
      ? { idempotencyCacheCapacity: options.idempotencyCacheCapacity }
      : {}),
    platformEventsRetentionMs: config.platformEventsRetentionMs,
    platformEventsMaxRows: config.platformEventsMaxRows,
    idempotencyKeyRetentionMs: config.idempotencyKeyRetentionMs,
    devtoolsEventsRetentionMs: config.devtoolsEventsRetentionMs,
    expiredSessionRetentionGraceMs: config.expiredSessionRetentionGraceMs,
    idempotencyReplayWindowMs: config.idempotencyReplayWindowMs,
    blobDriver: config.blobDriver,
    blobStoragePath: config.blobStoragePath,
    ...(options.blobBytesDriver ? { blobS3Driver: options.blobBytesDriver } : {}),
    passwordHasher: config.passwordHasher,
  });
  const platformEvents =
    options.platformEvents ??
    createPlatformEventPipeline({
      config,
      sqlite: store.platformEvents,
    });
  // Notify the adapter once per index so external engines can allocate
  // per-index state. For the default SQLite adapter this is a no-op.
  for (const def of searchIndexes.list()) {
    store.searchAdapter.registerIndex(def);
  }
  // App registry: in single-app mode (no `options.apps`), synthesize a root
  // app exposing the store's schema so request resolution always succeeds.
  const defaultApp: FrickAppDefinition =
    project && options.schema === undefined
      ? projectModuleToAppDefinition(project)
      : { id: "foundation", schema: store.schema, basePath: "" };
  const appRegistry: FrickAppRegistry = createFrickAppRegistry(
    options.apps ?? [defaultApp],
  );
  const runtimeProject =
    project && options.schema === undefined && options.apps === undefined
      ? project
      : createFrickProjectModule({
          manifest: {
            id: defaultApp.id,
            name: defaultApp.id,
            displayName: defaultApp.id === "foundation" ? "Frick Foundation" : defaultApp.id,
          },
          schema: store.schema,
        });
  const extensions = createFrickExtensionRegistry(options.extensions);
  // Precompute the admin token fingerprint once so audit-log inserts don't
  // hash on every request. SHA-256 truncated to 12 hex chars: short enough to
  // skim in logs, long enough that two distinct tokens collide with
  // negligible probability for the operator-token cardinalities we expect.
  const adminTokenFingerprint = config.adminToken
    ? createHash("sha256").update(config.adminToken).digest("hex").slice(0, 12)
    : "";
  // Auth + data-lifecycle audit. Login / logout / signup / data-export are
  // user-initiated (no admin token), so the actor fingerprint is derived from
  // the subject userId rather than the admin token — same 12-hex-char shape
  // the admin chain uses, so an operator can correlate rows without the row
  // ever carrying the raw identity. `detail` is scrubbed through the shared
  // log-redaction helper so a caller can never leak a token/body into the
  // tamper-evident chain. Best-effort: a dropped audit row must never fail a
  // legitimate auth action.
  const subjectFingerprint = (subject: string): string =>
    `u:${createHash("sha256").update(subject).digest("hex").slice(0, 12)}`;
  const recordLifecycleAudit = (input: {
    action: string;
    subject: string;
    outcome: "allow" | "deny" | "error";
    detail?: Record<string, unknown>;
  }): void => {
    try {
      store.adminAudit.record({
        adminTokenFingerprint: subjectFingerprint(input.subject),
        action: input.action,
        target: input.subject,
        outcome: input.outcome,
        ...(input.detail !== undefined
          ? { detail: JSON.stringify(redactSensitiveFields(input.detail)) }
          : {}),
      });
    } catch {
      // Audit failures are best-effort; the auth action itself has committed.
    }
  };
  const policyHooks: readonly FrickPolicyHook[] = [
    ...(options.policyHooks ?? []),
  ];
  // Wired into assertCanWriteObject / assertCanReadObject so the framework's
  // built-in decision flow can relax a deny when an active cross-user
  // sharing grant exists for the principal. See `relaxWithGrants` in
  // authz.ts.
  const grantLookup: FrickGrantLookup = (args) =>
    store.grants.hasActiveGrantFor(args);
  // Wired into assertCanSubscribe for stream + projection reads so a grant on
  // an object record cascades read access to the stream whose `streamId`
  // matches the granted record id and to projection rows keyed by that id
  // (FR-70). Read-only; see `relaxWithCascadeGrants` in authz.ts.
  const cascadeGrantLookup: FrickCascadeGrantLookup = (args) =>
    store.grants.hasActiveGrantForRecordId(args);
  let inFlight = 0;
  let closing = false;

  function noteRequestStart(): void {
    inFlight += 1;
  }
  function noteRequestEnd(): void {
    inFlight = Math.max(0, inFlight - 1);
  }
  async function startTelemetry(): Promise<void> {
    try {
      await telemetry.start();
    } catch (err) {
      logger.warn("frick.otel.start_failed", {
        event: "frick.otel.start_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  function startHttpTelemetry(input: Parameters<FrickTelemetryRuntime["startHttpRequest"]>[0]): FrickHttpTelemetrySpan {
    try {
      return telemetry.startHttpRequest(input);
    } catch (err) {
      logger.warn("frick.otel.http_start_failed", {
        event: "frick.otel.http_start_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        end: () => {},
      };
    }
  }
  function finishHttpTelemetry(
    span: FrickHttpTelemetrySpan,
    result: FrickHttpTelemetryResult,
  ): void {
    try {
      span.end(result);
    } catch (err) {
      logger.warn("frick.otel.http_record_failed", {
        event: "frick.otel.http_record_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  async function shutdownTelemetry(): Promise<void> {
    try {
      await telemetry.shutdown();
    } catch (err) {
      logger.warn("frick.otel.shutdown_failed", {
        event: "frick.otel.shutdown_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // `closing` and `inFlight` are surfaced on the returned object for tests
  // and operators that want to observe drain state without instrumenting
  // the HTTP server directly.

  const server = http.createServer((request, response) => {
    noteRequestStart();
    response.on("close", noteRequestEnd);
    void handleHttp(request, response);
  });
  const wss = new WebSocketServer({
    server,
    path: "/_frick/sync",
    maxPayload: limits.maxWebSocketFrameBytes,
    verifyClient: (info, callback) => {
      const origin = typeof info.origin === "string" && info.origin.length > 0 ? info.origin : undefined;
      if (isOriginAllowed(origin, config.allowedOrigins)) {
        callback(true);
        return;
      }
      callback(false, 403, "origin not allowed");
    },
  });
  const sse = new SseRegistry(
    store.schema,
    {
      ...(options.sseHeartbeatMs === undefined ? {} : { heartbeatMs: options.sseHeartbeatMs }),
      maxBufferedBytes: limits.maxSseOutboundBufferedBytes,
    },
  );
  const identityRouter: IdentityRouter | undefined = options.identityProviders
    ? createIdentityRouter({
        store,
        config: options.identityProviders,
        logger,
        // FR-29: provider-minted sessions honor the single configured TTL.
        sessionTtlSeconds: config.sessionTtlSeconds,
        // FR-29: provider-verify + email password-reset endpoints share the
        // same auth-attempt limiter the built-in password-login routes use. The
        // adapter delegates to the single `authAttemptLimiter` instance and
        // translates its thrown `FrickLimitError` into a structured result the
        // identity router turns into its own 429 envelope.
        authThrottle: {
          clientIp: (req) => clientIpFromRequest(req),
          check: (input) => {
            try {
              authAttemptLimiter.check({
                route: input.route,
                tenantId: DEFAULT_TENANT_ID,
                ...(input.identifier ? { identity: input.identifier } : {}),
                clientIp: input.ip,
                limits,
              });
              return undefined;
            } catch (error) {
              if (error instanceof FrickLimitError) {
                return {
                  retryAfterSeconds: Math.ceil(limits.authRateLimitWindowMs / 1000),
                };
              }
              throw error;
            }
          },
        },
      })
    : undefined;

  // FR-15 — call control plane. Auto-enabled when the running schema declares
  // the call types (so the control plane's object/stream writes don't throw
  // `Unknown type`), using the deterministic fake media adapter so the call
  // wire is exercisable without real media infra. Apps plug in a real adapter
  // via `options.calls.mediaPlane`, force it on/off with `options.calls.enabled`
  // (forcing it on without the call types in the schema will fail at write
  // time — the schema must include `callObjectDefs`/`callStreamDefs`/etc.).
  const schemaDeclaresCalls = store.schema.objects.some((object) => object.name === "CallRoom");
  const callsEnabled = options.calls?.enabled ?? schemaDeclaresCalls;
  const callControlPlane = callsEnabled
    ? new CallControlPlane({
        store,
        mediaPlane: options.calls?.mediaPlane ?? new FakeMediaPlaneAdapter(),
      })
    : undefined;

  const gateway = new SyncGateway(wss, store, {
    onStreamEvent: (event) => sse.publishStreamEvent(event),
    limits,
    policyHooks,
    metrics,
    telemetry,
    projections: store.projections,
    // Per-app projection registries (FR-153 / tenant-app-isolation-3): when
    // active, the gateway resolves projection Subscribe + snapshot against the
    // connection's app registry instead of the shared one.
    ...(perAppRegistries ? { perAppRegistries } : {}),
    appRegistry,
    ...(callControlPlane ? { callControlPlane } : {}),
    ...(options.clusterBus ? { clusterBus: options.clusterBus } : {}),
  });
  gateway.attach();
  // Late-bind the gateway so the per-app projection-delta listeners installed
  // on each app's projection registry (above) can fan deltas out to the right
  // app's subscribers (FR-153). No-op when per-app registries are inactive.
  gatewayRef = gateway;

  // The shared job-handler registry. When per-app registries are active the
  // worker dispatches through `perAppRegistries.for(job.appId).jobs` instead,
  // so the server-wide handlers below are also registered into the default
  // app's set (and per-app handlers into their own set) — see the per-app
  // wiring after the framework handlers are registered.
  const jobRegistry = perAppRegistries
    ? perAppRegistries.for(DEFAULT_APP_ID).jobs
    : createFrickJobRegistry();
  if (options.jobs?.handlers) {
    for (const [jobType, handler] of Object.entries(options.jobs.handlers)) {
      jobRegistry.register(jobType, handler);
    }
  }

  // Push notification framework. App-provided adapters take precedence over
  // the default test adapter — `registerAdapter` throws on duplicates, so
  // we register app adapters first and skip the default if it conflicts.
  const pushRegistry: FrickPushRegistry = createFrickPushRegistry();
  const appAdapters = options.push?.adapters ?? [];
  const appAdapterPlatforms = new Set<string>();
  for (const adapter of appAdapters) {
    pushRegistry.registerAdapter(adapter);
    appAdapterPlatforms.add(adapter.platform);
  }
  if (!appAdapterPlatforms.has("test")) {
    pushRegistry.registerAdapter(createFrickTestPushAdapter());
  }
  const notificationRouter: NotificationRouter = createNotificationRouter({
    store,
    pushRegistry,
    logger,
  });
  // Register the push.deliver handler unless the app already wired their
  // own (handler registration is single-shot; we don't want to throw at
  // boot if someone is intentionally overriding).
  if (!jobRegistry.resolve(PUSH_DELIVER_JOB_TYPE)) {
    jobRegistry.register(PUSH_DELIVER_JOB_TYPE, notificationRouter.handler);
  }

  // Blob processor pipeline. App processors are registered first; the
  // store ships its registry already-empty. Register the `blob.process`
  // handler before the worker starts so claimed jobs always resolve.
  if (options.blobProcessors) {
    for (const processor of options.blobProcessors) {
      store.blobProcessors.register(processor);
    }
  }
  if (!jobRegistry.resolve(BLOB_PROCESS_JOB_TYPE)) {
    jobRegistry.register(
      BLOB_PROCESS_JOB_TYPE,
      createBlobProcessorJobHandler({
        store,
        blobProcessors: store.blobProcessors,
        logger,
      }),
    );
  }
  // Orphaned-blob GC (FR-57). OFF BY DEFAULT: only when `blobGc.enabled` is set
  // do we register the `blob.gc` handler and add the recurring sweep below.
  // Both wiring steps gate on the same flag so a default server never GCs.
  const blobGcEnabled = options.blobGc?.enabled === true;
  if (blobGcEnabled && !jobRegistry.resolve(BLOB_GC_JOB_TYPE)) {
    jobRegistry.register(
      BLOB_GC_JOB_TYPE,
      createBlobGcJobHandler({
        logger,
        config: {
          graceMs: options.blobGc?.graceMs ?? DEFAULT_BLOB_GC_GRACE_MS,
          ...(options.blobGc?.isReferenced
            ? { isReferenced: options.blobGc.isReferenced }
            : {}),
        },
      }),
    );
  }

  // Per-app job handlers (FR-153). When per-app registries are active, every
  // non-default app gets the SAME framework handlers (push.deliver,
  // blob.process, blob.gc) the default app already has — these are
  // server-provided plumbing every app needs — PLUS that app's own declared
  // `jobs` handlers. The worker then dispatches each claimed job through the
  // originating app's set (`perAppRegistries.for(job.appId).jobs`), so a custom
  // handler app A registered never runs app B's jobs. `jobRegistry` IS the
  // default app's set, so the framework handlers registered above are already
  // present there.
  if (perAppRegistries) {
    const frameworkHandlers: Array<[string, FrickJobHandler]> = [];
    for (const jobType of jobRegistry.list()) {
      const handler = jobRegistry.resolve(jobType);
      if (handler) frameworkHandlers.push([jobType, handler]);
    }
    for (const app of options.apps ?? []) {
      if (app.id === DEFAULT_APP_ID) continue;
      const appJobs = perAppRegistries.for(app.id).jobs;
      // Framework + server-wide handlers first.
      for (const [jobType, handler] of frameworkHandlers) {
        if (!appJobs.resolve(jobType)) appJobs.register(jobType, handler);
      }
      // Then the app's own handlers (override-by-precedence is impossible —
      // the registry throws on duplicates, so app handlers must not collide
      // with a framework job type; that is an app-config error worth failing
      // loudly at boot).
      for (const [jobType, handler] of Object.entries(app.jobs ?? {})) {
        appJobs.register(jobType, handler);
      }
    }
  }

  // Default: worker runs in non-test envs. Tests would otherwise have a
  // polling loop ticking during every spec, complicating shutdown ordering
  // and timer-based fixtures. Apps can flip `workerEnabled: true` per-suite
  // when they want to exercise the loop directly.
  const workerEnabledDefault = !inTestRunner;
  const workerEnabled = options.jobs?.workerEnabled ?? workerEnabledDefault;
  const worker = createFrickJobWorker({
    store,
    registry: jobRegistry,
    ...(perAppRegistries ? { perAppRegistries } : {}),
    logger,
    metrics,
    telemetry,
    platformEvents,
    ...(options.jobs?.pollIntervalMs !== undefined
      ? { pollIntervalMs: options.jobs.pollIntervalMs }
      : {}),
  });
  if (workerEnabled) {
    worker.start();
  }

  const analyticsConsumer = createFrickAnalyticsEventConsumer({
    platformEvents,
    analyticsEvents: store.analyticsEvents,
    logger,
    ...(options.analytics?.pollIntervalMs !== undefined
      ? { pollIntervalMs: options.analytics.pollIntervalMs }
      : {}),
    ...(options.analytics?.claimBatchSize !== undefined
      ? { claimBatchSize: options.analytics.claimBatchSize }
      : {}),
  });
  const analyticsWorkerEnabled =
    options.analytics?.workerEnabled ?? !inTestRunner;
  if (analyticsWorkerEnabled) {
    analyticsConsumer.start();
  }

  // The opt-in blob GC sweep (FR-57) is appended to the app's recurring jobs
  // only when enabled, so a default server schedules nothing extra.
  const recurringJobs: readonly FrickRecurringJob[] = [
    ...(options.recurring?.jobs ?? []),
    ...(blobGcEnabled
      ? [
          createBlobGcRecurringJob({
            intervalMs: options.blobGc?.intervalMs ?? DEFAULT_BLOB_GC_INTERVAL_MS,
          }),
        ]
      : []),
  ];
  const recurringRegistry: FrickRecurringRegistry = createFrickRecurringRegistry(recurringJobs);
  const recurringScheduler = createRecurringScheduler({
    store,
    logger,
    jobs: recurringRegistry.list(),
    ...(options.recurring?.tickIntervalMs !== undefined
      ? { tickIntervalMs: options.recurring.tickIntervalMs }
      : {}),
  });
  if (!inTestRunner && recurringJobs.length > 0) {
    recurringScheduler.start();
  }

  async function handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const requestId = randomUUID();
    const startedAt = performance.now();
    const telemetrySpan = startHttpTelemetry({
      requestId,
      method: request.method ?? "",
      path: url.pathname,
      host: request.headers.host,
    });
    let requestLogger = logger.child({
      requestId,
      method: request.method ?? "",
      path: url.pathname,
    });
    // Capture the principal's tenant for the DevTools event row alongside
    // the existing log/metric emissions. We don't widen the logger callback
    // signature — we just stash the tenant in a local.
    let observedTenantId: string | undefined;
    let observedUserId: string | undefined;
    try {
      await dispatchHttp(request, response, url, (principal) => {
        observedTenantId = principal.tenantId;
        observedUserId = principal.userId;
        requestLogger = requestLogger.child({
          tenantId: principal.tenantId,
          userId: principal.userId,
        });
      });
    } finally {
      const status = response.statusCode;
      const durationMs = Math.round(performance.now() - startedAt);
      requestLogger.info("frick.http.request", {
        status,
        durationMs,
      });
      metrics
        .counter("frick.http.requests.total", {
          method: request.method ?? "",
          status: String(status),
        })
        .inc();
      finishHttpTelemetry(telemetrySpan, {
        statusCode: status,
        durationMs,
        tenantId: observedTenantId,
        userId: observedUserId,
      });
      // Durable structured event for the DevTools console. Additive — the
      // log line above remains the canonical stderr trace and the metric
      // counter above remains the canonical aggregate.
      emitDevToolsEvent(store, {
        kind: "http.request",
        ...(observedTenantId !== undefined ? { tenantId: observedTenantId } : {}),
        fields: {
          requestId,
          method: request.method ?? "",
          path: url.pathname,
          status,
          durationMs,
        },
      });
    }
  }

  async function dispatchHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    requestUrl: URL,
    onPrincipal: (principal: Principal) => void,
  ): Promise<void> {
    const appRoutes = options.appRoutes ?? [];
    for (const route of appRoutes) {
      const pathname = requestUrl.pathname;
      if (!pathname.startsWith(route.pathPrefix)) continue;
      if (route.method && request.method !== route.method) continue;
      let claimed: boolean;
      try {
        claimed = await route.handle(request, response);
      } catch (err) {
        logger.error("frick.app_route.handle_failed", {
          event: "frick.app_route.handle_failed",
          pathPrefix: route.pathPrefix,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "internal_error", message: "App route handler threw an error" }));
        }
        return;
      }
      if (claimed) return;
    }

    const requestOrigin = headerValue(request, "origin");
    const originAllowed = isOriginAllowed(requestOrigin, config.allowedOrigins);
    setCors(response, requestOrigin, config.allowedOrigins, originAllowed, store.schema.hash);

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        sendErrorWithMetrics(
          response,
          new CorsOriginRejectedError("Origin not allowed by CORS policy"),
          "cors_rejected",
        );
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }

    if (
      await handleDashboardRoute({
        request,
        response,
        url: requestUrl,
        project: runtimeProject,
        appRegistry,
        store,
        platformEvents,
        analyticsEvents: store.analyticsEvents,
        authenticate: () => inspectionPrincipalFromRequest(request, requestUrl, store, config),
        sendJson: (status, body) => sendJson(response, status, body),
        sendError: (error, requestId) => sendErrorWithMetrics(response, error, requestId),
      })
    ) {
      return;
    }

    // Resolve which app owns this URL and rebind `url` to use the relative
    // path. The legacy single-app default (basePath: "") makes this a no-op
    // for existing call sites. App schema is preferred over `store.schema`
    // for any handler that reports schema metadata back to clients.
    const resolution = appRegistry.resolveByPath(requestUrl);
    const url = resolution
      ? new URL(`${requestUrl.origin}${resolution.relativePath}${requestUrl.search}`)
      : requestUrl;
    const activeApp: FrickAppDefinition =
      resolution?.app ?? { id: "foundation", schema: store.schema, basePath: "" };
    const appSchema = activeApp.schema;
    // Storage app id for this request (FR-153). A genuine multi-app server
    // (registry with more than one app) partitions storage by the resolved
    // app's id; a single-app server keeps every row under `_default` so
    // existing data and callers are byte-for-byte unaffected. Mirrors the
    // WS gateway's `#storageAppId`.
    const activeAppId =
      appRegistry.list().length > 1 ? activeApp.id : DEFAULT_APP_ID;

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "frick-server", status: "ok" });
      return;
    }

    // Third-party identity provider routes (Apple, Google, ...). Mounted
    // when the app passes `identityProviders` to createFrickServer.
    if (identityRouter) {
      const claimed = await identityRouter.handle(request, response);
      if (claimed) return;
    }

    if (request.method === "GET" && url.pathname === "/ready") {
      const applied = await safeListAppliedMigrations(store);
      const dbReady = store.pingDatabase();
      const migrationsReady = applied !== undefined;
      if (!dbReady || !migrationsReady) {
        sendJson(response, 503, {
          status: "not-ready",
          reason: !dbReady ? "database_unresponsive" : "migrations_unavailable",
          schemaId: store.schema.schemaId,
          schemaRevision: store.schema.schemaRevision,
          schemaHash: store.schema.hash,
          appliedMigrations: applied?.length ?? 0,
        });
        return;
      }
      sendJson(response, 200, {
        status: "ready",
        schemaId: store.schema.schemaId,
        schemaRevision: store.schema.schemaRevision,
        schemaHash: store.schema.hash,
        appliedMigrations: applied.length,
      });
      return;
    }

    if (config.inspectionEnabled && request.method === "GET" && url.pathname.startsWith("/_frick/inspect/")) {
      const inspectionPrincipal = await inspectionPrincipalFromRequest(request, url, store, config);
      if (inspectionPrincipal instanceof Error) {
        sendErrorWithMetrics(response, inspectionPrincipal, "inspect_unauthorized");
        return;
      }
      const sub = url.pathname.slice("/_frick/inspect/".length);
      if (sub === "server") {
        sendJson(response, 200, {
          schemaId: appSchema.schemaId,
          schemaVersion: appSchema.schemaVersion,
          schemaRevision: appSchema.schemaRevision,
          schemaHash: appSchema.hash,
          appId: activeApp.id,
          env: config.env,
          demoAuthEnabled: config.demoAuthEnabled,
          inspectionEnabled: config.inspectionEnabled,
          startedAt,
        });
        return;
      }
      if (sub === "apps") {
        sendJson(response, 200, {
          apps: appRegistry.list().map((app) => ({
            id: app.id,
            basePath: app.basePath,
            schemaId: app.schema.schemaId,
            schemaRevision: app.schema.schemaRevision,
          })),
        });
        return;
      }
      if (sub === "migrations") {
        const applied = (await safeListAppliedMigrations(store)) ?? [];
        sendJson(response, 200, {
          applied: applied.map((row) => ({
            id: row.id,
            schemaRevision: row.schemaRevision,
            appliedAt: row.appliedAt,
            checksum: row.checksum,
            durationMs: row.durationMs,
          })),
        });
        return;
      }
      if (sub === "metrics") {
        const snap = metrics.snapshot();
        sendJson(response, 200, {
          snapshotAt: new Date().toISOString(),
          uptimeSeconds: (performance.now() - startedAtPerf) / 1000,
          counters: snap.counters,
          gauges: snap.gauges,
        });
        return;
      }
      if (sub === "platform-events") {
        sendJson(response, 200, await platformEvents.health());
        return;
      }
      if (sub === "analytics/summary") {
        sendJson(response, 200, await buildAnalyticsSummary({
          store: store.analyticsEvents,
          principal: inspectionPrincipal,
          windowMs: normalizeAnalyticsSummaryWindowMs(url.searchParams.get("windowMs")),
          ...optionalPositiveLimit(url.searchParams.get("limit")),
        }));
        return;
      }
      if (sub === "projections") {
        sendJson(response, 200, {
          projections: store.projections.list().map((projection) => ({
            name: projection.name,
            sources: projection.sources,
            supportsRebuild: typeof projection.handler.rebuild === "function",
            supportsRead: typeof projection.handler.read === "function",
          })),
        });
        return;
      }
      if (sub === "search") {
        sendJson(response, 200, {
          adapter: store.searchAdapter.id,
          indexes: store.searchIndexes.list().map((def) => ({
            name: def.name,
            source: def.source,
          })),
        });
        return;
      }
      if (sub === "db") {
        const applied = (await safeListAppliedMigrations(store)) ?? [];
        const last = applied[applied.length - 1];
        sendJson(response, 200, {
          ready: store.pingDatabase(),
          applied: applied.length,
          ...(last
            ? {
                lastApplied: {
                  id: last.id,
                  schemaRevision: last.schemaRevision,
                  appliedAt: last.appliedAt,
                },
              }
            : {}),
          idempotencyCache: {
            size: store.idempotencyCache.size,
            capacity: store.idempotencyCache.capacity,
            evictions: store.idempotencyCache.evictions,
          },
        });
        return;
      }
      if (sub === "jobs") {
        sendJson(response, 200, {
          registeredHandlers: jobRegistry.list(),
          counts: await store.jobs.countsByStatus(),
          workerEnabled,
        });
        return;
      }
      // DevTools event feed. `events` lists rows newest-first with optional
      // filters; `summary` aggregates by kind over a rolling window; the
      // per-id route lets the console drill into a single emission. All three
      // are gated by the same `inspectionEnabled` flag as the rest of the
      // /_frick/inspect surface — production defaults off.
      if (sub === "devtools/events") {
        const kindParam = url.searchParams.get("kind");
        const tenantParam = url.searchParams.get("tenantId");
        const sinceIdParam = url.searchParams.get("sinceId");
        const limitParam = url.searchParams.get("limit");
        const filter: {
          kind?: string;
          tenantId?: string;
          sinceId?: number;
          limit?: number;
        } = {};
        if (kindParam) filter.kind = kindParam;
        if (tenantParam) filter.tenantId = tenantParam;
        if (sinceIdParam) {
          const parsed = Number(sinceIdParam);
          if (Number.isFinite(parsed)) filter.sinceId = parsed;
        }
        if (limitParam) {
          const parsed = Number(limitParam);
          if (Number.isFinite(parsed)) filter.limit = parsed;
        }
        sendJson(response, 200, { events: await store.devtoolsEvents.list(filter) });
        return;
      }
      if (sub === "devtools/summary") {
        const windowParam = url.searchParams.get("windowMs");
        const windowMs = windowParam ? Number(windowParam) : 60_000;
        sendJson(response, 200, await store.devtoolsEvents.summary(
          Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000,
        ));
        return;
      }
      if (sub.startsWith("devtools/events/")) {
        const idRaw = sub.slice("devtools/events/".length);
        const id = Number(idRaw);
        if (!Number.isFinite(id) || id <= 0) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        const row = await store.devtoolsEvents.getById(id);
        if (!row) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, { event: row });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    if (url.pathname.startsWith("/_frick/admin/")) {
      if (!config.adminEnabled) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const adminPrincipal = adminPrincipalFromRequest(request, url, config);
      if (!adminPrincipal) {
        // Token is wrong or missing. Distinguish between "no auth at all" and
        // "auth but not admin": when a request supplies a valid session token
        // but for a tenant-scoped principal, this is `auth.forbidden` (403);
        // otherwise it's `auth.unauthenticated` (401).
        const token = sessionTokenFromRequest(request, url);
        if (!token) {
          sendErrorWithMetrics(response, new AuthenticationError("Missing admin token"), "admin_unauthorized");
          return;
        }
        const session = await store.readActiveSession(token);
        if (session) {
          sendErrorWithMetrics(
            response,
            new AuthorizationError({
              allow: false,
              reason: "notAuthorizedForResource",
              publicMessage: "Admin scope required",
            }),
            "admin_forbidden",
          );
          return;
        }
        sendErrorWithMetrics(response, new AuthenticationError("Invalid admin token"), "admin_unauthorized");
        return;
      }
      try {
        await handleAdminRoute(
          request,
          response,
          url,
          store,
          config,
          limits.maxHttpBodyBytes,
          adminTokenFingerprint,
          logger,
          notificationRouter,
          gateway,
        );
      } catch (error) {
        sendErrorWithMetrics(response, error, "admin_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/schema") {
      sendJson(response, 200, appSchema);
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/signup") {
      try {
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const displayName = normalizeDisplayName(requireString(body.displayName, "displayName"));
        const handle = normalizeHandle(requireString(body.handle, "handle"));
        const password = normalizePassword(requireString(body.password, "password"));
        const tenantId = resolveAuthTenantId(body.tenantId);
        await ensureTenantAllowed(store, config, tenantId);
        authAttemptLimiter.check({
          route: "/auth/signup",
          tenantId,
          identity: handle,
          clientIp: clientIpFromRequest(request),
          limits,
        });
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const account = await store.createAccountUser({
          userId: userIdFromHandle(tenantId, handle),
          handle,
          displayName,
          password,
          tenantId,
        });
        const session = await createSessionForUser(store, account.userId, deviceId, replicaId, platform, config, tenantId);
        recordLifecycleAudit({
          action: "auth.signup",
          subject: account.userId,
          outcome: "allow",
          detail: { tenantId, platform },
        });

        sendAuthJson(response, 201, authSessionResponse(store, session, account));
      } catch (error) {
        sendErrorWithMetrics(response, error, "signup_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/login") {
      try {
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const identity = requireString(body.identity, "identity").trim();
        const password = requireString(body.password, "password");
        const tenantId = resolveAuthTenantId(body.tenantId);
        await ensureTenantAllowed(store, config, tenantId);
        authAttemptLimiter.check({
          route: "/auth/login",
          tenantId,
          identity,
          clientIp: clientIpFromRequest(request),
          limits,
        });
        const account = await store.verifyAccountPassword(tenantId, identity, password);
        if (!account) {
          recordLifecycleAudit({
            action: "auth.login",
            subject: `${tenantId}:${identity}`,
            outcome: "deny",
            detail: { tenantId, reason: "invalidCredentials" },
          });
          throw new AuthenticationError("Invalid handle or password");
        }
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const session = await createSessionForUser(store, account.userId, deviceId, replicaId, platform, config, tenantId);
        recordLifecycleAudit({
          action: "auth.login",
          subject: account.userId,
          outcome: "allow",
          detail: { tenantId, platform },
        });

        sendAuthJson(response, 200, authSessionResponse(store, session, account));
      } catch (error) {
        sendErrorWithMetrics(response, error, "login_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/dev-login") {
      if (!config.demoAuthEnabled) {
        sendErrorWithMetrics(
          response,
          new AuthorizationError({
            allow: false,
            reason: "notAuthorizedForResource",
            publicMessage: "Demo authentication is disabled in this environment",
          }),
          "dev_login_disabled",
        );
        return;
      }
      try {
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const userId = requireString(body.userId, "userId");
        const tenantId = resolveAuthTenantId(body.tenantId);
        await ensureTenantAllowed(store, config, tenantId);
        authAttemptLimiter.check({
          route: "/auth/dev-login",
          tenantId,
          identity: userId,
          clientIp: clientIpFromRequest(request),
          limits,
        });
        if (!(await store.hasUser(tenantId, userId))) {
          await store.createAccountUser({
            tenantId,
            userId,
            handle: devHandleFromUserId(userId),
            displayName: userId,
            password: randomToken(32),
          });
          logger.info("frick.auth.dev_login_auto_create", {
            event: "frick.auth.dev_login_auto_create",
            tenantId,
            userId,
          });
        }
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const session = await createSessionForUser(store, userId, deviceId, replicaId, platform, config, tenantId);

        sendAuthJson(response, 200, {
          schemaHash: store.schema.hash,
          sessionToken: session.sessionToken,
          tenantId: session.tenantId,
          userId: session.userId,
          deviceId: session.deviceId,
          replicaId: session.replicaId,
          expiresAt: session.expiresAt,
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "dev_login_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      try {
        const token = sessionTokenFromRequest(request, url);
        if (!token) {
          throw new AuthenticationError("Missing session token");
        }
        const principal = await principalFromActiveSessionToken(store, token);
        if (principal instanceof Error) {
          throw principal;
        }
        await store.deleteSession(token);
        gateway.closeSession(token);
        recordLifecycleAudit({
          action: "auth.logout",
          subject: principal.userId,
          outcome: "allow",
          detail: { tenantId: principal.tenantId },
        });
        sendAuthJson(response, 200, { ok: true });
      } catch (error) {
        sendErrorWithMetrics(response, error, "logout_rejected");
      }
      return;
    }

    const principal = await protectedHttpPrincipal(request, url, store, config);
    if (principal instanceof Error) {
      sendErrorWithMetrics(response, principal, "unauthorized");
      return;
    }
    onPrincipal(principal);
    // Resolve per-tenant limits once per request; the tenant_settings table
    // is read in a single point query so this is cheap relative to the rest
    // of the handler. Shadowing the outer `limits` keeps the existing
    // `limits.maxXxx` call sites untouched.
    const tenantLimits = await resolveTenantLimits(principal.tenantId, store, limits);

    if (request.method === "POST" && url.pathname === "/analytics/events") {
      try {
        const body = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        const analyticsEvent = parseAnalyticsEventBody(body, request);
        const receipt = await platformEvents.publish({
          family: "analytics.user_event",
          name: analyticsEvent.name,
          source: "frick.analytics.ingest",
          tenantId: principal.tenantId,
          subjectId: principal.userId,
          ...(analyticsEvent.traceId !== undefined ? { traceId: analyticsEvent.traceId } : {}),
          ...(analyticsEvent.idempotencyKey !== undefined ? { idempotencyKey: analyticsEvent.idempotencyKey } : {}),
          ...(analyticsEvent.occurredAt !== undefined ? { occurredAt: analyticsEvent.occurredAt } : {}),
          payload: {
            properties: analyticsEvent.properties,
            context: analyticsEvent.context,
          },
          attributes: {
            ...analyticsEvent.attributes,
            deviceId: principal.deviceId,
            replicaId: principal.replicaId,
          },
        });
        sendJson(response, 202, {
          ok: true,
          eventId: receipt.id,
          sequence: receipt.sequence,
          acceptedAt: receipt.acceptedAt,
          duplicate: receipt.duplicate,
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "analytics_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/account/export") {
      try {
        // Self-service data export: the calling principal's OWN data only.
        // `buildAccountExportBase` scopes object reads to the principal's
        // tenant + userId and masks `secret`-classified fields; the optional
        // app hook layers product-specific data on top (and is responsible
        // for its own tenant/owner scoping). Never returns another
        // principal's or another tenant's data.
        const base = await buildAccountExportBase(store, principal);
        const bundle: AccountExport = { ...base };
        if (options.onAccountExport) {
          const appExtra = await options.onAccountExport(principal, base);
          if (appExtra !== undefined) {
            bundle.app = appExtra;
          }
        }
        recordLifecycleAudit({
          action: "account.export",
          subject: principal.userId,
          outcome: "allow",
          detail: { tenantId: principal.tenantId },
        });
        sendAuthJson(response, 200, bundle);
      } catch (error) {
        sendErrorWithMetrics(response, error, "account_export_rejected");
      }
      return;
    }

    if (
      url.pathname === "/account" &&
      (request.method === "DELETE" || request.method === "POST")
    ) {
      try {
        // Self-service account deletion: removes the CALLING principal's OWN
        // data only. `deleteAccountData` scopes every object delete to the
        // principal's tenant + userId (same owner-field convention the export
        // uses) and removes the principal's sessions + account row scoped to
        // (userId, tenantId). Never touches another principal's or another
        // tenant's data. `principal` was resolved before the deletion, so
        // concurrent in-flight requests that already resolved their own
        // principal are unaffected.
        const result = await deleteAccountData(store, principal);
        // App-specific cascade runs after the framework default has committed,
        // so the hook can read the returned counts and the framework's data is
        // already gone. The hook owns its own tenant/owner scoping.
        if (options.onAccountDelete) {
          await options.onAccountDelete(principal, result);
        }
        // Drop any live gateway connection bound to the caller's session so a
        // streaming client doesn't keep reading against a now-deleted account.
        const token = sessionTokenFromRequest(request, url);
        if (token) {
          gateway.closeSession(token);
        }
        // Audit the deletion on the shared admin-audit hash chain. Best-effort:
        // a single dropped audit row must not fail a legitimate deletion.
        try {
          store.adminAudit.record({
            adminTokenFingerprint,
            action: "account.delete",
            target: principal.userId,
            outcome: "allow",
            detail: JSON.stringify({
              tenantId: principal.tenantId,
              accountDeleted: result.accountDeleted,
              deletedSessions: result.deletedSessions,
              deletedObjects: result.deletedObjects,
            }),
          });
        } catch {
          // Audit failures are best-effort; the deletion itself has committed.
        }
        sendAuthJson(response, 200, {
          ok: true,
          tenantId: result.tenantId,
          userId: result.userId,
          deletedAt: result.deletedAt,
          accountDeleted: result.accountDeleted,
          deletedSessions: result.deletedSessions,
          deletedObjects: result.deletedObjects,
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "account_delete_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/objects") {
      const type = url.searchParams.get("type");
      if (!type) {
        sendJson(response, 400, {
          error: "type_required",
          message: "Query parameter type is required",
        });
        return;
      }
      sendJson(response, 200, {
        schemaHash: store.schema.hash,
        type,
        data: await store.listObjectsForUser(principal.tenantId, type, principal.userId, activeAppId),
      });
      return;
    }

    const objectWriteRoute = parseObjectWritePath(url);
    if (objectWriteRoute && request.method === "DELETE") {
      try {
        // Delete reuses the write authz decision — a principal that can
        // upsert this object can also remove it. Per-app policy hooks may
        // gate further (e.g. require admin role).
        await assertCanWriteObject(
          principal,
          objectWriteRoute.type,
          objectWriteRoute.id,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
          undefined,
          grantLookup,
        );
        const removed = await store.deleteObject(
          principal.tenantId,
          objectWriteRoute.type,
          objectWriteRoute.id,
          activeAppId,
        );
        // 204 either way — idempotent semantics keep retries safe. The
        // optional `existed` field tells the caller whether the row was
        // present when DELETE arrived.
        sendJson(response, removed ? 200 : 200, {
          schemaHash: store.schema.hash,
          existed: removed,
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "object_delete_rejected");
      }
      return;
    }
    if (objectWriteRoute && (request.method === "POST" || request.method === "PUT")) {
      try {
        const value = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        await assertCanWriteObject(
          principal,
          objectWriteRoute.type,
          objectWriteRoute.id,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
          value,
          grantLookup,
        );
        const mergePolicy = store.objectMergePolicy(objectWriteRoute.type);
        const expectedVersion = parseIfMatchHeader(request);
        const result = await store.upsertObjectWithPolicy({
          tenantId: principal.tenantId,
          appId: activeAppId,
          type: objectWriteRoute.type,
          id: objectWriteRoute.id,
          value,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        });
        const written = { id: objectWriteRoute.id, ...withoutEnvelopeId(value) };
        response.setHeader("ETag", String(result.nextVersion));
        sendJson(response, result.created ? 201 : 200, {
          schemaHash: store.schema.hash,
          object: written,
          version: result.nextVersion,
          previousVersion: result.previousVersion,
          mergePolicy,
        });
      } catch (error) {
        if (error instanceof FrickObjectVersionConflictError) {
          response.setHeader("ETag", String(error.actualVersion));
          const envelope = createFrickErrorEnvelope({
            code: "storage.conflict",
            message: error.message,
            requestId: "object_write_conflict",
            retryable: false,
            details: {
              tenantId: error.tenantId,
              objectType: error.objectType,
              objectId: error.objectId,
              ...(error.expectedVersion !== undefined
                ? { expectedVersion: error.expectedVersion }
                : {}),
              actualVersion: error.actualVersion,
              mergePolicy: store.objectMergePolicy(error.objectType),
            },
            schemaHash: store.schema.hash,
            schemaRevision: store.schema.schemaRevision,
          });
          metrics.counter("frick.http.errors.total", { code: "storage.conflict" }).inc();
          sendJson(response, 409, {
            error: envelope,
            code: envelope.code,
            message: envelope.message,
            requestId: envelope.requestId,
            retryable: envelope.retryable,
          });
          return;
        }
        sendErrorWithMetrics(response, error, "object_write_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/push/registrations") {
      try {
        const body = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        const deviceId = requireString(body.deviceId, "deviceId");
        const platform = requireString(body.platform, "platform");
        if (!isPushPlatform(platform)) {
          throw new Error(
            `platform must be one of apns, fcm, webPush, test (got "${platform}")`,
          );
        }
        const token = requireString(body.token, "token");
        if (platform === "webPush") {
          validateWebPushRegistrationToken(token);
        }
        const environment =
          typeof body.environment === "string" && body.environment.length > 0
            ? body.environment
            : "production";
        if (environment !== "production" && environment !== "sandbox") {
          throw new Error('environment must be "production" or "sandbox"');
        }
        const registration = await store.pushRegistrations.register({
          tenantId: principal.tenantId,
          userId: principal.userId,
          deviceId,
          platform,
          token,
          environment,
        });
        sendJson(response, 201, { registration });
      } catch (error) {
        sendErrorWithMetrics(response, error, "push_registration_rejected");
      }
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/push/registrations/")) {
      try {
        const registrationId = decodeURIComponent(
          url.pathname.slice("/push/registrations/".length),
        );
        if (!registrationId) {
          sendJson(response, 404, { error: "push_registration_not_found" });
          return;
        }
        const existing = await store.pushRegistrations.getById(registrationId, principal.tenantId);
        // 404 covers two cases — truly missing, or owned by another user in
        // the same tenant. We don't disclose existence across users.
        if (!existing || existing.userId !== principal.userId) {
          sendJson(response, 404, { error: "push_registration_not_found" });
          return;
        }
        await store.pushRegistrations.revoke(registrationId, principal.tenantId);
        response.writeHead(204);
        response.end();
      } catch (error) {
        sendErrorWithMetrics(response, error, "push_registration_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/share/invite") {
      try {
        const body = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        const recordType = requireString(body.recordType, "recordType");
        const recordId = requireString(body.recordId, "recordId");
        const permission = parseSharingPermission(body.permission);
        const ttlSeconds = resolveInvitationTtlSeconds(body.expiresInSeconds);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
        const invitation = await store.invitations.create({
          id: `inv-${randomToken(12)}`,
          tenantId: principal.tenantId,
          ownerUserId: principal.userId,
          recordType,
          recordId,
          permission,
          token: randomToken(32),
          createdAt: now.toISOString(),
          expiresAt,
        });
        sendJson(response, 201, { invitation });
      } catch (error) {
        sendErrorWithMetrics(response, error, "share_invite_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/share/accept") {
      try {
        const body = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        const token = requireString(body.token, "token");
        const now = new Date().toISOString();
        const outcome = await store.invitations.redeem({
          token,
          tenantId: principal.tenantId,
          redeemerUserId: principal.userId,
          now,
        });
        if (outcome.kind === "notFound") {
          sendErrorWithMetrics(
            response,
            new AuthorizationError({
              allow: false,
              reason: "notAuthorizedForResource",
              publicMessage: "Invitation token is invalid",
            }),
            "share_invite_invalid",
          );
          return;
        }
        if (outcome.kind === "tenantMismatch") {
          sendErrorWithMetrics(
            response,
            new AuthorizationError({
              allow: false,
              reason: "tenantMismatch",
              publicMessage: "Invitation belongs to a different tenant",
            }),
            "share_invite_tenant_mismatch",
          );
          return;
        }
        if (outcome.kind === "expired") {
          sendErrorWithMetrics(
            response,
            new AuthorizationError({
              allow: false,
              reason: "notAuthorizedForResource",
              publicMessage: "Invitation has expired",
            }),
            "share_invite_expired",
          );
          return;
        }
        if (outcome.kind === "alreadyRedeemed") {
          sendErrorWithMetrics(
            response,
            new AuthorizationError({
              allow: false,
              reason: "notAuthorizedForResource",
              publicMessage: "Invitation has already been redeemed",
            }),
            "share_invite_already_redeemed",
          );
          return;
        }
        const invitation = outcome.invitation;
        // Owner accepting their own invitation is rejected — it's a no-op
        // that would only ever happen by mistake and pollutes the grants
        // table with self-grants.
        if (invitation.ownerUserId === principal.userId) {
          sendErrorWithMetrics(
            response,
            new AuthorizationError({
              allow: false,
              reason: "notAuthorizedForResource",
              publicMessage: "Owners cannot accept their own invitations",
            }),
            "share_invite_self_accept",
          );
          return;
        }
        const grant = await store.grants.create({
          id: `grant-${randomToken(12)}`,
          tenantId: invitation.tenantId,
          ownerUserId: invitation.ownerUserId,
          recordType: invitation.recordType,
          recordId: invitation.recordId,
          granteeUserId: principal.userId,
          permission: invitation.permission,
          createdAt: now,
        });
        sendJson(response, 201, { grant });
      } catch (error) {
        sendErrorWithMetrics(response, error, "share_accept_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/share/grants") {
      try {
        const recordType = url.searchParams.get("recordType") ?? undefined;
        const recordId = url.searchParams.get("recordId") ?? undefined;
        const includeRevoked = url.searchParams.get("includeRevoked") === "true";
        const grants = await store.grants.list({
          tenantId: principal.tenantId,
          principalUserId: principal.userId,
          ...(recordType !== undefined ? { recordType } : {}),
          ...(recordId !== undefined ? { recordId } : {}),
          includeRevoked,
        });
        sendJson(response, 200, { grants });
      } catch (error) {
        sendErrorWithMetrics(response, error, "share_grants_list_rejected");
      }
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/share/grants/")) {
      try {
        const grantId = decodeURIComponent(url.pathname.slice("/share/grants/".length));
        if (!grantId) {
          sendJson(response, 404, { error: "grant_not_found" });
          return;
        }
        const existing = await store.grants.getById(principal.tenantId, grantId);
        // Only the owner that issued the invitation can revoke via DELETE.
        // Grantees who want to drop their own access use the dedicated
        // POST /share/grants/:id/leave route below; we keep DELETE
        // owner-only so revoke and self-revocation stay distinct verbs.
        if (!existing || existing.ownerUserId !== principal.userId) {
          sendJson(response, 404, { error: "grant_not_found" });
          return;
        }
        const now = new Date().toISOString();
        const grant = await store.grants.revoke({
          tenantId: principal.tenantId,
          id: grantId,
          now,
        });
        sendJson(response, 200, { grant });
      } catch (error) {
        sendErrorWithMetrics(response, error, "share_grant_revoke_rejected");
      }
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/share/grants/") &&
      url.pathname.endsWith("/leave")
    ) {
      try {
        const encodedId = url.pathname.slice(
          "/share/grants/".length,
          url.pathname.length - "/leave".length,
        );
        const grantId = decodeURIComponent(encodedId);
        if (!grantId) {
          sendJson(response, 404, { error: "grant_not_found" });
          return;
        }
        const existing = await store.grants.getById(principal.tenantId, grantId);
        // Self-revocation ("leave share"): only the grantee may leave their
        // own grant. Owners revoke via DELETE /share/grants/:id. A caller
        // who is not the grantee (including the owner) gets a 404 so the
        // route never leaks the existence of grants the caller does not
        // hold. Tenant isolation is enforced by the tenant-scoped lookup.
        if (!existing || existing.granteeUserId !== principal.userId) {
          sendJson(response, 404, { error: "grant_not_found" });
          return;
        }
        const now = new Date().toISOString();
        const grant = await store.grants.revoke({
          tenantId: principal.tenantId,
          id: grantId,
          now,
        });
        sendJson(response, 200, { grant });
      } catch (error) {
        sendErrorWithMetrics(response, error, "share_grant_leave_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/projections") {
      sendJson(response, 200, {
        schemaHash: store.schema.hash,
        projections: store.projections.list().map((projection) => ({
          name: projection.name,
          sources: projection.sources,
        })),
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/projections/")) {
      const name = decodeURIComponent(url.pathname.slice("/projections/".length));
      const projection = store.projections.get(name);
      if (!projection) {
        sendErrorWithMetrics(response, new ProjectionNotFoundError(name), "projection_not_found");
        return;
      }
      if (!projection.handler.read) {
        // The framework can't expose a generic read for projections that
        // don't opt in — 405 keeps the path reserved while signalling that
        // the projection itself is registered.
        sendJson(response, 405, {
          error: "method_not_allowed",
          message: `Projection "${name}" does not implement read`,
        });
        return;
      }
      try {
        const query: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          query[key] = value;
        });
        await assertCanSubscribe(
          principal,
          "projection",
          name,
          query.key,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
          cascadeGrantLookup,
        );
        const ctx: FrickProjectionContext = {
          tenantId: principal.tenantId,
          store,
          logger,
        };
        const data = projection.handler.read(ctx, query);
        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          projection: name,
          data,
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "projection_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/search") {
      try {
        const body = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        const indexName = requireString(body.index, "index");
        const q = requireString(body.q, "q");
        assertSearchTextWithinLimit(q, tenantLimits.maxSearchQueryBytes);
        const def = store.searchIndexes.get(indexName);
        if (!def) {
          throw new SearchIndexNotFoundError(indexName);
        }
        const filter = parseSearchFilter(body.filter, tenantLimits);
        const rawLimit = body.limit;
        let limit = DEFAULT_SEARCH_LIMIT;
        if (rawLimit !== undefined) {
          const parsed = Number(rawLimit);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error("limit must be a positive number");
          }
          limit = Math.min(MAX_SEARCH_LIMIT, Math.floor(parsed));
        }
        assertCanQuerySearch(
          principal,
          indexName,
          def,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
        );
        // Authz: tenant scoping happens at the adapter call; source-level
        // visibility is filtered below before any hit leaves the server.
        let result: FrickSearchResult;
        try {
          result = await store.searchAdapter.query(principal.tenantId, {
            index: indexName,
            q,
            ...(filter !== undefined ? { filter } : {}),
            limit: principal.scope === "admin" ? limit : MAX_SEARCH_LIMIT,
          });
        } catch {
          throw new InvalidSearchQueryError();
        }
        const authorizedResult = await filterSearchResultForPrincipal(
          result,
          def,
          principal,
          store,
          policyHooks,
          grantLookup,
          cascadeGrantLookup,
        );
        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          index: indexName,
          hits: authorizedResult.hits.slice(0, limit),
          total: authorizedResult.total,
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "search_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/blobs") {
      try {
        const requestedOwnerId =
          url.searchParams.get("ownerId") ?? (principal.scope === "admin" ? undefined : principal.userId);
        if (principal.scope !== "admin" && requestedOwnerId !== undefined) {
          await assertCanReadBlob(principal, requestedOwnerId, policyHooks);
        }
        const responseBody: Record<string, unknown> = {
          schemaHash: store.schema.hash,
          data: await store.blobs.list(principal.tenantId, requestedOwnerId, activeAppId),
        };
        // Quota-aware listing (FR-56): when scoped to a single owner, report
        // that owner's current usage and the effective per-principal cap.
        // `quotaBytes` is null when no quota is configured, so clients can
        // distinguish "unlimited" from a finite limit.
        if (requestedOwnerId !== undefined) {
          const quota = tenantLimits.maxBlobBytesPerPrincipal;
          const quotaConfigured =
            Number.isFinite(quota) && quota < Number.MAX_SAFE_INTEGER;
          responseBody.usage = {
            ownerId: requestedOwnerId,
            usedBytes: await store.blobs.totalBytesForOwner(
              principal.tenantId,
              requestedOwnerId,
              activeAppId,
            ),
            quotaBytes: quotaConfigured ? quota : null,
          };
        }
        sendJson(response, 200, responseBody);
      } catch (error) {
        sendErrorWithMetrics(response, error, "blob_list_rejected");
      }
      return;
    }

    const blobContentId = parseBlobContentPath(url);
    if (blobContentId && request.method === "PUT") {
      try {
        const content = await readRawBody(request, tenantLimits.maxBlobBytes, "maxBlobBytes");
        const metadata = await store.blobs.read(principal.tenantId, blobContentId, activeAppId);
        const contentHash = sha256ContentHash(content);
        let responseStatus = 200;
        let responseContentHash = metadata?.contentHash ?? contentHash;
        let resolvedOwnerId: string;
        let resolvedMimeType: string;

        if (metadata) {
          await assertBlobOwnership(principal, metadata.ownerId, policyHooks);
          validateBlobContent(blobContentId, metadata.byteLength, metadata.contentHash, content, contentHash);
          resolvedOwnerId = metadata.ownerId;
          resolvedMimeType = metadata.mimeType;
        } else {
          responseStatus = 201;
          const ownerId = requireString(
            url.searchParams.get("ownerId") ?? headerValue(request, "x-frick-owner-id"),
            "ownerId",
          );
          await assertBlobOwnership(principal, ownerId, policyHooks);
          resolvedOwnerId = ownerId;
          resolvedMimeType = inferMimeType(request);
        }

        // Synchronous validators run against the resolved (owner, mime,
        // size) tuple before any row is created or content is written. A
        // rejection here surfaces as 415 with envelope code
        // `blob.unsupportedContentType` and never leaves an
        // upload-in-progress trail in the store.
        const matchingProcessors = store.blobProcessors.matching(
          resolvedMimeType,
          content.byteLength,
        );
        const preview = content.subarray(
          0,
          Math.min(content.byteLength, 4 * 1024),
        );
        for (const processor of matchingProcessors) {
          if (!processor.validate) continue;
          const verdict = await processor.validate({
            tenantId: principal.tenantId,
            blobId: blobContentId,
            ownerId: resolvedOwnerId,
            mimeType: resolvedMimeType,
            byteLength: content.byteLength,
            preview,
            store,
            logger,
          });
          if (!verdict.ok) {
            throw new BlobValidationRejectedError(processor.id, verdict.reason);
          }
        }

        // Per-principal blob quota (FR-56). Compute the owner's projected total
        // bytes after this upload: their current usage, minus the bytes of the
        // blob being overwritten (so a same-id re-upload isn't double-counted),
        // plus the incoming bytes. Reject before any row or bytes are written
        // when the projection would exceed the configured cap. Scoped to
        // `(tenantId, resolvedOwnerId)` and driver-independent. The default cap
        // is effectively unlimited, so this is a no-op unless configured.
        const quota = tenantLimits.maxBlobBytesPerPrincipal;
        if (Number.isFinite(quota) && quota < Number.MAX_SAFE_INTEGER) {
          const currentBytes = await store.blobs.totalBytesForOwner(
            principal.tenantId,
            resolvedOwnerId,
            activeAppId,
          );
          const existingBytes = metadata ? metadata.byteLength : 0;
          const projected = currentBytes - existingBytes + content.byteLength;
          if (projected > quota) {
            throw new FrickLimitError({
              limit: "maxBlobBytesPerPrincipal",
              actualValue: projected,
              configuredMax: quota,
              message: `blob quota exceeded for owner ${resolvedOwnerId}: ${projected} > ${quota}`,
            });
          }
        }

        if (!metadata) {
          const createdMetadata = {
            blobId: blobContentId,
            ownerId: resolvedOwnerId,
            contentHash,
            byteLength: content.byteLength,
            mimeType: resolvedMimeType,
            createdAt: new Date().toISOString(),
          };
          // Awaited so the metadata row is committed before writeContent's
          // FK (blob_content.blob_id → blob_metadata.blob_id) is checked. The
          // cross-app guard added in FR-153 makes create() do an extra async
          // round-trip, so the prior fire-and-forget would race the FK.
          await store.blobs.create(principal.tenantId, createdMetadata, activeAppId);
          responseContentHash = createdMetadata.contentHash;
        }

        await store.blobs.writeContent(principal.tenantId, blobContentId, content, activeAppId);

        // Enqueue async post-processing jobs. Each matching processor with a
        // `process` hook gets its own job — apps that want fan-in across
        // processors can do that inside their handlers.
        for (const processor of matchingProcessors) {
          if (!processor.process) continue;
          await store.jobs.enqueue({
            tenantId: principal.tenantId,
            appId: activeAppId,
            jobType: BLOB_PROCESS_JOB_TYPE,
            payload: encodeBlobProcessPayload({
              blobId: blobContentId,
              processorId: processor.id,
            }),
            idempotencyKey: `${blobContentId}:${processor.id}:${contentHash}`,
          });
        }

        sendJson(response, responseStatus, {
          ok: true,
          blobId: blobContentId,
          byteLength: content.byteLength,
          contentHash: responseContentHash,
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "blob_content_rejected");
      }
      return;
    }

    if (blobContentId && request.method === "GET") {
      try {
        const metadata = await store.blobs.read(principal.tenantId, blobContentId, activeAppId);
        const content = await store.blobs.readContent(principal.tenantId, blobContentId, activeAppId);
        if (!metadata || !content) {
          sendJson(response, 404, { error: "blob_content_not_found" });
          return;
        }
        await assertCanReadBlob(
          principal,
          metadata.ownerId,
          policyHooks,
          metadata.blobId,
          cascadeGrantLookup,
        );

        response.writeHead(200, {
          "content-type": metadata.mimeType,
          "content-length": content.byteLength,
          "x-frick-blob-id": metadata.blobId,
          "x-frick-content-hash": metadata.contentHash,
        });
        response.end(Buffer.from(content));
      } catch (error) {
        sendErrorWithMetrics(response, error, "blob_content_rejected");
      }
      return;
    }

    // Derivative content: GET /blobs/:blobId/derivatives/:derivativeId/content
    const derivativeContentRoute = parseDerivativeContentPath(url);
    if (derivativeContentRoute && request.method === "GET") {
      try {
        const metadata = await store.blobs.read(
          principal.tenantId,
          derivativeContentRoute.blobId,
          activeAppId,
        );
        if (!metadata) {
          // Cross-tenant fetches and unknown ids share 404 semantics — we
          // never leak the existence of a blob in another tenant.
          sendJson(response, 404, { error: "blob_not_found" });
          return;
        }
        await assertCanReadBlob(
          principal,
          metadata.ownerId,
          policyHooks,
          metadata.blobId,
          cascadeGrantLookup,
        );
        const result = await store.blobDerivatives.read(
          derivativeContentRoute.blobId,
          derivativeContentRoute.derivativeId,
          principal.tenantId,
        );
        if (!result) {
          sendJson(response, 404, { error: "blob_derivative_not_found" });
          return;
        }
        response.writeHead(200, {
          "content-type": result.row.mimeType,
          "content-length": result.bytes.byteLength,
          "x-frick-blob-id": metadata.blobId,
          "x-frick-content-hash": result.row.contentHash,
          etag: `"${result.row.contentHash}"`,
        });
        response.end(result.bytes);
      } catch (error) {
        sendErrorWithMetrics(response, error, "blob_derivative_rejected");
      }
      return;
    }

    // Derivative list: GET /blobs/:blobId/derivatives
    const derivativeListBlobId = parseDerivativeListPath(url);
    if (derivativeListBlobId && request.method === "GET") {
      try {
        const metadata = await store.blobs.read(principal.tenantId, derivativeListBlobId, activeAppId);
        if (!metadata) {
          sendJson(response, 404, { error: "blob_not_found" });
          return;
        }
        await assertCanReadBlob(
          principal,
          metadata.ownerId,
          policyHooks,
          metadata.blobId,
          cascadeGrantLookup,
        );
        const derivatives = await store.blobDerivatives.listForParent(
          derivativeListBlobId,
          principal.tenantId,
        );
        sendJson(response, 200, { derivatives });
      } catch (error) {
        sendErrorWithMetrics(response, error, "blob_derivative_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/blobs/")) {
      try {
        const blobId = decodeURIComponent(url.pathname.slice("/blobs/".length));
        const metadata = blobId ? await store.blobs.read(principal.tenantId, blobId, activeAppId) : undefined;
        if (!metadata) {
          sendJson(response, 404, { error: "blob_not_found" });
          return;
        }
        await assertCanReadBlob(
          principal,
          metadata.ownerId,
          policyHooks,
          metadata.blobId,
          cascadeGrantLookup,
        );
        sendJson(response, 200, metadata);
      } catch (error) {
        sendErrorWithMetrics(response, error, "blob_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/blobs") {
      try {
        const body = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        const ownerId = requireString(body.ownerId, "ownerId");
        await assertBlobOwnership(principal, ownerId, policyHooks);
        await store.blobs.create(
          principal.tenantId,
          {
            blobId: requireString(body.blobId, "blobId"),
            ownerId,
            contentHash: requireString(body.contentHash, "contentHash"),
            byteLength: requireNumber(body.byteLength, "byteLength"),
            mimeType: requireString(body.mimeType, "mimeType"),
            ...(typeof body.storageKey === "string" ? { storageKey: body.storageKey } : {}),
          },
          activeAppId,
        );
        sendJson(response, 201, { ok: true, blobId: body.blobId });
      } catch (error) {
        sendErrorWithMetrics(response, error, "blob_rejected");
      }
      return;
    }

    const signalRoute = parseSignalPath(url);
    if (signalRoute && request.method === "POST") {
      try {
        await assertCanSignal(
          principal,
          signalRoute.name,
          signalRoute.key,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
          // Gate WebRTC call signals on call membership over HTTP too
          // (calls-signal-1) — the same relay the WS gateway gates.
          callControlPlane
            ? {
                signalName: callControlPlane.webrtcSignalName,
                isCallMember: (callId, userId) =>
                  callControlPlane.isSignalMember(
                    principal.tenantId,
                    callId,
                    userId,
                    activeAppId,
                  ),
              }
            : undefined,
        );
        const value = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        await store.enqueueSignal(
          principal.tenantId,
          signalRoute.name,
          signalRoute.key,
          value,
          undefined,
          activeAppId,
        );
        gateway.publishSignal(signalRoute.name, signalRoute.key, value, principal.tenantId, activeAppId);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendErrorWithMetrics(response, error, "signal_rejected");
      }
      return;
    }

    if (signalRoute && request.method === "GET") {
      try {
        await assertCanReadSignal(
          principal,
          signalRoute.name,
          signalRoute.key,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
          callControlPlane
            ? {
                signalName: callControlPlane.webrtcSignalName,
                isCallMember: (callId, userId) =>
                  callControlPlane.isSignalMember(
                    principal.tenantId,
                    callId,
                    userId,
                    activeAppId,
                  ),
              }
            : undefined,
        );
        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          name: signalRoute.name,
          key: signalRoute.key,
          data: await store.drainSignals(principal.tenantId, signalRoute.name, signalRoute.key, activeAppId),
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "signal_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/streams/")) {
      const parts = url.pathname.split("/").map(decodeURIComponent);
      const stream = parts[2];
      const key = parts[3];
      if (!stream || !key) {
        sendJson(response, 400, { error: "stream_and_key_required" });
        return;
      }
      try {
        await assertCanSubscribe(
          principal,
          "stream",
          stream,
          key,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
          cascadeGrantLookup,
        );
        // FR-116: cheap cursor head probe — MAX(sequence)+COUNT, no payloads.
        if (parts[4] === "cursor") {
          sendJson(response, 200, await store.streamHead(principal.tenantId, stream, key));
          return;
        }
        // FR-116: forward cursor read. `?since=<seq>` returns the events whose
        // sequence is strictly greater than the cursor, ascending, paginated
        // by `?limit=`. A non-numeric / negative cursor is a client error.
        const sinceParam = url.searchParams.get("since");
        if (sinceParam !== null) {
          const since = Number(sinceParam);
          if (!Number.isInteger(since) || since < 0) {
            throw new InvalidStreamCursorError(sinceParam);
          }
          const limit = parseStreamPageLimit(
            url.searchParams.get("limit"),
            tenantLimits.maxStreamPageSize,
            tenantLimits.maxStreamPageSize,
          );
          const events = await store.readEvents(principal.tenantId, stream, key, since, limit, activeAppId);
          sendJson(response, 200, { events });
          return;
        }
        const after = Number(url.searchParams.get("after") ?? "0");
        const beforeParam = url.searchParams.get("before");
        const limitParam = url.searchParams.get("limit");
        let events;
        let cursor = Number.isFinite(after) ? after : 0;
        let hasMore = false;
        if (beforeParam !== null) {
          // Backwards page for scrollback. `before` is exclusive; `limit`
          // defaults to 50 and is clamped server-side to [1, 500].
          const before = Number(beforeParam);
          const limit = parseStreamPageLimit(limitParam, 50, Math.min(500, tenantLimits.maxStreamPageSize));
          events = await store.readEventsBefore(
            principal.tenantId,
            stream,
            key,
            Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER,
            limit,
            activeAppId,
          );
          cursor = events.at(-1)?.sequence ?? cursor;
        } else {
          const limit = parseStreamPageLimit(
            limitParam,
            tenantLimits.maxStreamPageSize,
            tenantLimits.maxStreamPageSize,
          );
          const page = await store.readEvents(principal.tenantId, stream, key, cursor, limit + 1, activeAppId);
          hasMore = page.length > limit;
          events = page.slice(0, limit);
          cursor = events.at(-1)?.sequence ?? cursor;
        }
        if (parts[4] === "events") {
          if (sse.connectionCount >= tenantLimits.maxSseConnections) {
            throw new FrickLimitError({
              limit: "maxSseConnections",
              actualValue: sse.connectionCount + 1,
              configuredMax: tenantLimits.maxSseConnections,
            });
          }
          sse.open(response, {
            tenantId: principal.tenantId,
            stream,
            key,
            events,
            cursor,
            hasMore,
          });
          return;
        }
        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          stream,
          key,
          data: events,
          cursor,
          hasMore,
        });
      } catch (error) {
        sendErrorWithMetrics(response, error, "stream_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/append") {
      try {
        const body = await readJsonBody(request, tenantLimits.maxHttpBodyBytes);
        const stream = requireString(body.stream, "stream");
        const key = requireString(body.key, "key");
        const event = requireString(body.event, "event");
        const payload = requireRecord(body.payload, "payload");
        assertPayloadWithinLimit(payload, tenantLimits.maxStreamAppendPayloadBytes);
        await assertCanAppend(
          principal,
          stream,
          key,
          tenantMembershipReader(store, principal.tenantId),
          event,
          payload,
          policyHooks,
        );
        const result = await store.appendEvent({
          tenantId: principal.tenantId,
          appId: activeAppId,
          requestId: requireString(body.requestId, "requestId"),
          replicaId: principal.replicaId,
          stream,
          streamId: key,
          event,
          payload,
        });
        // No inline broadcast: `store.appendEvent` fires the store write
        // listener on a created event, which the sync gateway fans out to WS
        // subscribers, the SSE bridge, and the cluster bus through its single
        // funnel (FR-114). Broadcasting here too would double-fire.
        sendJson(response, 200, { ok: true, event: result.event });
      } catch (error) {
        sendErrorWithMetrics(response, error, "append_rejected");
      }
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  }

  async function listen(): Promise<void> {
    // Bring the storage schema up before accepting traffic. No-op on SQLite
    // (initialized synchronously in the store constructor); runs the Postgres
    // migration runner on the postgres driver.
    await store.initialize();
    await startTelemetry();
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          server.off("error", onError);
          wss.off("error", onError);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        server.once("error", onError);
        wss.once("error", onError);
        server.listen(port, host, () => {
          cleanup();
          const address = server.address();
          const boundPort = address && typeof address !== "string" ? address.port : port;
          logger.info("frick.server.listen", {
            event: "frick.server.listen",
            schemaId: store.schema.schemaId,
            schemaRevision: store.schema.schemaRevision,
            schemaHash: store.schema.hash,
            env: config.env,
            host,
            port: boundPort,
            publicUrl: config.publicUrl,
            demoAuthEnabled: config.demoAuthEnabled,
            dbPath: options.dbPath ?? process.env.FRICK_DB_PATH ?? config.dbPath,
            inspectionEnabled: config.inspectionEnabled,
          });
          resolve();
        });
      });
    } catch (err) {
      await shutdownTelemetry();
      throw err;
    }
  }

  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    recurringScheduler.stop();
    // Stop the job worker first so any in-flight handlers finish (or time
    // out) before we tear down the HTTP listener and database. Worker
    // handlers depend on `store`, which is closed below.
    const workerStop = worker.stop();
    const analyticsConsumerStop = analyticsConsumer.stop();
    sse.closeAll();
    gateway.close();
    // Close any adapters that hold long-lived resources (e.g. APNs HTTP/2
    // sessions). Best-effort: log and continue if an adapter throws — a
    // misbehaving adapter must not block the rest of shutdown.
    const adapterCloses = pushRegistry.list().map(async (adapter) => {
      const maybeClose = (adapter as { close?: () => Promise<void> }).close;
      if (typeof maybeClose !== "function") return;
      try {
        await maybeClose.call(adapter);
      } catch (err) {
        logger.warn("frick.push.adapter_close_failed", {
          event: "frick.push.adapter_close_failed",
          platform: adapter.platform,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    const platformEventsClose = async () => {
      if (platformEvents === store.platformEvents) return;
      try {
        await platformEvents.close();
      } catch (err) {
        logger.warn("frick.platform_events.close_failed", {
          event: "frick.platform_events.close_failed",
          adapter: platformEvents.adapter,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    closePromise = (async () => {
      await workerStop;
      await analyticsConsumerStop;
      await Promise.all(adapterCloses);
    })().then(() => new Promise<void>((resolve, reject) => {
      // Stop accepting new HTTP connections; allow in-flight requests to
      // drain. server.close()'s callback fires only once every connection
      // is idle, so this naturally waits for in-flight requests. We layer a
      // best-effort drain timer on top so a stuck request can't pin the
      // process forever.
      const drainTimer = setTimeout(() => {
        // After timeout, forcibly close any keep-alive sockets and let the
        // server.close callback resolve. server.closeAllConnections is
        // available on Node 18.2+.
        const maybeCloseAll = (server as unknown as { closeAllConnections?: () => void })
          .closeAllConnections;
        if (typeof maybeCloseAll === "function") maybeCloseAll.call(server);
      }, shutdownTimeoutMs);

      server.close((serverError) => {
        clearTimeout(drainTimer);
        wss.close((wsError) => {
          void (async () => {
            await platformEventsClose();
            try {
              store.close();
            } catch {
              // Already closed — fine during shutdown.
            }
            await shutdownTelemetry();
            logger.info("frick.server.closed", { event: "frick.server.closed" });
            const error = serverError ?? wsError;
            if (error && !/Server is not running|not running/i.test(error.message)) {
              reject(error);
            } else {
              resolve();
            }
          })().catch(reject);
        });
      });
    }));
    return closePromise;
  }

  return {
    port,
    server,
    store,
    extensions,
    config,
    logger,
    startedAt,
    listen,
    close,
    notifications: notificationRouter,
    pushRegistry,
    platformEvents,
    analyticsConsumer,
    telemetry,
    apps: appRegistry,
    gateway,
    recurring: recurringRegistry,
    /** Derived `http://host:port` origin. Resolved after `listen()` binds. */
    get httpUrl(): string {
      const address = server.address();
      if (address && typeof address === "object") {
        return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`;
      }
      return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    },
  };
}

async function safeListAppliedMigrations(store: FrickStore) {
  try {
    return await store.listAppliedMigrations();
  } catch {
    return undefined;
  }
}

function resolveConfig(input: FrickConfig | FrickConfigOverrides | undefined): FrickConfig {
  if (!input) {
    return loadFrickConfig();
  }
  if (isFrickConfig(input)) {
    return input;
  }
  return loadFrickConfig(input);
}

function isFrickConfig(value: FrickConfig | FrickConfigOverrides): value is FrickConfig {
  const v = value as FrickConfig;
  return (
    typeof v.env === "string" &&
    typeof v.demoAuthEnabled === "boolean" &&
    typeof v.sessionTtlSeconds === "number" &&
    typeof v.host === "string" &&
    typeof v.port === "number" &&
    typeof v.dbDriver === "string" &&
    typeof v.dbPath === "string" &&
    typeof v.blobDriver === "string" &&
    typeof v.blobStoragePath === "string" &&
    typeof v.logLevel === "string" &&
    typeof v.otelEnabled === "boolean" &&
    typeof v.otelServiceName === "string" &&
    (typeof v.otelExporterOtlpEndpoint === "string" || v.otelExporterOtlpEndpoint === undefined) &&
    (typeof v.otelExporterOtlpTracesEndpoint === "string" ||
      v.otelExporterOtlpTracesEndpoint === undefined) &&
    (typeof v.otelExporterOtlpMetricsEndpoint === "string" ||
      v.otelExporterOtlpMetricsEndpoint === undefined) &&
    typeof v.otelMetricExportIntervalMs === "number" &&
    typeof v.platformEventsDriver === "string" &&
    typeof v.platformEventsTopic === "string" &&
    Array.isArray(v.platformEventsKafkaBrokers) &&
    typeof v.platformEventsRetentionMs === "number" &&
    typeof v.platformEventsMaxRows === "number" &&
    typeof v.idempotencyKeyRetentionMs === "number" &&
    typeof v.devtoolsEventsRetentionMs === "number" &&
    typeof v.expiredSessionRetentionGraceMs === "number" &&
    typeof v.idempotencyReplayWindowMs === "number"
  );
}

export function defaultDatabasePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/frick.sqlite");
}

/**
 * Decide whether a request's `Origin` header is permitted by the configured
 * allowlist. Same-origin / server-to-server requests omit `Origin` entirely
 * and are always allowed — browsers, not the server, enforce CORS for those.
 *
 * Allowlist entries may be the allow-all wildcard `*`, an exact origin, or a
 * `<scheme>://*.<host>` subdomain wildcard. See `isOriginInAllowlist` in
 * `config.ts` and `docs/threat-model.md` for the matching rules.
 */
function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return true;
  return isOriginInAllowlist(origin, allowedOrigins);
}

class CorsOriginRejectedError extends Error {
  readonly reason = "originNotAllowed";
  constructor(message: string) {
    super(message);
    this.name = "CorsOriginRejectedError";
  }
}

interface AuthAttemptLimitInput {
  /**
   * Logical route bucket. The built-in password routes use their pathname;
   * the identity-provider verify + email password-reset routes (FR-29) pass
   * their own stable labels (e.g. `apple-verify`, `oidc-verify:<id>`,
   * `forgot-password`, `reset-password`) so each shares the same per-window
   * ceiling without colliding across routes.
   */
  route: string;
  tenantId: string;
  identity?: string;
  clientIp: string;
  limits: FrickLimits;
}

class FixedWindowAuthAttemptLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastPruneAt = 0;

  check(input: AuthAttemptLimitInput): void {
    const max = Math.max(1, Math.floor(input.limits.maxAuthAttemptsPerWindow));
    const windowMs = Math.max(1, Math.floor(input.limits.authRateLimitWindowMs));
    const now = Date.now();
    this.pruneExpired(now, windowMs);
    const key = authAttemptKey(input);
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    const nextCount = current.count + 1;
    current.count = nextCount;
    if (nextCount > max) {
      throw new FrickLimitError({
        limit: "maxAuthAttemptsPerWindow",
        actualValue: nextCount,
        configuredMax: max,
      });
    }
  }

  private pruneExpired(now: number, windowMs: number): void {
    if (now - this.lastPruneAt < windowMs) {
      return;
    }
    this.lastPruneAt = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

function authAttemptKey(input: AuthAttemptLimitInput): string {
  const actor = input.identity?.trim().toLowerCase() || `ip:${input.clientIp}`;
  return `${input.route}\0${input.tenantId}\0${actor}`;
}

function clientIpFromRequest(request: http.IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

class AdminAuditWriteError extends Error {
  readonly reason = "adminAuditWriteFailed";
  constructor(cause: unknown) {
    super(`Admin audit write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AdminAuditWriteError";
  }
}

/**
 * Thrown by `/projections/:name` and the admin rebuild route when the
 * requested projection isn't registered. Maps to 404 with
 * `details.reason = "projectionNotFound"`.
 */
/**
 * Thrown when a registered blob processor's `validate(...)` hook returns
 * `ok: false`. Maps to 415 with envelope code
 * `blob.unsupportedContentType` and `details.processorId` / `details.reason`.
 */
class BlobValidationRejectedError extends Error {
  readonly reason = "blobValidationRejected";
  constructor(readonly processorId: string, readonly rejectionReason?: string) {
    super(
      rejectionReason
        ? `Blob rejected by processor ${processorId}: ${rejectionReason}`
        : `Blob rejected by processor ${processorId}`,
    );
    this.name = "BlobValidationRejectedError";
  }
}

class ProjectionNotFoundError extends Error {
  readonly reason = "projectionNotFound";
  readonly projection: string;
  constructor(name: string) {
    super(`Projection "${name}" not found`);
    this.name = "ProjectionNotFoundError";
    this.projection = name;
  }
}

/**
 * Register app-provided projections at boot. Each projection's declared
 * sources must reference a real object/stream type in the active schema —
 * otherwise we fail fast with {@link FrickConfigError} so a typo'd source
 * surfaces at startup rather than silently never matching a write. Duplicate
 * names are rejected by the registry itself.
 */
function registerProjections(
  registry: FrickProjectionRegistry,
  projections: readonly FrickProjection[],
  schema: FrickSchema,
): void {
  const objectTypes = new Set(schema.objects.map((object) => object.name));
  const streamTypes = new Set(schema.streams.map((stream) => stream.name));
  for (const projection of projections) {
    for (const source of projection.sources) {
      const known = source.kind === "object" ? objectTypes : streamTypes;
      if (!known.has(source.type)) {
        throw new FrickConfigError(
          `Projection "${projection.name}" declares an unknown ${source.kind} source "${source.type}". ` +
            `It must reference a ${source.kind} type defined in the active schema "${schema.schemaId}".`,
        );
      }
    }
    registry.register(projection);
  }
}

/**
 * Thrown by `POST /search` and the admin rebuild route when the requested
 * search index is not registered. Maps to 404 with
 * `details.reason = "searchIndexNotFound"`.
 */
class SearchIndexNotFoundError extends Error {
  readonly reason = "searchIndexNotFound";
  readonly index: string;
  constructor(name: string) {
    super(`Search index "${name}" not found`);
    this.name = "SearchIndexNotFoundError";
    this.index = name;
  }
}

class SearchIndexRebuildUnsupportedError extends Error {
  readonly reason = "projectionSourceUnsupported";
  readonly index: string;
  constructor(name: string) {
    super(`Search index "${name}" cannot be rebuilt from a generic projection source`);
    this.name = "SearchIndexRebuildUnsupportedError";
    this.index = name;
  }
}

/**
 * Thrown by `POST /search` when a search adapter rejects the query syntax.
 * The wrapped adapter error is deliberately not exposed because SQLite FTS
 * errors can include implementation-specific parser details.
 */
class InvalidSearchQueryError extends Error {
  readonly reason = "invalidSearchQuery";
  constructor() {
    super("Invalid search query");
    this.name = "InvalidSearchQueryError";
  }
}

/**
 * A `?since=` cursor on a stream read was not a non-negative integer (FR-116).
 * Surfaces as a 400 `stream.invalidCursor`.
 */
class InvalidStreamCursorError extends Error {
  readonly reason = "invalidCursor";
  constructor(value: string) {
    super(`Invalid stream cursor: ${value}`);
    this.name = "InvalidStreamCursorError";
  }
}

/**
 * Validate body.tenantId at an auth boundary. Returns the normalized tenant
 * id. If the caller supplied a `tenantId` field at all (even empty string),
 * it must match {@link validateTenantId}'s strict regex; if omitted, the
 * default tenant is used.
 */
function resolveAuthTenantId(rawValue: unknown): string {
  if (rawValue === undefined || rawValue === null) {
    return DEFAULT_TENANT_ID;
  }
  if (typeof rawValue !== "string") {
    throw new TenantIdValidationError("tenantId must be a string");
  }
  validateTenantId(rawValue);
  return normalizeTenantId(rawValue);
}

function setCors(
  response: http.ServerResponse,
  requestOrigin: string | undefined,
  allowedOrigins: readonly string[],
  originAllowed: boolean,
  schemaHash: string,
): void {
  response.setHeader("X-Frick-Schema-Hash", schemaHash);
  if (!originAllowed) {
    // Browsers will block the response from reaching JS; the server still
    // serves the body, matching typical Express/Node CORS-middleware
    // semantics. Preflight requests are rejected outright at the caller.
    return;
  }
  if (allowedOrigins.includes("*") && (!requestOrigin || allowedOrigins.length === 1)) {
    response.setHeader("Access-Control-Allow-Origin", "*");
  } else if (requestOrigin && isOriginInAllowlist(requestOrigin, allowedOrigins)) {
    // Reflect the concrete request origin (never the wildcard pattern string)
    // so subdomain-wildcard and exact entries both echo a usable value.
    response.setHeader("Access-Control-Allow-Origin", requestOrigin);
    response.setHeader("Vary", "Origin");
  } else if (allowedOrigins.includes("*")) {
    response.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // Same-origin (no Origin header) and no wildcard: emit no
    // Access-Control-Allow-* headers — browsers wouldn't enforce anyway.
    return;
  }
  response.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, if-match, x-frick-idempotency-key, x-frick-owner-id, x-frick-session-token, x-frick-trace-id",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "etag, x-frick-schema-hash, x-frick-blob-id, x-frick-content-hash",
  );
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendAuthJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  response.end(JSON.stringify(body));
}

function sendError(response: http.ServerResponse, error: unknown, requestId: string): void {
  const status =
    error instanceof FrickLimitError
      ? httpLimitStatus(error)
      : error instanceof BlobValidationRejectedError
        ? 415
        : error instanceof AdminAuditWriteError
          ? 500
          : error instanceof AuthenticationError
              ? 401
              : error instanceof AuthorizationError
                ? 403
                : error instanceof CorsOriginRejectedError
                  ? 403
                  : error instanceof ProjectionNotFoundError
                    ? 404
                    : error instanceof SearchIndexNotFoundError
                      ? 404
                      : 400;
  const details: Record<string, unknown> = { routeCode: requestId };
  if (
    (error instanceof AuthenticationError || error instanceof AuthorizationError) &&
    error.decision &&
    !error.decision.allow
  ) {
    details.reason = error.decision.reason;
  }
  if (error instanceof UnknownTenantError) {
    details.reason = "unknownTenant";
    if ((error as { tenantId?: string }).tenantId) {
      details.tenantId = (error as { tenantId?: string }).tenantId;
    }
  }
  if (error instanceof CorsOriginRejectedError) {
    details.reason = error.reason;
  }
  if (error instanceof AdminAuditWriteError) {
    details.reason = error.reason;
  }
  if (error instanceof TenantIdValidationError) {
    details.reason = error.reason;
  }
  if (error instanceof ProjectionNotFoundError) {
    details.reason = error.reason;
    details.projection = error.projection;
  }
  if (error instanceof BlobValidationRejectedError) {
    details.reason = error.reason;
    details.processorId = error.processorId;
    if (error.rejectionReason) {
      details.rejectionReason = error.rejectionReason;
    }
  }
  if (error instanceof SearchIndexNotFoundError) {
    details.reason = error.reason;
    details.index = error.index;
  }
  if (error instanceof SearchIndexRebuildUnsupportedError) {
    details.reason = error.reason;
    details.index = error.index;
  }
  if (error instanceof InvalidSearchQueryError) {
    details.reason = error.reason;
  }
  if (error instanceof FrickLimitError) {
    details.limit = error.limit;
    details.configuredMax = error.configuredMax;
    details.actualValue = error.actualValue;
  }
  const envelope = createFrickErrorEnvelope({
    code: httpErrorCode(error),
    message: error instanceof Error ? error.message : "Unknown request error",
    requestId,
    retryable: false,
    details,
    schemaHash: foundationSchema.hash,
    schemaRevision: foundationSchema.schemaRevision,
  });
  sendJson(response, status, {
    error: envelope,
    code: envelope.code,
    message: envelope.message,
    requestId: envelope.requestId,
    retryable: envelope.retryable,
  });
}

function sendPushCredentialError(response: http.ServerResponse, error: PushCredentialError): void {
  const status = error.code === "push.credentials.disabled" ? 400 : 400;
  sendJson(response, status, { error: error.code, message: error.message });
}

function httpLimitStatus(error: FrickLimitError): number {
  return error.limit === "maxSseConnections" || error.limit === "maxAuthAttemptsPerWindow"
    ? 429
    : 413;
}

function httpErrorCode(error: unknown): FrickErrorCode {
  if (error instanceof SessionExpiredError) {
    return "auth.sessionExpired";
  }
  if (error instanceof AuthenticationError) {
    return "auth.unauthenticated";
  }
  if (error instanceof AuthorizationError) {
    return "auth.forbidden";
  }
  if (error instanceof CorsOriginRejectedError) {
    return "auth.forbidden";
  }
  if (error instanceof BlobValidationRejectedError) {
    return "blob.unsupportedContentType";
  }
  if (error instanceof AdminAuditWriteError) {
    return "sync.protocolError";
  }
  if (error instanceof InvalidSearchQueryError) {
    return "sync.protocolError";
  }
  if (error instanceof InvalidStreamCursorError) {
    return "stream.invalidCursor";
  }
  if (error instanceof FrickLimitError) {
    if (error.limit === "maxBlobBytes") {
      return "blob.tooLarge";
    }
    if (error.limit === "maxBlobBytesPerPrincipal") {
      return "blob.quotaExceeded";
    }
    if (error.limit === "maxStreamAppendPayloadBytes") {
      return "stream.appendRejected";
    }
    return "rateLimit.exceeded";
  }
  return "sync.protocolError";
}

async function readJsonBody(
  request: http.IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const buffer = await readBoundedRawBody(request, maxBytes, "maxHttpBodyBytes");
  if (buffer.byteLength === 0) {
    return {};
  }
  const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
  return requireRecord(parsed, "body");
}

async function readRawBody(request: http.IncomingMessage, maxBytes: number, limit: "maxBlobBytes" | "maxHttpBodyBytes"): Promise<Buffer> {
  return readBoundedRawBody(request, maxBytes, limit);
}

async function readBoundedRawBody(
  request: http.IncomingMessage,
  maxBytes: number,
  limit: "maxHttpBodyBytes" | "maxBlobBytes",
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      // Stop consuming further chunks but don't tear down the socket — we
      // still need to write a 413 response.
      request.pause();
      throw new FrickLimitError({ limit, actualValue: total, configuredMax: maxBytes });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function assertPayloadWithinLimit(payload: Record<string, unknown>, maxBytes: number): void {
  const encoded = msgpackEncode(payload);
  if (encoded.byteLength > maxBytes) {
    throw new FrickLimitError({
      limit: "maxStreamAppendPayloadBytes",
      actualValue: encoded.byteLength,
      configuredMax: maxBytes,
    });
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseSharingPermission(value: unknown): FrickSharingPermission {
  if (value === "read" || value === "write") {
    return value;
  }
  throw new Error('permission must be "read" or "write"');
}

function resolveInvitationTtlSeconds(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_FRICK_INVITATION_TTL_SECONDS;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("expiresInSeconds must be a positive finite number");
  }
  const seconds = Math.floor(value);
  return Math.min(seconds, MAX_FRICK_INVITATION_TTL_SECONDS);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

interface ParsedAnalyticsEventBody {
  name: string;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
  attributes: Record<string, string | number | boolean>;
  traceId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
}

function parseAnalyticsEventBody(
  body: Record<string, unknown>,
  request: http.IncomingMessage,
): ParsedAnalyticsEventBody {
  const traceId =
    optionalNonEmptyString(body.traceId, "traceId") ??
    optionalHeader(request, "x-frick-trace-id", "x-frick-trace-id");
  const idempotencyKey =
    optionalNonEmptyString(body.idempotencyKey, "idempotencyKey") ??
    optionalHeader(request, "x-frick-idempotency-key", "x-frick-idempotency-key");
  const occurredAt = optionalIsoTimestamp(body.occurredAt, "occurredAt");
  return {
    name: requireString(body.name, "name"),
    properties: optionalRecord(body.properties, "properties") ?? {},
    context: optionalRecord(body.context, "context") ?? {},
    attributes: optionalAnalyticsAttributes(body.attributes, "attributes") ?? {},
    ...(traceId !== undefined ? { traceId } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, name);
}

function optionalAnalyticsAttributes(
  value: unknown,
  name: string,
): Record<string, string | number | boolean> | undefined {
  const record = optionalRecord(value, name);
  if (record === undefined) return undefined;
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, attr] of Object.entries(record)) {
    if (typeof attr !== "string" && typeof attr !== "number" && typeof attr !== "boolean") {
      throw new Error(`${name}.${key} must be a string, number, or boolean`);
    }
    if (typeof attr === "number" && !Number.isFinite(attr)) {
      throw new Error(`${name}.${key} must be a finite number`);
    }
    attributes[key] = attr;
  }
  return attributes;
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

const CANONICAL_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function optionalIsoTimestamp(value: unknown, name: string): string | undefined {
  const timestamp = optionalNonEmptyString(value, name);
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  if (
    !CANONICAL_ISO_TIMESTAMP_PATTERN.test(timestamp) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString() !== timestamp
  ) {
    throw new Error(`${name} must be a canonical ISO timestamp string`);
  }
  return timestamp;
}

function optionalHeader(
  request: http.IncomingMessage,
  header: string,
  name: string,
): string | undefined {
  const value = headerValue(request, header);
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function optionalPositiveLimit(value: string | null): { limit?: number } {
  if (value === null || value === "") return {};
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return {};
  return { limit: parsed };
}

function parseBlobContentPath(url: URL): string | undefined {
  const match = /^\/blobs\/([^/]+)\/content$/.exec(url.pathname);
  const encodedBlobId = match?.[1];
  return encodedBlobId ? decodeURIComponent(encodedBlobId) : undefined;
}

function parseDerivativeListPath(url: URL): string | undefined {
  const match = /^\/blobs\/([^/]+)\/derivatives$/.exec(url.pathname);
  const encoded = match?.[1];
  return encoded ? decodeURIComponent(encoded) : undefined;
}

function parseDerivativeContentPath(
  url: URL,
): { blobId: string; derivativeId: string } | undefined {
  const match = /^\/blobs\/([^/]+)\/derivatives\/([^/]+)\/content$/.exec(url.pathname);
  const encodedBlob = match?.[1];
  const encodedDeriv = match?.[2];
  if (!encodedBlob || !encodedDeriv) return undefined;
  return {
    blobId: decodeURIComponent(encodedBlob),
    derivativeId: decodeURIComponent(encodedDeriv),
  };
}

function parseObjectWritePath(url: URL): { type: string; id: string } | undefined {
  const match = /^\/objects\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const encodedType = match?.[1];
  const encodedId = match?.[2];
  if (!encodedType || !encodedId) {
    return undefined;
  }
  return { type: decodeURIComponent(encodedType), id: decodeURIComponent(encodedId) };
}

/**
 * Parse an If-Match HTTP header into a version number. Returns:
 *   - `undefined` when the header is absent or is the wildcard "*"
 *   - a non-negative integer otherwise
 * Throws when the header is present but malformed (non-integer, negative).
 *
 * Per RFC 7232 the value is a quoted ETag; we accept both `"3"` and bare
 * `3` so curl-style callers don't have to escape quotes.
 */
function parseIfMatchHeader(request: http.IncomingMessage): number | undefined {
  const raw = headerValue(request, "if-match");
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "*") {
    return undefined;
  }
  const unquoted = trimmed.replace(/^W\//i, "").replace(/^"|"$/g, "");
  const parsed = Number(unquoted);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("If-Match must be a non-negative integer or \"*\"");
  }
  return parsed;
}

function withoutEnvelopeId(value: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = value;
  return rest;
}

function parseSignalPath(url: URL): { name: string; key: string } | undefined {
  const match = /^\/signals\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const encodedName = match?.[1];
  const encodedKey = match?.[2];
  return encodedName && encodedKey
    ? { name: decodeURIComponent(encodedName), key: decodeURIComponent(encodedKey) }
    : undefined;
}

function sha256ContentHash(content: Uint8Array): string {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

function validateBlobContent(
  blobId: string,
  expectedByteLength: number,
  expectedContentHash: string,
  content: Uint8Array,
  actualContentHash: string,
): void {
  if (content.byteLength !== expectedByteLength) {
    throw new Error(`blob ${blobId} byteLength mismatch: expected ${expectedByteLength}, got ${content.byteLength}`);
  }
  if (expectedContentHash.startsWith("sha256-") && expectedContentHash !== actualContentHash) {
    throw new Error(`blob ${blobId} contentHash mismatch: expected ${expectedContentHash}, got ${actualContentHash}`);
  }
}

function inferMimeType(request: http.IncomingMessage): string {
  return headerValue(request, "content-type")?.split(";")[0]?.trim() || "application/octet-stream";
}

function headerValue(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function protectedHttpPrincipal(request: http.IncomingMessage, url: URL, store: FrickStore, config: FrickConfig): Promise<Principal | AuthenticationError> {
  if (!isProtectedPath(url.pathname)) {
    return {
      userId: "public",
      deviceId: "public",
      replicaId: "public",
      tenantId: DEFAULT_TENANT_ID,
    };
  }

  const token = sessionTokenFromRequest(request, url);
  if (!token) {
    return new AuthenticationError("Missing session token");
  }

  // Admin bearer takes precedence over session lookup so a configured admin
  // token can act on any path. Constant-time equality is unnecessary here:
  // the token is operator-supplied at boot and used over TLS in production.
  if (config.adminEnabled && config.adminToken && token === config.adminToken) {
    return {
      userId: "_admin",
      deviceId: "_admin",
      replicaId: "_admin",
      tenantId: DEFAULT_TENANT_ID,
      scope: "admin",
    };
  }

  // Service-principal API keys (FR-46) carry the non-secret `sk_…` key-id
  // prefix, so we can route them to the service-principal store without a
  // wasted session lookup. A user session token never has this shape.
  if (isServicePrincipalKey(token)) {
    return servicePrincipalFromKey(store, token);
  }

  const session = await store.readActiveSession(token);
  return principalFromActiveSessionToken(store, token, session);
}

/**
 * Whether `token` looks like a service-principal API key (FR-46). Keys are
 * minted as `sk_<keyId>.<secret>` — the `sk_` prefix and embedded `.` separator
 * distinguish them from opaque base64url session tokens.
 */
function isServicePrincipalKey(token: string): boolean {
  return token.startsWith("sk_") && token.includes(".");
}

/**
 * Resolve a service-principal API key into a scoped `"service"` principal and
 * emit an admin-audit event recording the access (FR-46). The audit row reuses
 * the existing hash chain; the subject fingerprint is the non-secret key id so
 * the raw key never reaches the log. Authentication failures are audited as a
 * `deny` so a leaked/revoked key's use is visible.
 */
async function servicePrincipalFromKey(
  store: FrickStore,
  apiKey: string,
): Promise<Principal | AuthenticationError> {
  const record = await store.servicePrincipals.authenticate(apiKey);
  const fingerprint = serviceKeyFingerprint(apiKey);
  if (!record) {
    void store.adminAudit
      .record({
        adminTokenFingerprint: fingerprint,
        action: "servicePrincipal.authenticate",
        outcome: "deny",
        detail: JSON.stringify({ reason: "unknownOrRevoked" }),
      })
      .catch(() => {});
    return new AuthenticationError("Invalid or revoked service principal key");
  }

  if (await isTenantArchived(store, record.tenantId)) {
    return new AuthenticationError("Tenant is archived");
  }

  void store.adminAudit
    .record({
      adminTokenFingerprint: fingerprint,
      action: "servicePrincipal.authenticate",
      target: record.id,
      outcome: "allow",
      detail: JSON.stringify({ tenantId: record.tenantId, scopes: record.scopes }),
    })
    .catch(() => {});

  return {
    userId: record.id,
    deviceId: "service",
    replicaId: "service",
    tenantId: record.tenantId,
    scope: "service",
    serviceScopes: record.scopes,
  };
}

/** Truncated SHA-256 of the service key's non-secret id prefix, for audit. */
function serviceKeyFingerprint(apiKey: string): string {
  const keyId = apiKey.slice(0, apiKey.indexOf("."));
  return createHash("sha256").update(keyId).digest("hex").slice(0, 12);
}

async function principalFromActiveSessionToken(
  store: FrickStore,
  token: string,
  session?: StoredSession | undefined,
): Promise<Principal | AuthenticationError> {
  const resolvedSession = session ?? await store.readActiveSession(token);
  if (!resolvedSession) {
    const stale = await store.readAnySession(token);
    if (stale && Date.parse(stale.expiresAt) <= Date.now()) {
      return new SessionExpiredError();
    }
    return new AuthenticationError("Invalid or expired session token");
  }

  if (await isTenantArchived(store, resolvedSession.tenantId)) {
    return new AuthenticationError("Tenant is archived");
  }

  return {
    userId: resolvedSession.userId,
    deviceId: resolvedSession.deviceId,
    replicaId: resolvedSession.replicaId,
    tenantId: resolvedSession.tenantId,
  };
}

async function isTenantArchived(store: FrickStore, tenantId: string): Promise<boolean> {
  return (await store.tenants.get(tenantId))?.archivedAt !== undefined;
}

async function inspectionPrincipalFromRequest(
  request: http.IncomingMessage,
  url: URL,
  store: FrickStore,
  config: FrickConfig,
): Promise<Principal | AuthenticationError> {
  if (config.env === "production") {
    const admin = adminPrincipalFromRequest(request, url, config);
    return admin ?? new AuthenticationError("Missing or invalid admin token");
  }

  const admin = adminPrincipalFromRequest(request, url, config);
  if (admin) return admin;

  const token = sessionTokenFromRequest(request, url);
  if (!token) {
    return new AuthenticationError("Missing session token");
  }
  return principalFromActiveSessionToken(store, token);
}

/**
 * Build an admin principal from the request's bearer if it matches the
 * configured admin token. Returns `undefined` if admin is disabled, the
 * bearer is missing, or the bearer doesn't match. The returned principal is
 * scoped `"admin"` so {@link decide} bypasses the cross-tenant check.
 */
function adminPrincipalFromRequest(
  request: http.IncomingMessage,
  url: URL,
  config: FrickConfig,
): Principal | undefined {
  if (!config.adminEnabled || !config.adminToken) {
    return undefined;
  }
  void url;
  const token = bearerTokenFromRequest(request);
  if (!token || token !== config.adminToken) {
    return undefined;
  }
  return {
    userId: "_admin",
    deviceId: "_admin",
    replicaId: "_admin",
    tenantId: DEFAULT_TENANT_ID,
    scope: "admin",
  };
}

/**
 * Thrown by {@link ensureTenantAllowed} when a non-default tenant id isn't
 * present in the ledger and `config.implicitTenantCreation` is false. The
 * caller surfaces this through `sendError` as `auth.forbidden` with
 * `details.reason: "unknownTenant"`.
 */
class UnknownTenantError extends AuthorizationError {
  constructor(tenantId: string) {
    super({
      allow: false,
      reason: "notAuthorizedForResource",
      publicMessage: `Unknown tenant ${tenantId}`,
    });
    this.name = "UnknownTenantError";
    (this as { tenantId?: string }).tenantId = tenantId;
  }
}

/**
 * Pre-check called from `/auth/*` handlers: confirms the supplied tenant is
 * either the always-allowed default tenant, already in the ledger, or — when
 * `config.implicitTenantCreation` is true — auto-inserted into the ledger so
 * subsequent requests resolve cleanly. Throws {@link UnknownTenantError}
 * when the tenant is unknown and implicit creation is disabled.
 */
async function ensureTenantAllowed(store: FrickStore, config: FrickConfig, tenantId: string): Promise<void> {
  if (tenantId === DEFAULT_TENANT_ID) {
    return;
  }
  const existing = await store.tenants.get(tenantId);
  if (existing && !existing.archivedAt) {
    return;
  }
  if (existing && existing.archivedAt) {
    throw new UnknownTenantError(tenantId);
  }
  if (config.implicitTenantCreation) {
    await store.tenants.ensure(tenantId);
    return;
  }
  throw new UnknownTenantError(tenantId);
}

async function handleAdminRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  store: FrickStore,
  config: FrickConfig,
  maxBodyBytes: number,
  adminTokenFingerprint: string,
  logger: FrickLogger,
  notificationRouter: NotificationRouter,
  gateway: SyncGateway,
): Promise<void> {
  const sub = url.pathname.slice("/_frick/admin/".length);

  // Helper that records an audit row. Wrapped so we can swallow audit-store
  // failures rather than letting an audit hiccup mask the real handler
  // response — losing one audit row beats failing a legitimate admin call.
  const audit = (input: {
    action: string;
    target?: string;
    outcome: "allow" | "deny" | "error";
    detail?: Record<string, unknown>;
  }): void => {
    try {
      store.adminAudit.record({
        adminTokenFingerprint,
        action: input.action,
        ...(input.target !== undefined ? { target: input.target } : {}),
        outcome: input.outcome,
        ...(input.detail !== undefined ? { detail: JSON.stringify(input.detail) } : {}),
      });
    } catch {
      // Audit failures are best-effort. Don't tear down the request.
    }
  };
  const strictAudit = (input: {
    action: string;
    target?: string;
    outcome: "allow" | "deny" | "error";
    detail?: Record<string, unknown>;
  }): void => {
    try {
      store.adminAudit.record({
        adminTokenFingerprint,
        action: input.action,
        ...(input.target !== undefined ? { target: input.target } : {}),
        outcome: input.outcome,
        ...(input.detail !== undefined ? { detail: JSON.stringify(input.detail) } : {}),
      });
    } catch (error) {
      throw new AdminAuditWriteError(error);
    }
  };

  if (request.method === "GET" && sub === "audit-log") {
    const sinceParam = url.searchParams.get("since") ?? undefined;
    const actionParam = url.searchParams.get("action") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    const options: { since?: string; action?: string; limit?: number } = {};
    if (sinceParam !== undefined) options.since = sinceParam;
    if (actionParam !== undefined) options.action = actionParam;
    if (limitParam !== null) {
      const parsed = Number.parseInt(limitParam, 10);
      if (Number.isFinite(parsed)) options.limit = parsed;
    }
    const entries = await store.adminAudit.list(options);
    sendJson(response, 200, { entries });
    return;
  }

  if (request.method === "POST" && sub === "sessions/revoke") {
    // Proactive session revocation so operators stop deleting `auth_sessions`
    // rows by hand (threat-model.md). Revoke by `userId` (every session for
    // that user, optionally scoped to one `tenantId`) or by a single
    // `sessionToken`. Deleting the row blocks future requests; the live
    // disconnect drops any currently-connected WebSocket so a revoked client
    // can't keep streaming on an already-open socket. (FR-34)
    const body = await readJsonBody(request, maxBodyBytes);
    const userId = typeof body.userId === "string" && body.userId.length > 0 ? body.userId : undefined;
    const sessionToken =
      typeof body.sessionToken === "string" && body.sessionToken.length > 0 ? body.sessionToken : undefined;
    const tenantId =
      typeof body.tenantId === "string" && body.tenantId.length > 0 ? body.tenantId : undefined;

    if (!userId && !sessionToken) {
      strictAudit({ action: "sessions.revoke", outcome: "deny", detail: { reason: "missingTarget" } });
      const envelope = createFrickErrorEnvelope({
        code: "sync.protocolError",
        message: "Provide a userId or a sessionToken to revoke",
        requestId: "admin_session_revoke_invalid",
        retryable: false,
        details: { reason: "missingTarget" },
        schemaHash: foundationSchema.hash,
        schemaRevision: foundationSchema.schemaRevision,
      });
      sendJson(response, 400, {
        error: envelope,
        code: envelope.code,
        message: envelope.message,
        requestId: envelope.requestId,
        retryable: envelope.retryable,
      });
      return;
    }

    let revoked = 0;
    let disconnected = 0;
    if (userId) {
      revoked += await store.deleteSessionsForUser(userId, tenantId);
      disconnected += gateway.closeSessionsForUser(userId, tenantId);
    }
    if (sessionToken) {
      if (await store.deleteSession(sessionToken)) {
        revoked += 1;
      }
      gateway.closeSession(sessionToken);
    }

    strictAudit({
      action: "sessions.revoke",
      ...(userId !== undefined ? { target: userId } : {}),
      outcome: "allow",
      detail: {
        ...(userId !== undefined ? { userId } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(sessionToken !== undefined ? { byToken: true } : {}),
        revoked,
        disconnected,
      },
    });
    sendJson(response, 200, { revoked, disconnected });
    return;
  }

  if (request.method === "GET" && sub === "tenants") {
    // Read-side audit deliberately skipped: list-tenants is the admin UI's
    // poll target and would dwarf mutation rows. Documented as a known gap
    // in docs/operations.md so operators know reads aren't traced here.
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    sendJson(response, 200, { tenants: await store.tenants.list(includeArchived) });
    return;
  }

  if (request.method === "POST" && sub === "tenants") {
    let tenantId: string | undefined;
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      tenantId = requireString(body.tenantId, "tenantId");
      const displayName =
        typeof body.displayName === "string" && body.displayName.length > 0
          ? body.displayName
          : undefined;
      const existing = await store.tenants.get(tenantId);
      if (existing && !existing.archivedAt) {
        strictAudit({
          action: "tenants.create",
          target: tenantId,
          outcome: "deny",
          detail: { reason: "tenantExists" },
        });
        const envelope = createFrickErrorEnvelope({
          code: "sync.protocolError",
          message: `Tenant ${tenantId} already exists`,
          requestId: "admin_tenant_conflict",
          retryable: false,
          details: { reason: "tenantExists", tenantId },
          schemaHash: foundationSchema.hash,
          schemaRevision: foundationSchema.schemaRevision,
        });
        sendJson(response, 409, {
          error: envelope,
          code: envelope.code,
          message: envelope.message,
          requestId: envelope.requestId,
          retryable: envelope.retryable,
        });
        return;
      }
      strictAudit({
        action: "tenants.create",
        target: tenantId,
        outcome: "allow",
        ...(displayName !== undefined ? { detail: { displayName } } : {}),
      });
      const row = await store.tenants.create(tenantId, displayName);
      sendJson(response, 201, row);
    } catch (error) {
      if (error instanceof TenantAlreadyExistsError) {
        strictAudit({
          action: "tenants.create",
          target: error.tenantId,
          outcome: "deny",
          detail: { reason: "tenantExists" },
        });
        const envelope = createFrickErrorEnvelope({
          code: "sync.protocolError",
          message: error.message,
          requestId: "admin_tenant_conflict",
          retryable: false,
          details: { reason: "tenantExists", tenantId: error.tenantId },
          schemaHash: foundationSchema.hash,
          schemaRevision: foundationSchema.schemaRevision,
        });
        sendJson(response, 409, {
          error: envelope,
          code: envelope.code,
          message: envelope.message,
          requestId: envelope.requestId,
          retryable: envelope.retryable,
        });
        return;
      }
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "tenants.create",
          ...(tenantId !== undefined ? { target: tenantId } : {}),
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  const archiveMatch = /^tenants\/([^/]+)\/archive$/.exec(sub);
  if (request.method === "POST" && archiveMatch) {
    const tenantId = decodeURIComponent(archiveMatch[1]!);
    const existing = await store.tenants.get(tenantId);
    if (!existing) {
      strictAudit({
        action: "tenants.archive",
        target: tenantId,
        outcome: "deny",
        detail: { reason: "tenantNotFound" },
      });
      sendJson(response, 404, { error: "tenant_not_found" });
      return;
    }
    try {
      strictAudit({ action: "tenants.archive", target: tenantId, outcome: "allow" });
      await store.tenants.archive(tenantId);
      const row = await store.tenants.get(tenantId);
      sendJson(response, 200, row);
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "tenants.archive",
          target: tenantId,
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  // Per-tenant settings. The routes are placed before the bare
  // `^tenants/(...)$` show route so the more specific `/settings` segment
  // matches first.
  const settingsListMatch = /^tenants\/([^/]+)\/settings$/.exec(sub);
  if (request.method === "GET" && settingsListMatch) {
    const tenantId = decodeURIComponent(settingsListMatch[1]!);
    try {
      const settings = await store.tenantSettings.list(tenantId);
      audit({ action: "tenants.settings.list", target: tenantId, outcome: "allow" });
      sendJson(response, 200, { tenantId, settings });
    } catch (error) {
      audit({
        action: "tenants.settings.list",
        target: tenantId,
        outcome: "error",
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    return;
  }

  const settingsPutMatch = /^tenants\/([^/]+)\/settings\/([^/]+)$/.exec(sub);
  if (request.method === "PUT" && settingsPutMatch) {
    const tenantId = decodeURIComponent(settingsPutMatch[1]!);
    const settingKey = decodeURIComponent(settingsPutMatch[2]!);
    try {
      // Read the raw bytes so the body can be any JSON value — number,
      // string, or object. readJsonBody assumes an object envelope, which
      // is too strict for a setting like `retentionMs: 60000`.
      const raw = await readBoundedRawBody(request, maxBodyBytes, "maxHttpBodyBytes");
      let value: unknown = null;
      if (raw.byteLength > 0) {
        try {
          value = JSON.parse(raw.toString("utf8")) as unknown;
        } catch (parseError) {
          throw new Error(
            `body must be a valid JSON value (${parseError instanceof Error ? parseError.message : String(parseError)})`,
          );
        }
      }
      strictAudit({
        action: "tenants.settings.put",
        target: `${tenantId}/${settingKey}`,
        outcome: "allow",
      });
      await store.tenantSettings.set(tenantId, settingKey, value);
      sendJson(response, 200, { tenantId, key: settingKey, value });
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "tenants.settings.put",
          target: `${tenantId}/${settingKey}`,
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  const showMatch = /^tenants\/([^/]+)$/.exec(sub);
  if (request.method === "GET" && showMatch) {
    // Read-side audit skipped — see GET /tenants comment above.
    const tenantId = decodeURIComponent(showMatch[1]!);
    const row = await store.tenants.get(tenantId);
    if (!row) {
      sendJson(response, 404, { error: "tenant_not_found" });
      return;
    }
    sendJson(response, 200, row);
    return;
  }

  if (request.method === "GET" && sub === "accounts") {
    const rawTenant = url.searchParams.get("tenantId");
    if (rawTenant === null || rawTenant.length === 0) {
      throw new Error("tenantId query parameter is required");
    }
    validateTenantId(rawTenant);
    const tenantId = normalizeTenantId(rawTenant);
    const rawLimit = url.searchParams.get("limit");
    let limit = 100;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("limit must be a positive number");
      }
      limit = Math.min(1000, Math.floor(parsed));
    }
    const accounts = await store.accounts.list(tenantId, limit);
    sendJson(response, 200, { accounts });
    return;
  }

  if (request.method === "POST" && sub === "accounts") {
    let tenantId: string | undefined;
    let handle: string | undefined;
    const sendConflict = (message: string, conflictTenantId: string, conflictHandle: string): void => {
      const envelope = createFrickErrorEnvelope({
        code: "storage.conflict",
        message,
        requestId: "admin_account_conflict",
        retryable: false,
        details: { reason: "handleExists", tenantId: conflictTenantId, handle: conflictHandle },
        schemaHash: foundationSchema.hash,
        schemaRevision: foundationSchema.schemaRevision,
      });
      sendJson(response, 409, {
        error: envelope,
        code: envelope.code,
        message: envelope.message,
        requestId: envelope.requestId,
        retryable: envelope.retryable,
      });
    };
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      tenantId = resolveAuthTenantId(body.tenantId);
      ensureTenantAllowed(store, config, tenantId);
      handle = normalizeHandle(requireString(body.handle, "handle"));
      const displayName = normalizeDisplayName(requireString(body.displayName, "displayName"));
      const password = normalizePassword(requireString(body.password, "password"));
      const userId =
        typeof body.userId === "string" && body.userId.length > 0
          ? body.userId
          : userIdFromHandle(tenantId, handle);
      const target = `${tenantId}/${handle}`;
      const existingAccount =
        await store.accounts.readByIdentity(tenantId, handle) ??
        await store.accounts.readByIdentity(tenantId, userId);
      if (existingAccount || await store.hasUser(tenantId, userId)) {
        strictAudit({
          action: "accounts.create",
          target,
          outcome: "deny",
          detail: { reason: "handleExists", tenantId, handle },
        });
        sendConflict("Handle is already taken", tenantId, handle);
        return;
      }
      strictAudit({
        action: "accounts.create",
        target,
        outcome: "allow",
        detail: { tenantId, handle, userId },
      });
      const account = await store.createAccountUser({
        tenantId,
        userId,
        handle,
        displayName,
        password,
      });
      sendJson(response, 201, { account });
    } catch (error) {
      if (error instanceof Error && /already taken|UNIQUE|constraint/i.test(error.message)) {
        const target =
          tenantId !== undefined && handle !== undefined ? `${tenantId}/${handle}` : undefined;
        strictAudit({
          action: "accounts.create",
          ...(target !== undefined ? { target } : {}),
          outcome: "deny",
          detail: {
            reason: "handleExists",
            ...(tenantId !== undefined ? { tenantId } : {}),
            ...(handle !== undefined ? { handle } : {}),
          },
        });
        sendConflict(error.message, tenantId ?? DEFAULT_TENANT_ID, handle ?? "");
        return;
      }
      if (!(error instanceof AdminAuditWriteError)) {
        const target =
          tenantId !== undefined && handle !== undefined ? `${tenantId}/${handle}` : tenantId;
        strictAudit({
          action: "accounts.create",
          ...(target !== undefined ? { target } : {}),
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && sub === "accounts/move") {
    // Reassign an account's tenant (FR-39). Moves the account *identity* row
    // (its `tenant_id`); the user re-authenticates into the new tenant because
    // we revoke every session bound to the old tenant. NOTE ON DATA BOUNDARY:
    // only the account identity moves here. The account's per-tenant DATA in
    // the object/stream stores is tenant-scoped and is NOT migrated — that is
    // a separate concern (see docs/operations.md "Moving an account between
    // tenants"). Don't assume objects/streams follow the account.
    let fromTenantId: string | undefined;
    let toTenantId: string | undefined;
    let userId: string | undefined;
    const sendMoveError = (
      statusCode: number,
      requestId: string,
      message: string,
      details: Record<string, unknown>,
    ): void => {
      const envelope = createFrickErrorEnvelope({
        code: statusCode === 409 ? "storage.conflict" : "sync.protocolError",
        message,
        requestId,
        retryable: false,
        details,
        schemaHash: foundationSchema.hash,
        schemaRevision: foundationSchema.schemaRevision,
      });
      sendJson(response, statusCode, {
        error: envelope,
        code: envelope.code,
        message: envelope.message,
        requestId: envelope.requestId,
        retryable: envelope.retryable,
      });
    };
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      userId = requireString(body.userId, "userId");
      const rawFrom = body.fromTenantId ?? body.tenantId;
      fromTenantId = resolveAuthTenantId(rawFrom);
      toTenantId = resolveAuthTenantId(requireString(body.toTenantId, "toTenantId"));
      const target = `${fromTenantId}/${userId}`;

      // Target tenant must exist (and not be archived) — never move an account
      // into a tenant the ledger doesn't know about.
      await ensureTenantAllowed(store, config, toTenantId);

      const result = await store.accounts.move(fromTenantId, userId, toTenantId);
      if (result === "notFound") {
        strictAudit({
          action: "accounts.move",
          target,
          outcome: "deny",
          detail: { reason: "accountNotFound", fromTenantId, toTenantId, userId },
        });
        sendMoveError(404, "admin_account_move_not_found", "Account not found", {
          reason: "accountNotFound",
          fromTenantId,
          toTenantId,
          userId,
        });
        return;
      }
      if (result === "conflict") {
        strictAudit({
          action: "accounts.move",
          target,
          outcome: "deny",
          detail: { reason: "handleExists", fromTenantId, toTenantId, userId },
        });
        sendMoveError(
          409,
          "admin_account_move_conflict",
          "Target tenant already has an account with that handle or userId",
          { reason: "handleExists", fromTenantId, toTenantId, userId },
        );
        return;
      }

      // Revoke the account's old-tenant sessions so the user re-authenticates
      // into the new tenant; live-disconnect any open sockets.
      const revoked = await store.deleteSessionsForUser(userId, fromTenantId);
      const disconnected = gateway.closeSessionsForUser(userId, fromTenantId);

      strictAudit({
        action: "accounts.move",
        target,
        outcome: "allow",
        detail: { fromTenantId, toTenantId, userId, revoked, disconnected },
      });
      sendJson(response, 200, {
        userId,
        fromTenantId,
        toTenantId,
        moved: true,
        revoked,
        disconnected,
      });
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        const target =
          fromTenantId !== undefined && userId !== undefined
            ? `${fromTenantId}/${userId}`
            : undefined;
        strictAudit({
          action: "accounts.move",
          ...(target !== undefined ? { target } : {}),
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  const jobsTriggerMatch = /^jobs\/([^/]+)$/.exec(sub);
  if (request.method === "POST" && jobsTriggerMatch) {
    const jobType = decodeURIComponent(jobsTriggerMatch[1]!);
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      const tenantId = resolveAuthTenantId(body.tenantId);
      ensureTenantAllowed(store, config, tenantId);
      const payload =
        body.payload !== undefined
          ? requireRecord(body.payload, "payload")
          : {};
      const idempotencyKey =
        typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0
          ? body.idempotencyKey
          : undefined;
      strictAudit({
        action: "jobs.enqueue",
        target: jobType,
        outcome: "allow",
        detail: { tenantId },
      });
      const row = await store.jobs.enqueue({
        tenantId,
        jobType,
        payload,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
      sendJson(response, 201, row);
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "jobs.enqueue",
          target: jobType,
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && sub === "push/deliver") {
    let bodyTenant: string | undefined;
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      const tenantId = resolveAuthTenantId(body.tenantId);
      bodyTenant = tenantId;
      ensureTenantAllowed(store, config, tenantId);
      const intentName = requireString(body.intent, "intent");
      const recipientsRaw = body.recipientUserIds;
      if (!Array.isArray(recipientsRaw)) {
        throw new Error("recipientUserIds must be an array");
      }
      const recipientUserIds = recipientsRaw.map((value, index) =>
        requireString(value, `recipientUserIds[${index}]`),
      );
      const bodyPayload =
        body.body !== undefined ? requireRecord(body.body, "body") : {};
      const intent: FrickNotificationIntent = {
        intent: intentName,
        tenantId,
        recipientUserIds,
        body: {
          ...(typeof bodyPayload.title === "string" ? { title: bodyPayload.title } : {}),
          ...(typeof bodyPayload.body === "string" ? { body: bodyPayload.body } : {}),
          ...(bodyPayload.data && typeof bodyPayload.data === "object" && !Array.isArray(bodyPayload.data)
            ? { data: bodyPayload.data as Record<string, unknown> }
            : {}),
        },
        ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
        ...(typeof body.deepLink === "string" ? { deepLink: body.deepLink } : {}),
      };
      strictAudit({
        action: "push.deliver",
        target: intentName,
        outcome: "allow",
        detail: { tenantId, recipientCount: recipientUserIds.length },
      });
      const row = await notificationRouter.enqueueIntent(intent);
      sendJson(response, 201, { jobId: row.id, jobType: row.jobType, status: row.status });
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "push.deliver",
          ...(bodyTenant !== undefined ? { target: bodyTenant } : {}),
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && sub === "backup") {
    let tenantId: string | undefined;
    const bodyParsed = await readJsonBody(request, maxBodyBytes);
    if (typeof bodyParsed.tenantId === "string" && bodyParsed.tenantId.length > 0) {
      tenantId = bodyParsed.tenantId;
      if (tenantId !== "all") {
        validateTenantId(tenantId);
        tenantId = normalizeTenantId(tenantId);
      }
    }
    const options: FrickDumpOptions = tenantId !== undefined ? { tenantId } : {};
    try {
      strictAudit({
        action: "backup.dump",
        ...(tenantId !== undefined ? { target: tenantId } : { target: "all" }),
        outcome: "allow",
      });
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      for await (const line of dumpFrickDatabase(store, options)) {
        response.write(`${line}\n`);
      }
      response.end();
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "backup.dump",
          ...(tenantId !== undefined ? { target: tenantId } : { target: "all" }),
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && sub === "restore") {
    if (config.env === "production") {
      strictAudit({
        action: "backup.restore",
        outcome: "deny",
        detail: { reason: "restoreNotAllowedInProduction" },
      });
      const envelope = createFrickErrorEnvelope({
        code: "auth.forbidden",
        message: "Restore is disabled in production mode",
        requestId: "admin_restore_prod",
        retryable: false,
        details: { reason: "restoreNotAllowedInProduction" },
        schemaHash: foundationSchema.hash,
        schemaRevision: foundationSchema.schemaRevision,
      });
      sendJson(response, 403, {
        error: envelope,
        code: envelope.code,
        message: envelope.message,
        requestId: envelope.requestId,
        retryable: envelope.retryable,
      });
      return;
    }
    if (url.searchParams.get("confirm") !== "yes") {
      strictAudit({
        action: "backup.restore",
        outcome: "deny",
        detail: { reason: "missingConfirmation" },
      });
      sendJson(response, 400, { error: "missing_confirmation", message: "Pass ?confirm=yes" });
      return;
    }
    const overwrite = url.searchParams.get("overwrite") === "true";
    const forceSchemaDrift = url.searchParams.get("forceSchemaDrift") === "true";
    const raw = await readBoundedRawBody(request, maxBodyBytes, "maxHttpBodyBytes");
    const text = raw.toString("utf8");
    async function* asLines(): AsyncIterable<string> {
      yield text;
    }
    try {
      strictAudit({
        action: "backup.restore",
        outcome: "allow",
        detail: { overwrite, forceSchemaDrift },
      });
      const report = await restoreFrickDatabase({
        target: store,
        source: asLines(),
        confirm: "yes",
        overwrite,
        forceSchemaDrift,
      });
      sendJson(response, 200, report);
    } catch (error) {
      if (error instanceof FrickRestoreRefusedError) {
        strictAudit({
          action: "backup.restore",
          outcome: "deny",
          detail: { reason: error.reason, ...(error.details ?? {}) },
        });
        sendJson(response, 409, {
          error: "restore_refused",
          reason: error.reason,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
        return;
      }
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "backup.restore",
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  const searchRebuildMatch = /^search\/([^/]+)\/rebuild$/.exec(sub);
  if (request.method === "POST" && searchRebuildMatch) {
    const indexName = decodeURIComponent(searchRebuildMatch[1]!);
    const rawTenant = url.searchParams.get("tenantId");
    const tenantId = rawTenant && rawTenant.length > 0 ? rawTenant : DEFAULT_TENANT_ID;
    try {
      validateTenantId(tenantId);
    } catch (error) {
      strictAudit({
        action: "search.rebuild",
        target: indexName,
        outcome: "error",
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    const def = store.searchIndexes.get(indexName);
    if (!def) {
      strictAudit({
        action: "search.rebuild",
        target: indexName,
        outcome: "deny",
        detail: { reason: "searchIndexNotFound" },
      });
      throw new SearchIndexNotFoundError(indexName);
    }
    if (def.source.kind === "projection") {
      strictAudit({
        action: "search.rebuild",
        target: indexName,
        outcome: "deny",
        detail: { reason: "projectionSourceUnsupported" },
      });
      throw new SearchIndexRebuildUnsupportedError(indexName);
    }
    try {
      const normalizedTenant = normalizeTenantId(tenantId);
      const source = sourceIterableForIndex(store, def, normalizedTenant);
      strictAudit({
        action: "search.rebuild",
        target: indexName,
        outcome: "allow",
        detail: { tenantId: normalizedTenant },
      });
      await store.searchAdapter.rebuild(normalizedTenant, indexName, source);
      const rebuiltAt = new Date().toISOString();
      sendJson(response, 200, { index: indexName, tenantId: normalizedTenant, rebuiltAt });
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "search.rebuild",
          target: indexName,
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  const rebuildMatch = /^projections\/([^/]+)\/rebuild$/.exec(sub);
  if (request.method === "POST" && rebuildMatch) {
    const name = decodeURIComponent(rebuildMatch[1]!);
    const rawTenant = url.searchParams.get("tenantId");
    const tenantId = rawTenant && rawTenant.length > 0 ? rawTenant : DEFAULT_TENANT_ID;
    try {
      validateTenantId(tenantId);
    } catch (error) {
      strictAudit({
        action: "projections.rebuild",
        target: name,
        outcome: "error",
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    const projection = store.projections.get(name);
    if (!projection) {
      strictAudit({
        action: "projections.rebuild",
        target: name,
        outcome: "deny",
        detail: { reason: "projectionNotFound" },
      });
      throw new ProjectionNotFoundError(name);
    }
    if (!projection.handler.rebuild) {
      strictAudit({
        action: "projections.rebuild",
        target: name,
        outcome: "deny",
        detail: { reason: "rebuildNotSupported" },
      });
      sendJson(response, 405, {
        error: "method_not_allowed",
        message: `Projection "${name}" does not support rebuild`,
      });
      return;
    }
    try {
      const ctx: FrickProjectionContext = {
        tenantId: normalizeTenantId(tenantId),
        store,
        logger,
      };
      strictAudit({
        action: "projections.rebuild",
        target: name,
        outcome: "allow",
        detail: { tenantId: ctx.tenantId },
      });
      projection.handler.rebuild(ctx);
      const rebuiltAt = new Date().toISOString();
      sendJson(response, 200, { projection: name, tenantId: ctx.tenantId, rebuiltAt });
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "projections.rebuild",
          target: name,
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  if (request.method === "GET" && sub === "data-subject") {
    const rawTenant = url.searchParams.get("tenantId");
    const userId = url.searchParams.get("userId");
    if (!rawTenant || !userId) {
      strictAudit({
        action: "compliance.dataSubject.export",
        outcome: "deny",
        detail: { reason: "missingParameters" },
      });
      sendJson(response, 400, {
        error: "bad_request",
        message: "tenantId and userId query parameters are required",
      });
      return;
    }
    validateTenantId(rawTenant);
    const tenantId = normalizeTenantId(rawTenant);
    try {
      const payload = exportDataSubject(store, tenantId, userId);
      strictAudit({
        action: "compliance.dataSubject.export",
        target: userId,
        outcome: "allow",
        detail: { tenantId },
      });
      sendJson(response, 200, payload);
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "compliance.dataSubject.export",
          target: userId,
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && sub === "data-subject/erase") {
    const rawTenant = url.searchParams.get("tenantId");
    const userId = url.searchParams.get("userId");
    const confirm = url.searchParams.get("confirm");
    if (!rawTenant || !userId) {
      strictAudit({
        action: "compliance.dataSubject.erase",
        outcome: "deny",
        detail: { reason: "missingParameters" },
      });
      sendJson(response, 400, {
        error: "bad_request",
        message: "tenantId and userId query parameters are required",
      });
      return;
    }
    if (config.env === "production" && confirm !== "yes") {
      strictAudit({
        action: "compliance.dataSubject.erase",
        target: userId,
        outcome: "deny",
        detail: { reason: "confirmRequired" },
      });
      sendJson(response, 412, {
        error: "confirmation_required",
        message:
          "Erase requires ?confirm=yes in production. Add the query parameter and retry.",
      });
      return;
    }
    validateTenantId(rawTenant);
    const tenantId = normalizeTenantId(rawTenant);
    try {
      strictAudit({
        action: "compliance.dataSubject.erase",
        target: userId,
        outcome: "allow",
        detail: { tenantId },
      });
      const report = await eraseDataSubject(store, tenantId, userId);
      sendJson(response, 200, report);
    } catch (error) {
      if (!(error instanceof AdminAuditWriteError)) {
        strictAudit({
          action: "compliance.dataSubject.erase",
          target: userId,
          outcome: "error",
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
    return;
  }

  if (request.method === "GET" && sub === "compliance/manifest") {
    sendJson(response, 200, {
      audit: {
        table: "admin_audit_log",
        hashChained: true,
        verifyEndpoint: "/_frick/admin/compliance/audit/verify",
      },
      dataSubject: {
        exportEndpoint: "/_frick/admin/data-subject",
        eraseEndpoint: "/_frick/admin/data-subject/erase",
      },
      retention: {
        idempotencyKeysDefaultMs: DEFAULT_IDEMPOTENCY_KEY_RETENTION_MS,
        perTenantOverrides: "via tenant_settings (see per-tenant slice)",
      },
    });
    return;
  }

  if (request.method === "GET" && sub === "compliance/audit/verify") {
    const result = await store.adminAudit.verifyChain();
    const status = result.valid ? 200 : 409;
    sendJson(response, status, result);
    return;
  }

  const pushApnsMatch = /^tenants\/([^/]+)\/push\/apns$/.exec(sub);
  if (request.method === "PUT" && pushApnsMatch) {
    const tenantId = decodeURIComponent(pushApnsMatch[1]!);
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      const creds: ApnsCredentials = {
        keyId: requireString(body.keyId, "keyId"),
        teamId: requireString(body.teamId, "teamId"),
        bundleId: requireString(body.bundleId, "bundleId"),
        privateKeyPem: requireString(body.privateKeyPem, "privateKeyPem"),
        ...(typeof body.useSandbox === "boolean" ? { useSandbox: body.useSandbox } : {}),
      };
      const result = await saveApnsCredentials(store.tenantSettings, tenantId, creds);
      if (!result.ok) {
        sendPushCredentialError(response, result.error);
        return;
      }
      audit({ action: "push.apns.credentials.set", target: tenantId, outcome: "allow" });
      response.writeHead(204);
      response.end();
    } catch (error) {
      audit({
        action: "push.apns.credentials.set",
        target: tenantId,
        outcome: "error",
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    return;
  }

  const pushFcmMatch = /^tenants\/([^/]+)\/push\/fcm$/.exec(sub);
  if (request.method === "PUT" && pushFcmMatch) {
    const tenantId = decodeURIComponent(pushFcmMatch[1]!);
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      const creds: FcmCredentials = {
        projectId: requireString(body.projectId, "projectId"),
        clientEmail: requireString(body.clientEmail, "clientEmail"),
        privateKey: requireString(body.privateKey, "privateKey"),
        ...(typeof body.tokenUri === "string" && body.tokenUri.length > 0
          ? { tokenUri: body.tokenUri }
          : {}),
      };
      const result = await saveFcmCredentials(store.tenantSettings, tenantId, creds);
      if (!result.ok) {
        sendPushCredentialError(response, result.error);
        return;
      }
      audit({ action: "push.fcm.credentials.set", target: tenantId, outcome: "allow" });
      response.writeHead(204);
      response.end();
    } catch (error) {
      audit({
        action: "push.fcm.credentials.set",
        target: tenantId,
        outcome: "error",
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    return;
  }

  const pushWebPushMatch = /^tenants\/([^/]+)\/push\/webpush$/.exec(sub);
  if (request.method === "PUT" && pushWebPushMatch) {
    const tenantId = decodeURIComponent(pushWebPushMatch[1]!);
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      const creds: WebPushCredentials = {
        subject: requireString(body.subject, "subject"),
        publicKey: requireString(body.publicKey, "publicKey"),
        privateKey: requireString(body.privateKey, "privateKey"),
      };
      const result = await saveWebPushCredentials(store.tenantSettings, tenantId, creds);
      if (!result.ok) {
        sendPushCredentialError(response, result.error);
        return;
      }
      audit({ action: "push.webPush.credentials.set", target: tenantId, outcome: "allow" });
      response.writeHead(204);
      response.end();
    } catch (error) {
      audit({
        action: "push.webPush.credentials.set",
        target: tenantId,
        outcome: "error",
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    return;
  }

  if (request.method === "POST" && sub === "schema/lint") {
    try {
      const body = await readJsonBody(request, maxBodyBytes);
      const previous = body.previous;
      const result =
        previous === undefined
          ? lintSchema(store.schema)
          : lintSchemaChange(store.schema, previous as FrickSchema);
      audit({
        action: "schema.lint",
        outcome: "allow",
        detail: {
          mode: previous === undefined ? "single" : "change",
          findings: result.findings.length,
          breaking: result.breakingCount,
        },
      });
      sendJson(response, 200, result);
    } catch (error) {
      audit({
        action: "schema.lint",
        outcome: "error",
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function sessionTokenFromRequest(request: http.IncomingMessage, url: URL): string | undefined {
  void url;
  const bearer = bearerTokenFromRequest(request);
  return bearer ?? headerValue(request, "x-frick-session-token") ?? undefined;
}

function bearerTokenFromRequest(request: http.IncomingMessage): string | undefined {
  const auth = headerValue(request, "authorization");
  return /^Bearer\s+(.+)$/i.exec(auth ?? "")?.[1];
}

function isProtectedPath(pathname: string): boolean {
  return (
    pathname === "/objects" ||
    pathname.startsWith("/objects/") ||
    pathname === "/projections" ||
    pathname.startsWith("/projections/") ||
    pathname === "/blobs" ||
    pathname.startsWith("/blobs/") ||
    pathname === "/signals" ||
    pathname.startsWith("/signals/") ||
    pathname === "/analytics/events" ||
    pathname === "/account" ||
    pathname === "/account/export" ||
    pathname === "/streams" ||
    pathname.startsWith("/streams/") ||
    pathname === "/append" ||
    pathname === "/push/registrations" ||
    pathname.startsWith("/push/registrations/") ||
    pathname === "/search" ||
    pathname === "/share/invite" ||
    pathname === "/share/accept" ||
    pathname === "/share/grants" ||
    pathname.startsWith("/share/grants/")
  );
}

/**
 * Validate the `filter` field on a `POST /search` body. Only flat
 * `Record<string, string | number>` is accepted — nested objects, arrays,
 * and booleans are rejected so the SQLite adapter's `json_extract(...)`
 * lookup never has to coerce.
 */
function parseSearchFilter(value: unknown, limits: FrickLimits): Record<string, string | number> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("filter must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > limits.maxSearchFilterFields) {
    throw new FrickLimitError({
      limit: "maxSearchFilterFields",
      actualValue: entries.length,
      configuredMax: limits.maxSearchFilterFields,
    });
  }
  const out: Record<string, string | number> = {};
  for (const [key, raw] of entries) {
    assertSearchFilterKey(key, limits.maxSearchFilterKeyBytes);
    if (isReservedSearchField(key)) {
      throw new Error(`filter.${key} is reserved`);
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      throw new Error(`filter.${key} must be a finite number`);
    }
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new Error(`filter.${key} must be a string or number`);
    }
    assertSearchFilterValueWithinLimit(raw, limits.maxSearchFilterValueBytes);
    out[key] = raw;
  }
  return out;
}

function assertSearchTextWithinLimit(value: string, maxBytes: number): void {
  const actualValue = Buffer.byteLength(value, "utf8");
  if (actualValue > maxBytes) {
    throw new FrickLimitError({
      limit: "maxSearchQueryBytes",
      actualValue,
      configuredMax: maxBytes,
    });
  }
}

function assertSearchFilterKey(key: string, maxBytes: number): void {
  const actualValue = Buffer.byteLength(key, "utf8");
  if (actualValue > maxBytes) {
    throw new FrickLimitError({
      limit: "maxSearchFilterKeyBytes",
      actualValue,
      configuredMax: maxBytes,
    });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("filter key has invalid shape");
  }
}

function assertSearchFilterValueWithinLimit(value: string | number, maxBytes: number): void {
  const actualValue = Buffer.byteLength(String(value), "utf8");
  if (actualValue > maxBytes) {
    throw new FrickLimitError({
      limit: "maxSearchFilterValueBytes",
      actualValue,
      configuredMax: maxBytes,
    });
  }
}

function parseStreamPageLimit(value: string | null, defaultLimit: number, configuredMax: number): number {
  const max = Math.max(1, Math.floor(configuredMax));
  if (value === null) {
    return Math.max(1, Math.min(max, Math.floor(defaultLimit)));
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Math.min(max, Math.floor(defaultLimit)));
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

async function filterSearchResultForPrincipal(
  result: FrickSearchResult,
  def: FrickSearchIndexDefinition,
  principal: Principal,
  store: FrickStore,
  policyHooks?: readonly FrickPolicyHook[],
  grantLookup?: FrickGrantLookup,
  cascadeGrantLookup?: FrickCascadeGrantLookup,
): Promise<FrickSearchResult> {
  if (principal.scope === "admin") {
    const hits = result.hits.map(stripSearchSourceFields);
    return { hits, total: result.total };
  }
  const visibilityFlags = await Promise.all(
    result.hits.map((hit) => {
      switch (def.source.kind) {
        case "object":
          return isSearchObjectHitVisible(
            hit,
            def.source.type,
            principal,
            store,
            policyHooks,
            grantLookup,
          );
        case "stream":
          return isSearchStreamHitVisible(
            hit,
            def.source.type,
            principal,
            store,
            policyHooks,
            cascadeGrantLookup,
          );
        case "projection":
          return isSearchProjectionHitVisible(
            hit,
            def.source.name,
            principal,
            store,
            policyHooks,
            cascadeGrantLookup,
          );
        default:
          return Promise.resolve(false);
      }
    }),
  );
  const hits = result.hits
    .filter((_, i) => visibilityFlags[i])
    .map(stripSearchSourceFields);
  return { hits, total: hits.length };
}

async function isSearchObjectHitVisible(
  hit: FrickSearchResult["hits"][number],
  type: string,
  principal: Principal,
  store: FrickStore,
  policyHooks?: readonly FrickPolicyHook[],
  grantLookup?: FrickGrantLookup,
): Promise<boolean> {
  const source = searchSourceFromHit(hit);
  const objectId =
    source.kind === "object" && source.type === type && source.id ? source.id : hit.docId;
  const object = await store.readObject(principal.tenantId, type, objectId);
  if (object === undefined) {
    return false;
  }
  // Tenant-wide store visibility is the first cut (allow-all today). FR-71 then
  // applies the same per-record read pipeline the object subscription/HTTP read
  // paths use (FR-116): app policy hooks may tighten the allow to a deny, and a
  // sharing grant on this record relaxes a remaining deny back to allow for its
  // grantee — so a shared record surfaces through search exactly as it does
  // through a direct read, and a revoked/left grant immediately hides it again.
  if (!store.isObjectVisibleToUser(principal.tenantId, type, object, principal.userId)) {
    return false;
  }
  return canSubscriberReadObjectRecord(
    principal,
    type,
    objectId,
    tenantMembershipReader(store, principal.tenantId),
    policyHooks,
    grantLookup,
  );
}

async function isSearchStreamHitVisible(
  hit: FrickSearchResult["hits"][number],
  stream: string,
  principal: Principal,
  store: FrickStore,
  policyHooks?: readonly FrickPolicyHook[],
  cascadeGrantLookup?: FrickCascadeGrantLookup,
): Promise<boolean> {
  const source = searchSourceFromHit(hit);
  const streamId =
    source.kind === "stream" && source.type === stream && source.id
      ? source.id
      : typeof hit.fields.conversationId === "string"
        ? hit.fields.conversationId
        : undefined;

  if (!streamId) {
    return false;
  }

  try {
    // Same cascade lookup the stream subscribe/read paths use (FR-70): a grant
    // on the object record whose id == streamId relaxes an owner-only deny so a
    // grantee finds the shared record's stream events through search too.
    await assertCanSubscribe(
      principal,
      "stream",
      stream,
      streamId,
      tenantMembershipReader(store, principal.tenantId),
      policyHooks,
      cascadeGrantLookup,
    );
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) return false;
    throw error;
  }
}

async function isSearchProjectionHitVisible(
  hit: FrickSearchResult["hits"][number],
  projection: string,
  principal: Principal,
  store: FrickStore,
  policyHooks?: readonly FrickPolicyHook[],
  cascadeGrantLookup?: FrickCascadeGrantLookup,
): Promise<boolean> {
  const source = searchSourceFromHit(hit);
  const key = source.kind === "projection" && source.type === projection ? source.id : undefined;
  if (!key) {
    return false;
  }
  // Projection hits stay deny-by-default for search: the `projection.read`
  // baseline is tenant-wide allow, so `assertCanSubscribe` cannot fail closed on
  // its own. We only surface a projection hit when an app policy hook proves
  // visibility, OR — FR-71 — when the principal holds an active sharing grant on
  // the record whose id == the projection key (the same cascade the projection
  // subscribe path uses, FR-70). A revoked/left grant immediately removes the
  // hit again because the lookup is evaluated per query.
  if (cascadeGrantLookup) {
    const cascaded = await cascadeGrantLookup({
      tenantId: principal.tenantId,
      granteeUserId: principal.userId,
      recordId: key,
    });
    if (cascaded) {
      return true;
    }
  }
  if (!policyHooks || policyHooks.length === 0) {
    return false;
  }
  try {
    await assertCanSubscribe(
      principal,
      "projection",
      projection,
      key,
      tenantMembershipReader(store, principal.tenantId),
      policyHooks,
      cascadeGrantLookup,
    );
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) return false;
    throw error;
  }
}

/**
 * Build an async iterable of {@link FrickSearchProjectInput} rows over a
 * search index's declared source primitive for the admin rebuild route.
 * - `object` sources iterate `store.listObjects(tenantId, type)`.
 * - `stream` sources iterate `store.streams.listAllByStreamType(tenantId, type)`.
 * Projection sources are rejected by the admin rebuild route before this
 * iterator is constructed. Projections own their storage shape, so a generic
 * iterator cannot enumerate rows safely in v1.
 */
async function* sourceIterableForIndex(
  store: FrickStore,
  def: FrickSearchIndexDefinition,
  tenantId: string,
): AsyncGenerator<FrickSearchProjectInput, void, void> {
  if (def.source.kind === "object") {
    for (const value of await store.listObjects(tenantId, def.source.type)) {
      const id = typeof value.id === "string" ? value.id : "";
      yield {
        tenantId,
        object: { type: def.source.type, id, value },
      };
    }
    return;
  }
  if (def.source.kind === "stream") {
    for (const event of await store.streams.listAllByStreamType(tenantId, def.source.type)) {
      yield {
        tenantId,
        streamEvent: {
          stream: event.stream,
          streamId: event.streamId,
          sequence: event.sequence,
          eventId: event.eventId,
          event: event.event,
          payload: event.payload,
        },
      };
    }
    return;
  }
}

function parsePlatform(platform: string): "web" | "ios" | "android" | "server" {
  if (platform === "web" || platform === "ios" || platform === "android" || platform === "server") {
    return platform;
  }
  throw new Error("platform must be one of web, ios, android, server");
}

async function createSessionForUser(
  store: FrickStore,
  userId: string,
  deviceId: string,
  replicaId: string,
  platform: "web" | "ios" | "android" | "server",
  config: FrickConfig,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<StoredSession> {
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
  const sessionToken = randomToken(32);
  void platform;
  return store.createSession({ sessionToken, userId, deviceId, replicaId, expiresAt, tenantId });
}

function authSessionResponse(store: FrickStore, session: StoredSession, account: StoredAccount): Record<string, unknown> {
  return {
    schemaHash: store.schema.hash,
    sessionToken: session.sessionToken,
    tenantId: session.tenantId,
    userId: session.userId,
    displayName: account.displayName,
    handle: account.handle,
    deviceId: session.deviceId,
    replicaId: session.replicaId,
    expiresAt: session.expiresAt,
  };
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim().replace(/\s+/g, " ");
  if (displayName.length < 2 || displayName.length > 80) {
    throw new Error("displayName must be between 2 and 80 characters");
  }
  return displayName;
}

function normalizeHandle(value: string): string {
  const handle = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/.test(handle)) {
    throw new Error("handle must be 3-32 lowercase letters, numbers, underscores, or dashes");
  }
  return handle;
}

function normalizePassword(value: string): string {
  if (value.length < 8 || value.length > 256) {
    throw new Error("password must be between 8 and 256 characters");
  }
  return value;
}

function userIdFromHandle(tenantId: string, handle: string): string {
  // user-id PK is global across tenants; namespace non-default tenants so
  // the same handle in two tenants resolves to distinct user ids without
  // changing the auth_accounts primary key shape.
  const base = handle.replace(/_/g, "-");
  return tenantId === DEFAULT_TENANT_ID ? `user-${base}` : `user-${tenantId}-${base}`;
}

function devHandleFromUserId(userId: string): string {
  return normalizeHandle(userId.replace(/^user-/, "").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 32) || "dev-user");
}

function randomToken(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}
