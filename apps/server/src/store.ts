import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encode } from "@msgpack/msgpack";
import { foundationSchema, validateSchema, type FrickSchema, type PlainObject } from "@frick/protocol";
import { AccountStore, type StoredAccount } from "./storage/account-store.js";
import { BlobStore, type BlobMetadata, type BlobMetadataInput } from "./storage/blob-store.js";
import { InboxStore, type ConversationInboxRow } from "./storage/inbox-store.js";
import { JobStore, type StoredJob } from "./storage/job-store.js";
import { ObjectStore } from "./storage/object-store.js";
import { PresenceStore } from "./storage/presence-store.js";
import { initializeStorage } from "./storage/schema.js";
import { SessionStore, type StoredSession } from "./storage/session-store.js";
import { SignalStore } from "./storage/signal-store.js";
import { StreamStore, type AppendInput, type AppendResult, type StoredEvent } from "./storage/stream-store.js";
import { BoundedIdempotencyCache } from "./storage/idempotency-cache.js";
import { listAppliedMigrations, type AppliedMigrationRow } from "./storage/migrations.js";

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
  // stale `(replicaId, requestId)` mappings that — after retention — must
  // not satisfy a retry. Rebuilding both together swaps a fresh cache into
  // the StreamStore without violating the cache module's encapsulation.
  streams: StreamStore;
  idempotencyCache: BoundedIdempotencyCache<StoredEvent>;
  readonly presence: PresenceStore;
  readonly signals: SignalStore;
  readonly blobs: BlobStore;
  readonly inbox: InboxStore;
  readonly jobs: JobStore;
  readonly sessions: SessionStore;
  readonly accounts: AccountStore;

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
   * `(replicaId, requestId)` entries whose durable backing was just deleted.
   * Returning those from the cache would defeat retention — so on any
   * age-driven prune we rebuild the cache (and the StreamStore that holds a
   * reference to it). The cap-only pass is treated the same way for
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

  upsertObject(type: string, id: string, value: PlainObject, version = 0): void {
    this.objects.upsert(type, id, value, version);
  }

  readObject(type: string, id: string): PlainObject | undefined {
    return this.objects.read(type, id);
  }

  listObjects(type: string): PlainObject[] {
    return this.objects.list(type);
  }

  listObjectsForUser(type: string, userId: string): PlainObject[] {
    return this.listObjects(type).filter((object) => this.isObjectVisibleToUser(type, object, userId));
  }

  isObjectVisibleToUser(type: string, object: PlainObject, userId: string): boolean {
    if (type === "Conversation") {
      return typeof object.id === "string" && this.isRoomMember(object.id, userId);
    }
    if (type === "RoomMember") {
      return typeof object.conversationId === "string" && this.isRoomMember(object.conversationId, userId);
    }
    return true;
  }

  appendEvent(input: AppendInput): AppendResult {
    const result = this.streams.append(input);
    if (result.created) {
      this.projectStreamEvent(result.event);
    }
    return result;
  }

  readEvents(stream: string, streamId: string, after: number): StoredEvent[] {
    return this.streams.read(stream, streamId, after);
  }

  setPresence(type: string, key: string, value: PlainObject, ttlMs: number): void {
    this.presence.set(type, key, value, ttlMs);
  }

  readPresence(type: string, key: string): PlainObject | undefined {
    return this.presence.read(type, key);
  }

  clearPresence(type: string, key: string): void {
    this.presence.clear(type, key);
  }

  enqueueSignal(type: string, key: string, value: PlainObject, ttlMs = 30_000): void {
    this.signals.enqueue(type, key, value, ttlMs);
  }

  drainSignals(type: string, key: string): PlainObject[] {
    return this.signals.drain(type, key);
  }

  createBlobMetadata(metadata: BlobMetadataInput): void {
    this.blobs.create(metadata);
  }

  readBlobMetadata(blobId: string): BlobMetadata | undefined {
    return this.blobs.read(blobId);
  }

  listBlobMetadata(ownerId?: string): BlobMetadata[] {
    return this.blobs.list(ownerId);
  }

  writeBlobContent(blobId: string, content: Uint8Array): void {
    this.blobs.writeContent(blobId, content);
  }

  readBlobContent(blobId: string): Uint8Array | undefined {
    return this.blobs.readContent(blobId);
  }

  listInbox(userId: string): ConversationInboxRow[] {
    return this.inbox.listForUser(userId);
  }

  isRoomMember(conversationId: string, userId: string): boolean {
    return this.listRoomMembers(conversationId).some((member) => member.userId === userId);
  }

  hasConversation(conversationId: string): boolean {
    return this.readObject("Conversation", conversationId) !== undefined;
  }

  hasUser(userId: string): boolean {
    return this.readObject("User", userId) !== undefined;
  }

  createAccountUser(input: {
    userId: string;
    handle: string;
    displayName: string;
    password: string;
  }): StoredAccount {
    if (this.hasUser(input.userId)) {
      throw new Error("Handle is already taken");
    }

    const account = this.accounts.create(input);
    this.upsertObject("User", input.userId, {
      displayName: input.displayName,
      avatarBlobId: undefined,
    });
    this.upsertObject("RoomMember", `member-general-${input.userId.replace(/^user-/, "")}`, {
      conversationId: "conversation-general",
      userId: input.userId,
      role: "member",
    });
    return account;
  }

  createConversation(input: {
    conversationId: string;
    title?: string;
    kind: "dm" | "group" | "channel";
    createdBy: string;
    participantUserIds: string[];
  }): CreatedConversation {
    if (!this.hasUser(input.createdBy)) {
      throw new Error(`Unknown user ${input.createdBy}`);
    }
    if (this.readObject("Conversation", input.conversationId)) {
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
      if (!this.hasUser(userId)) {
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
    this.upsertObject("Conversation", input.conversationId, conversation);
    for (const member of members) {
      this.upsertObject("RoomMember", member.id, member);
    }
    return { conversation, member: members[0]!, members };
  }

  verifyAccountPassword(identity: string, password: string): StoredAccount | undefined {
    return this.accounts.verifyPassword(identity, password);
  }

  recordUserDevice(deviceId: string, userId: string, platform: string, lastSeenAt = new Date().toISOString()): void {
    this.upsertObject("UserDevice", deviceId, {
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
  }): StoredSession {
    return this.sessions.create(input);
  }

  readActiveSession(sessionToken: string): StoredSession | undefined {
    return this.sessions.readActive(sessionToken);
  }

  readAnySession(sessionToken: string): StoredSession | undefined {
    return this.sessions.readAny(sessionToken);
  }

  enqueueJob(type: string, value: PlainObject): void {
    this.jobs.enqueue(type, value);
  }

  nextJob(type: string): StoredJob | undefined {
    return this.jobs.next(type);
  }

  #recordSchema(): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO schema_versions (schema_hash, manifest, created_at)
          VALUES (?, ?, ?)`,
      )
      .run(this.schema.hash, Buffer.from(encode(this.schema)), new Date().toISOString());
  }

  private projectStreamEvent(event: StoredEvent): void {
    if (event.stream !== "MessageStream") {
      return;
    }

    if (event.event === "MessageSent") {
      this.projectMessageSent(event);
      return;
    }

    if (event.event === "ReceiptAdvanced") {
      this.projectReceiptAdvanced(event);
    }
  }

  private projectMessageSent(event: StoredEvent): void {
    const conversationId = event.streamId;
    const senderId = stringField(event.payload.senderId);
    const body = stringField(event.payload.body);
    const createdAt = stringField(event.payload.createdAt);
    const members = this.listRoomMembers(conversationId);
    const conversation = this.readConversation(conversationId);
    const updatedAt = new Date().toISOString();

    for (const member of members) {
      const current = this.inbox.read(conversationId, member.userId);
      const requestedReadSequence = current?.readSequence ?? (member.userId === senderId ? event.sequence : 0);
      const readSequence = Math.min(requestedReadSequence, event.sequence);
      this.inbox.upsert({
        conversationId,
        userId: member.userId,
        kind: conversation.kind,
        lastSequence: event.sequence,
        readSequence,
        unreadCount: this.countUnread(conversationId, member.userId, readSequence),
        updatedAt,
        ...(conversation.title !== undefined ? { title: conversation.title } : {}),
        ...(body !== undefined ? { lastMessageBody: body } : {}),
        ...(createdAt !== undefined ? { lastMessageAt: createdAt } : {}),
        ...(senderId !== undefined ? { lastMessageSenderId: senderId } : {}),
      });
    }
  }

  private projectReceiptAdvanced(event: StoredEvent): void {
    const conversationId = event.streamId;
    const userId = stringField(event.payload.userId);
    const requestedReadSequence = numberField(event.payload.sequence);
    if (!userId) {
      return;
    }
    if (!this.isRoomMember(conversationId, userId)) {
      return;
    }

    const current = this.inbox.read(conversationId, userId);
    const latestMessage = this.latestMessage(conversationId);
    const conversation = this.readConversation(conversationId);
    const latestSequence = Math.max(current?.lastSequence ?? 0, latestMessage?.sequence ?? 0);
    if (latestSequence === 0 && !current) {
      return;
    }
    const readSequence = Math.min(Math.max(current?.readSequence ?? 0, requestedReadSequence), latestSequence);
    const lastMessageBody = current?.lastMessageBody ?? latestMessage?.body;
    const lastMessageAt = current?.lastMessageAt ?? latestMessage?.createdAt;
    const lastMessageSenderId = current?.lastMessageSenderId ?? latestMessage?.senderId;

    this.inbox.upsert({
      conversationId,
      userId,
      kind: conversation.kind,
      lastSequence: latestSequence,
      readSequence,
      unreadCount: this.countUnread(conversationId, userId, readSequence),
      updatedAt: new Date().toISOString(),
      ...(conversation.title !== undefined ? { title: conversation.title } : {}),
      ...(lastMessageBody !== undefined ? { lastMessageBody } : {}),
      ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
      ...(lastMessageSenderId !== undefined ? { lastMessageSenderId } : {}),
    });
  }

  private listRoomMembers(conversationId: string): Array<{ id: string; conversationId: string; userId: string; role: string }> {
    return this.listObjects("RoomMember")
      .filter((member) => member.conversationId === conversationId && typeof member.userId === "string")
      .map((member) => ({
        id: String(member.id),
        conversationId,
        userId: member.userId as string,
        role: typeof member.role === "string" ? member.role : "member",
      }));
  }

  private readConversation(conversationId: string): { kind: string; title?: string } {
    const conversation = this.readObject("Conversation", conversationId);
    return {
      kind: typeof conversation?.kind === "string" ? conversation.kind : "channel",
      ...(typeof conversation?.title === "string" ? { title: conversation.title } : {}),
    };
  }

  private latestMessage(conversationId: string): { sequence: number; body?: string; createdAt?: string; senderId?: string } | undefined {
    return this.readEvents("MessageStream", conversationId, 0)
      .filter((candidate) => candidate.event === "MessageSent")
      .map((candidate) => ({
        sequence: candidate.sequence,
        ...(typeof candidate.payload.body === "string" ? { body: candidate.payload.body } : {}),
        ...(typeof candidate.payload.createdAt === "string" ? { createdAt: candidate.payload.createdAt } : {}),
        ...(typeof candidate.payload.senderId === "string" ? { senderId: candidate.payload.senderId } : {}),
      }))
      .at(-1);
  }

  private countUnread(conversationId: string, userId: string, readSequence: number): number {
    return this.readEvents("MessageStream", conversationId, readSequence).filter(
      (event) => event.event === "MessageSent" && event.payload.senderId !== userId,
    ).length;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function memberIdFor(conversationId: string, userId: string): string {
  return `member-${conversationId.replace(/^conversation-/, "")}-${userId.replace(/^user-/, "")}`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
