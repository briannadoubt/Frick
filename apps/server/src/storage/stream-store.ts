import { randomUUID } from "node:crypto";
import { decode, encode } from "@msgpack/msgpack";
import {
  packStreamEvent,
  unpackStreamEvent,
  type FrickSchema,
  type PackedStreamEvent,
  type PlainObject,
  type StreamEventInput,
} from "@fricken/protocol";
import { DEFAULT_APP_ID } from "../app-id.js";
import type { IdempotencyCache } from "./idempotency-cache.js";
import type { SqlDriver } from "./sql-driver.js";

export interface AppendInput {
  /**
   * App partition (FR-37). Defaults to {@link DEFAULT_APP_ID} when omitted so
   * existing single-app callers are unaffected.
   */
  appId?: string;
  tenantId: string;
  requestId: string;
  replicaId: string;
  stream: string;
  streamId: string;
  event: string;
  payload: PlainObject;
}

export interface StoredEvent extends StreamEventInput {
  tenantId: string;
  /** App partition the event belongs to (FR-37). {@link DEFAULT_APP_ID} for
   * single-app deployments. */
  appId: string;
}

export interface AppendResult {
  event: StoredEvent;
  created: boolean;
}

/**
 * Value stored in the in-process idempotency front-cache. The `createdAtMs`
 * timestamp lets the replay-window bound be enforced against cached hits too,
 * not just durable SQLite lookups — otherwise a long-lived cache entry could
 * keep deduping a requestId past its window even after the durable row would
 * be ignored.
 */
export interface CachedIdempotentEvent {
  event: StoredEvent;
  createdAtMs: number;
}

/**
 * Options governing how the idempotency replay window is enforced on lookup.
 */
export interface IdempotencyWindowOptions {
  /**
   * Maximum age (ms) of an idempotency record for it to still be treated as
   * idempotent. A record whose `created_at` is older than `now - replayWindowMs`
   * is ignored (treated as not-seen). When undefined, no window is applied and
   * a requestId is honoured for as long as its row exists (legacy behaviour).
   */
  replayWindowMs?: number;
  /** Clock override, primarily for deterministic tests. */
  now?: () => number;
}

/**
 * Opt-in retention policy for a single stream type (FR-145). Streams are
 * source-of-truth application data, so the durable stream-store keeps every
 * event forever by default — a policy is required to prune anything.
 *
 * Cursor-safety is the operator's responsibility: set bounds comfortably larger
 * than your slowest subscriber's catch-up window, since pruned events can no
 * longer be replayed to a cursor that falls behind them.
 */
export interface StreamRetentionPolicy {
  /** Delete events whose `created_at` is older than this many ms. */
  maxAgeMs?: number;
  /** Keep only the newest N events per `(tenant, stream, streamId)`. */
  maxEvents?: number;
  /**
   * Optional tenant scope (server-storage-7). By design a stream-type retention
   * policy is SERVER-WIDE: with `tenantId` omitted, `maxAgeMs`/`maxEvents` prune
   * the stream type's events for EVERY tenant uniformly (the FR-145 operator
   * model). That global blast radius is a footgun — a single over-aggressive
   * `maxAgeMs` deletes history for all tenants of that stream type at once — so
   * an operator who wants per-tenant retention can set `tenantId` to bound the
   * DELETE to one tenant. Omit for the legacy server-wide behaviour.
   */
  tenantId?: string;
  /**
   * Optional app scope (server-storage-7). Like {@link tenantId}, narrows both
   * prune branches to a single app partition. Omit for server-wide (all apps).
   */
  appId?: string;
}

/**
 * Map of stream type name → {@link StreamRetentionPolicy}. Stream types absent
 * from the map are never pruned (the safe default).
 */
export type StreamRetentionPolicies = Record<string, StreamRetentionPolicy>;

export interface StreamRetentionPruneResult {
  prunedByAge: number;
  prunedByCount: number;
}

interface IdempotencyRow {
  result_event_id: string;
  created_at: string;
}

interface EventRow {
  packed: Uint8Array;
}

export class StreamStore {
  readonly #replayWindowMs: number | undefined;
  readonly #now: () => number;

  constructor(
    private readonly sql: SqlDriver,
    private readonly schema: FrickSchema,
    private readonly idempotencyCache?: IdempotencyCache<CachedIdempotentEvent>,
    windowOptions: IdempotencyWindowOptions = {},
  ) {
    this.#replayWindowMs =
      windowOptions.replayWindowMs !== undefined && windowOptions.replayWindowMs > 0
        ? windowOptions.replayWindowMs
        : undefined;
    this.#now = windowOptions.now ?? Date.now;
  }

  /**
   * True when `createdAtMs` falls within the configured replay window relative
   * to the current clock. Records outside the window are treated as not-seen,
   * so a beyond-window requestId is no longer deduped. With no window
   * configured, every record is in-window.
   */
  #withinReplayWindow(createdAtMs: number): boolean {
    if (this.#replayWindowMs === undefined) {
      return true;
    }
    if (!Number.isFinite(createdAtMs)) {
      // An unparseable timestamp can't be proven to be within the window, so
      // fail closed and treat it as expired rather than honour it forever.
      return false;
    }
    return this.#now() - createdAtMs <= this.#replayWindowMs;
  }

  async append(input: AppendInput): Promise<AppendResult> {
    const appId = input.appId ?? DEFAULT_APP_ID;
    const cacheKey = `${appId}|${input.tenantId}|${input.replicaId}|${input.requestId}`;
    const cached = this.idempotencyCache?.get(cacheKey);
    if (cached && this.#withinReplayWindow(cached.createdAtMs)) {
      return { event: cached.event, created: false };
    }
    const existing = await this.readIdempotentEvent(
      appId,
      input.tenantId,
      input.replicaId,
      input.requestId,
    );
    if (existing) {
      this.idempotencyCache?.set(cacheKey, existing);
      return { event: existing.event, created: false };
    }

    const sequence = await this.nextSequence(input.tenantId, input.stream, input.streamId);
    const eventId = `event-${randomUUID()}`;
    const wireEvent: StreamEventInput = {
      stream: input.stream,
      streamId: input.streamId,
      sequence,
      eventId,
      event: input.event,
      payload: input.payload,
    };
    const packed = packStreamEvent(this.schema, wireEvent);
    const createdAt = new Date().toISOString();

    await this.sql.run(
      `INSERT INTO stream_events
          (app_id, tenant_id, stream_type, stream_id, sequence, event_id, event_type, packed, replica_id, request_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        appId,
        input.tenantId,
        input.stream,
        input.streamId,
        sequence,
        eventId,
        input.event,
        Buffer.from(encode(packed)),
        input.replicaId,
        input.requestId,
        createdAt,
      ],
    );

    // Upsert, not plain insert: when a replay lands BEYOND the replay window the
    // lookup above treats it as not-seen and we mint a fresh event, but the old
    // idempotency row may still exist (the window is enforced at lookup time,
    // independent of retention/pruning). Rewrite the row to point at the new
    // event with a fresh created_at so we don't trip the
    // (app, tenant, replica, request) primary key and so subsequent in-window
    // replays dedupe to the fresh event.
    // idempotency_keys PRIMARY KEY is (app_id, tenant_id, replica_id, request_id)
    // as of migration 0023: app_id is part of the key, so two apps sharing a
    // (tenant, replica, request) tuple occupy DISTINCT rows and never clobber
    // each other's idempotency record (server-storage-2 / tenant-app-isolation-5).
    // The ON CONFLICT target is the full app-scoped PK; app_id is never rewritten
    // by another app because a conflict can only match a row of the same app.
    await this.sql.run(
      `INSERT INTO idempotency_keys
          (app_id, tenant_id, replica_id, request_id, result_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(app_id, tenant_id, replica_id, request_id)
          DO UPDATE SET result_event_id = excluded.result_event_id, created_at = excluded.created_at`,
      [appId, input.tenantId, input.replicaId, input.requestId, eventId, createdAt],
    );

    const event: StoredEvent = { ...wireEvent, tenantId: input.tenantId, appId };
    this.idempotencyCache?.set(cacheKey, { event, createdAtMs: Date.parse(createdAt) });
    return { event, created: true };
  }

  /**
   * Iterate every event for a stream type within a tenant, across all
   * `streamId`s. Exposed for rebuild paths (search-index rebuild, etc.)
   * where the caller needs to replay history without knowing the set of
   * stream ids up front. Returned events are tenant-scoped and ordered by
   * `(stream_id, sequence)`.
   */
  async listAllByStreamType(
    tenantId: string,
    stream: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<StoredEvent[]> {
    const rows = await this.sql.all<EventRow>(
      `SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ? AND stream_type = ?
          ORDER BY stream_id ASC, sequence ASC`,
      [appId, tenantId, stream],
    );
    return rows.map((row) => ({
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
      appId,
    }));
  }

  async listAll(tenantId: string, appId: string = DEFAULT_APP_ID): Promise<StoredEvent[]> {
    const rows = await this.sql.all<EventRow>(
      `SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ?
          ORDER BY stream_type ASC, stream_id ASC, sequence ASC`,
      [appId, tenantId],
    );
    return rows.map((row) => ({
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
      appId,
    }));
  }

  async read(
    tenantId: string,
    stream: string,
    streamId: string,
    after: number,
    limit?: number,
    appId: string = DEFAULT_APP_ID,
  ): Promise<StoredEvent[]> {
    const clamped =
      limit === undefined ? undefined : Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
    const rows =
      clamped === undefined
        ? await this.sql.all<EventRow>(
            `SELECT packed FROM stream_events
                WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence > ?
                ORDER BY sequence ASC`,
            [appId, tenantId, stream, streamId, after],
          )
        : await this.sql.all<EventRow>(
            `SELECT packed FROM stream_events
                WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence > ?
                ORDER BY sequence ASC
                LIMIT ?`,
            [appId, tenantId, stream, streamId, after, clamped],
          );
    return rows.map((row) => ({
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
      appId,
    }));
  }

  /**
   * Cheap cursor probe (FR-116). Returns the highest `sequence` and the total
   * event count for a stream within a tenant without unpacking any payloads,
   * backing `GET /streams/:type/:id/cursor`. An empty or unknown stream yields
   * `{ headSequence: 0, count: 0 }`.
   */
  async head(
    tenantId: string,
    stream: string,
    streamId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<{ headSequence: number; count: number }> {
    const row = await this.sql.get<{ head: number; count: number }>(
      `SELECT COALESCE(MAX(sequence), 0) AS head, COUNT(*) AS count
          FROM stream_events WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ?`,
      [appId, tenantId, stream, streamId],
    );
    return { headSequence: Number(row!.head), count: Number(row!.count) };
  }

  /**
   * Backwards-paginated read. Returns up to `limit` events whose `sequence`
   * is strictly less than `before`, ordered oldest-first so callers can
   * `[...older, ...current]` without an extra reverse. `limit` is clamped to
   * the range `[1, 500]` to keep a single page bounded.
   */
  async readBefore(
    tenantId: string,
    stream: string,
    streamId: string,
    before: number,
    limit: number,
    appId: string = DEFAULT_APP_ID,
  ): Promise<StoredEvent[]> {
    const clamped = Math.max(1, Math.min(500, Math.floor(limit)));
    const cutoff = Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const rows = await this.sql.all<EventRow>(
      `SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence < ?
          ORDER BY sequence DESC
          LIMIT ?`,
      [appId, tenantId, stream, streamId, cutoff, clamped],
    );
    return rows
      .map((row) => ({
        ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
        tenantId,
        appId,
      }))
      .reverse();
  }

  private async readIdempotentEvent(
    appId: string,
    tenantId: string,
    replicaId: string,
    requestId: string,
  ): Promise<CachedIdempotentEvent | undefined> {
    const row = await this.sql.get<IdempotencyRow>(
      "SELECT result_event_id, created_at FROM idempotency_keys WHERE app_id = ? AND tenant_id = ? AND replica_id = ? AND request_id = ?",
      [appId, tenantId, replicaId, requestId],
    );
    if (!row) return undefined;
    const createdAtMs = Date.parse(row.created_at);
    // Enforce the replay-window bound at lookup time, independent of any
    // durable retention/pruning: a record older than the window is treated as
    // not-seen even if its row still exists.
    if (!this.#withinReplayWindow(createdAtMs)) {
      return undefined;
    }
    const event = await this.readByEventId(appId, tenantId, row.result_event_id);
    return event ? { event, createdAtMs } : undefined;
  }

  private async readByEventId(
    appId: string,
    tenantId: string,
    eventId: string,
  ): Promise<StoredEvent | undefined> {
    const row = await this.sql.get<EventRow>(
      "SELECT packed FROM stream_events WHERE app_id = ? AND tenant_id = ? AND event_id = ?",
      [appId, tenantId, eventId],
    );
    if (!row) return undefined;
    return {
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
      appId,
    };
  }

  private async nextSequence(tenantId: string, stream: string, streamId: string): Promise<number> {
    // Sequence is scoped to the stream_events PRIMARY KEY
    // (tenant_id, stream_type, stream_id, sequence) — app_id is an additive
    // column (FR-36), NOT part of the key — so the next sequence must be the
    // global max across the key, independent of app_id. Were it computed
    // per-app, two apps writing the same (tenant, stream, streamId) would mint
    // the same sequence and collide on the PK. App isolation is enforced on the
    // read side: every query filters by app_id, so an app never observes
    // another app's events even though they share the sequence space. In
    // practice apps use distinct stream ids / schemas, so contention is rare;
    // the '_default' single-app case is entirely unaffected.
    const row = await this.sql.get<{ next_sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM stream_events WHERE tenant_id = ? AND stream_type = ? AND stream_id = ?`,
      [tenantId, stream, streamId],
    );
    return Number(row!.next_sequence);
  }

  /**
   * Apply opt-in per-stream retention (FR-145). Only stream types present in
   * `policies` are touched — everything else keeps its full history. For each
   * policy, `maxAgeMs` drops events older than the cutoff and `maxEvents` keeps
   * only the newest N per `(tenant, stream, streamId)`. Idempotent: re-running
   * with the same data prunes nothing further.
   *
   * server-storage-7 — BLAST RADIUS: retention is SERVER-WIDE per stream type
   * by default. A policy with `maxAgeMs`/`maxEvents` but no `tenantId`/`appId`
   * prunes the stream type's events across EVERY tenant and app uniformly (the
   * FR-145 operator model — this is invoked from a single global policy map,
   * never a request-reachable path, so it is not a cross-tenant leak). The
   * footgun is operational: one over-aggressive `maxAgeMs` value silently
   * deletes history for all tenants of that stream type at once. Validate policy
   * values before applying. An operator who wants per-tenant (or per-app)
   * retention can set `policy.tenantId` / `policy.appId`, which bounds BOTH the
   * age-based and count-based DELETE to that scope.
   */
  async pruneRetention(
    policies: StreamRetentionPolicies,
    now: () => number = this.#now,
  ): Promise<StreamRetentionPruneResult> {
    let prunedByAge = 0;
    let prunedByCount = 0;
    for (const [streamType, policy] of Object.entries(policies)) {
      // Optional tenant/app scoping (server-storage-7). When omitted the policy
      // stays server-wide; when present the DELETE is bounded to that scope.
      const scopeClauses: string[] = [];
      const scopeParams: Array<string | number> = [];
      if (policy.tenantId !== undefined) {
        scopeClauses.push("tenant_id = ?");
        scopeParams.push(policy.tenantId);
      }
      if (policy.appId !== undefined) {
        scopeClauses.push("app_id = ?");
        scopeParams.push(policy.appId);
      }
      const scopeSql = scopeClauses.length > 0 ? ` AND ${scopeClauses.join(" AND ")}` : "";

      if (policy.maxAgeMs !== undefined && policy.maxAgeMs > 0) {
        const cutoff = new Date(now() - policy.maxAgeMs).toISOString();
        const result = await this.sql.run(
          `DELETE FROM stream_events WHERE stream_type = ? AND created_at < ?${scopeSql}`,
          [streamType, cutoff, ...scopeParams],
        );
        prunedByAge += Number(result.changes ?? 0);
      }
      if (policy.maxEvents !== undefined && policy.maxEvents >= 0) {
        // Keep only the newest `maxEvents` per stream_id: delete rows whose
        // sequence is at or below (this stream_id's max sequence) - maxEvents.
        // The correlated subquery is evaluated against the pre-delete snapshot
        // on both SQLite and Postgres, so the per-stream max is stable.
        const result = await this.sql.run(
          `DELETE FROM stream_events
              WHERE stream_type = ?
                AND sequence <= (
                  SELECT MAX(s2.sequence) FROM stream_events s2
                  WHERE s2.tenant_id = stream_events.tenant_id
                    AND s2.stream_type = stream_events.stream_type
                    AND s2.stream_id = stream_events.stream_id
                ) - ?${scopeSql}`,
          [streamType, policy.maxEvents, ...scopeParams],
        );
        prunedByCount += Number(result.changes ?? 0);
      }
    }
    return { prunedByAge, prunedByCount };
  }
}
