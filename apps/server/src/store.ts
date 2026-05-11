import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encode } from "@msgpack/msgpack";
import { foundationSchema, validateSchema, type FrickSchema, type PlainObject } from "@frick/protocol";
import { AccountStore, type StoredAccount } from "./storage/account-store.js";
import { AdminAuditStore } from "./storage/admin-audit-store.js";
import { BlobStore, type BlobMetadata, type BlobMetadataInput } from "./storage/blob-store.js";
import { InboxStore, type ConversationInboxRow } from "./storage/inbox-store.js";
import { JobStore, type StoredJob } from "./storage/job-store.js";
import { ObjectStore } from "./storage/object-store.js";
import { PresenceStore } from "./storage/presence-store.js";
import { initializeStorage } from "./storage/schema.js";
import { SessionStore, type StoredSession } from "./storage/session-store.js";
import { TenantStore } from "./storage/tenant-store.js";
import { SignalStore } from "./storage/signal-store.js";
import { StreamStore, type AppendInput, type AppendResult, type StoredEvent } from "./storage/stream-store.js";
import { BoundedIdempotencyCache } from "./storage/idempotency-cache.js";
import { listAppliedMigrations, type AppliedMigrationRow } from "./storage/migrations.js";
import { createNoopLogger, type FrickLogger } from "./logger.js";
import {
  createFrickProjectionRegistry,
  type FrickProjectionContext,
  type FrickProjectionRegistry,
  type FrickProjectionWriteEvent,
} from "./projections/registry.js";
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
   * Projection registry that receives notify(...) calls after every
   * object/stream write through this FrickStore facade. When omitted, the
   * store constructs an empty registry — callers (typically
   * `createFrickServer`) can register projections via `store.projections`
   * before issuing writes.
   */
  projections?: FrickProjectionRegistry;
  /**
   * Logger threaded into projection contexts so handler failures surface
   * through the same structured-logging pipeline as the rest of the server.
   * Defaults to a no-op logger.
   */
  logger?: FrickLogger;
}

export interface CreatedConversation {
  conversation: PlainObject;
  member: PlainObject;
  members: PlainObject[];
}

export class FrickStore {
  readonly schema: FrickSchema;
  readonly objects: ObjectStore;
  // `streams` and `idempotencyCache` are rebuilt by `prune()` when an
  // age-based sweep removes durable rows: the in-memory LRU may still hold
  // stale `(tenantId, replicaId, requestId)` mappings that — after retention
  // — must not satisfy a retry. Rebuilding both together swaps a fresh cache
  // into the StreamStore without violating the cache module's encapsulation.
  streams: StreamStore;
  idempotencyCache: BoundedIdempotencyCache<StoredEvent>;
  readonly presence: PresenceStore;
  readonly signals: SignalStore;
  readonly blobs: BlobStore;
  readonly inbox: InboxStore;
  readonly jobs: JobStore;
  readonly sessions: SessionStore;
  readonly accounts: AccountStore;
  readonly tenants: TenantStore;
  readonly adminAudit: AdminAuditStore;
  readonly projections: FrickProjectionRegistry;
  readonly #logger: FrickLogger;

  readonly #db: DatabaseSync;
  readonly #idempotencyCacheCapacity: number;
  readonly #idempotencyKeyRetentionMs: number;
  readonly #idempotencyKeyMaxRows: number;
  #pruneTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

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

    this.idempotencyCache = new BoundedIdempotencyCache<StoredEvent>(
      this.#idempotencyCacheCapacity,
    );
    this.objects = new ObjectStore(this.#db, this.schema);
    this.streams = new StreamStore(this.#db, this.schema, this.idempotencyCache);
    this.presence = new PresenceStore(this.#db, this.schema);
    this.signals = new SignalStore(this.#db, this.schema);
    this.blobs = new BlobStore(this.#db);
    this.inbox = new InboxStore(this.#db);
    this.jobs = new JobStore(this.#db);
    this.sessions = new SessionStore(this.#db);
    this.accounts = new AccountStore(this.#db);
    this.tenants = new TenantStore(this.#db);
    this.adminAudit = new AdminAuditStore(this.#db);
    this.projections = options.projections ?? createFrickProjectionRegistry();
    this.#logger = options.logger ?? createNoopLogger();
    this.inbox.repairInvalidReadCursors();

    if (options.seed ?? true) {
      this.seedFoundation();
    }

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
    this.#db.close();
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
    const cutoffIso = new Date(Date.now() - this.#idempotencyKeyRetentionMs).toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    let prunedByAge = 0;
    let prunedByCap = 0;
    try {
      const ageResult = this.#db
        .prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
        .run(cutoffIso);
      prunedByAge = Number(ageResult.changes ?? 0);

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
      this.idempotencyCache = new BoundedIdempotencyCache<StoredEvent>(
        this.#idempotencyCacheCapacity,
      );
      this.streams = new StreamStore(this.#db, this.schema, this.idempotencyCache);
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

  seedFoundation(): void {
    // Default tenant only — the seed exists to give a fresh dev database
    // something to read.
    this.upsertObject("User", "user-ada", {
      displayName: "Ada Lovelace",
      avatarBlobId: undefined,
    });
    this.upsertObject("User", "user-grace", {
      displayName: "Grace Hopper",
      avatarBlobId: undefined,
    });
    this.upsertObject("Conversation", "conversation-general", {
      kind: "channel",
      title: "Foundation General",
      createdBy: "user-ada",
      lastMessageEventId: undefined,
    });
    this.upsertObject("RoomMember", "member-general-ada", {
      conversationId: "conversation-general",
      userId: "user-ada",
      role: "owner",
    });
    this.upsertObject("RoomMember", "member-general-grace", {
      conversationId: "conversation-general",
      userId: "user-grace",
      role: "member",
    });
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
      this.#notifyProjections({
        kind: "objectUpsert",
        tenantId,
        objectType: type,
        objectId: id,
        object: this.objects.read(tenantId, type, id) ?? value,
      });
      return;
    }
    // 4-arg form: (type, id, value, version?)
    const type = a;
    const id = b as string;
    const value = c as PlainObject;
    const version = (d as number | undefined) ?? 0;
    this.objects.upsert(DEFAULT_TENANT_ID, type, id, value, version);
    this.#notifyProjections({
      kind: "objectUpsert",
      tenantId: DEFAULT_TENANT_ID,
      objectType: type,
      objectId: id,
      object: this.objects.read(DEFAULT_TENANT_ID, type, id) ?? value,
    });
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
    if (type === "Conversation") {
      return typeof object.id === "string" && this.isRoomMember(tenantId, object.id, userId);
    }
    if (type === "RoomMember") {
      return (
        typeof object.conversationId === "string" &&
        this.isRoomMember(tenantId, object.conversationId, userId)
      );
    }
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
    }
    return result;
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

  readEvents(stream: string, streamId: string, after: number): StoredEvent[];
  readEvents(tenantId: string, stream: string, streamId: string, after: number): StoredEvent[];
  readEvents(a: string, b: string, c: string | number, d?: number): StoredEvent[] {
    if (d !== undefined) {
      return this.streams.read(a, b, c as string, d);
    }
    return this.streams.read(DEFAULT_TENANT_ID, a, b, c as number);
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

  listInbox(userId: string): ConversationInboxRow[];
  listInbox(tenantId: string, userId: string): ConversationInboxRow[];
  listInbox(a: string, b?: string): ConversationInboxRow[] {
    if (b !== undefined) {
      return this.inbox.listForUser(a, b);
    }
    return this.inbox.listForUser(DEFAULT_TENANT_ID, a);
  }

  isRoomMember(conversationId: string, userId: string): boolean;
  isRoomMember(tenantId: string, conversationId: string, userId: string): boolean;
  isRoomMember(a: string, b: string, c?: string): boolean {
    const tenantId = c !== undefined ? a : DEFAULT_TENANT_ID;
    const conversationId = c !== undefined ? b : a;
    const userId = c !== undefined ? c : b;
    return this.listRoomMembers(tenantId, conversationId).some((member) => member.userId === userId);
  }

  hasConversation(conversationId: string): boolean;
  hasConversation(tenantId: string, conversationId: string): boolean;
  hasConversation(a: string, b?: string): boolean {
    if (b !== undefined) {
      return this.readObject(a, "Conversation", b) !== undefined;
    }
    return this.readObject(DEFAULT_TENANT_ID, "Conversation", a) !== undefined;
  }

  hasUser(userId: string): boolean;
  hasUser(tenantId: string, userId: string): boolean;
  hasUser(a: string, b?: string): boolean {
    if (b !== undefined) {
      return this.readObject(a, "User", b) !== undefined;
    }
    return this.readObject(DEFAULT_TENANT_ID, "User", a) !== undefined;
  }

  createAccountUser(input: {
    userId: string;
    handle: string;
    displayName: string;
    password: string;
    tenantId?: string;
  }): StoredAccount {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    if (this.hasUser(tenantId, input.userId)) {
      throw new Error("Handle is already taken");
    }

    const account = this.accounts.create({
      tenantId,
      userId: input.userId,
      handle: input.handle,
      displayName: input.displayName,
      password: input.password,
    });
    this.upsertObject(tenantId, "User", input.userId, {
      displayName: input.displayName,
      avatarBlobId: undefined,
    });
    // Auto-membership in the seeded `conversation-general` only applies in
    // the default tenant. New tenants start empty — apps create their own
    // conversations via /conversations.
    if (tenantId === DEFAULT_TENANT_ID) {
      this.upsertObject(
        tenantId,
        "RoomMember",
        `member-general-${input.userId.replace(/^user-/, "")}`,
        {
          conversationId: "conversation-general",
          userId: input.userId,
          role: "member",
        },
      );
    }
    return account;
  }

  createConversation(input: {
    conversationId: string;
    title?: string;
    kind: "dm" | "group" | "channel";
    createdBy: string;
    participantUserIds: string[];
    tenantId?: string;
  }): CreatedConversation {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    if (!this.hasUser(tenantId, input.createdBy)) {
      throw new Error(`Unknown user ${input.createdBy}`);
    }
    if (this.readObject(tenantId, "Conversation", input.conversationId)) {
      throw new Error(`Conversation ${input.conversationId} already exists`);
    }
    const participantUserIds = unique([input.createdBy, ...input.participantUserIds]);
    if (input.kind === "dm" && participantUserIds.length !== 2) {
      throw new Error("dm conversations must have exactly two participants");
    }
    if (participantUserIds.length < 1) {
      throw new Error("conversation must have at least one participant");
    }
    for (const userId of participantUserIds) {
      if (!this.hasUser(tenantId, userId)) {
        throw new Error(`Unknown user ${userId}`);
      }
    }

    const conversation = {
      id: input.conversationId,
      kind: input.kind,
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdBy: input.createdBy,
      lastMessageEventId: undefined,
    };
    const members = participantUserIds.map((userId) => ({
      id: memberIdFor(input.conversationId, userId),
      conversationId: input.conversationId,
      userId,
      role: userId === input.createdBy ? "owner" : "member",
    }));
    this.upsertObject(tenantId, "Conversation", input.conversationId, conversation);
    for (const member of members) {
      this.upsertObject(tenantId, "RoomMember", member.id, member);
    }
    return { conversation, member: members[0]!, members };
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

  recordUserDevice(deviceId: string, userId: string, platform: string, lastSeenAt = new Date().toISOString(), tenantId: string = DEFAULT_TENANT_ID): void {
    this.upsertObject(tenantId, "UserDevice", deviceId, {
      userId,
      platform,
      lastSeenAt,
    });
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

  private listRoomMembers(
    tenantId: string,
    conversationId: string,
  ): Array<{ id: string; conversationId: string; userId: string; role: string }> {
    return this.listObjects(tenantId, "RoomMember")
      .filter((member) => member.conversationId === conversationId && typeof member.userId === "string")
      .map((member) => ({
        id: String(member.id),
        conversationId,
        userId: member.userId as string,
        role: typeof member.role === "string" ? member.role : "member",
      }));
  }
}

function memberIdFor(conversationId: string, userId: string): string {
  return `member-${conversationId.replace(/^conversation-/, "")}-${userId.replace(/^user-/, "")}`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

