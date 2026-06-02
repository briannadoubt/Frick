import { randomUUID } from "node:crypto";
import { decode, encode } from "@msgpack/msgpack";
import {
  packStreamEvent,
  unpackStreamEvent,
  type FrickSchema,
  type PackedStreamEvent,
  type PlainObject,
  type StreamEventInput,
} from "@frick/protocol";
import type { IdempotencyCache } from "./idempotency-cache.js";
import type { SqlDriver } from "./sql-driver.js";

export interface AppendInput {
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
    const cacheKey = `${input.tenantId}|${input.replicaId}|${input.requestId}`;
    const cached = this.idempotencyCache?.get(cacheKey);
    if (cached && this.#withinReplayWindow(cached.createdAtMs)) {
      return { event: cached.event, created: false };
    }
    const existing = await this.readIdempotentEvent(
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
          (tenant_id, stream_type, stream_id, sequence, event_id, event_type, packed, replica_id, request_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
    // event with a fresh created_at so we don't trip the (tenant, replica,
    // request) primary key and so subsequent in-window replays dedupe to the
    // fresh event.
    await this.sql.run(
      `INSERT INTO idempotency_keys
          (tenant_id, replica_id, request_id, result_event_id, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, replica_id, request_id)
          DO UPDATE SET result_event_id = excluded.result_event_id, created_at = excluded.created_at`,
      [input.tenantId, input.replicaId, input.requestId, eventId, createdAt],
    );

    const event: StoredEvent = { ...wireEvent, tenantId: input.tenantId };
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
  async listAllByStreamType(tenantId: string, stream: string): Promise<StoredEvent[]> {
    const rows = await this.sql.all<EventRow>(
      `SELECT packed FROM stream_events
          WHERE tenant_id = ? AND stream_type = ?
          ORDER BY stream_id ASC, sequence ASC`,
      [tenantId, stream],
    );
    return rows.map((row) => ({
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
    }));
  }

  async listAll(tenantId: string): Promise<StoredEvent[]> {
    const rows = await this.sql.all<EventRow>(
      `SELECT packed FROM stream_events
          WHERE tenant_id = ?
          ORDER BY stream_type ASC, stream_id ASC, sequence ASC`,
      [tenantId],
    );
    return rows.map((row) => ({
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
    }));
  }

  async read(
    tenantId: string,
    stream: string,
    streamId: string,
    after: number,
    limit?: number,
  ): Promise<StoredEvent[]> {
    const clamped =
      limit === undefined ? undefined : Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
    const rows =
      clamped === undefined
        ? await this.sql.all<EventRow>(
            `SELECT packed FROM stream_events
                WHERE tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence > ?
                ORDER BY sequence ASC`,
            [tenantId, stream, streamId, after],
          )
        : await this.sql.all<EventRow>(
            `SELECT packed FROM stream_events
                WHERE tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence > ?
                ORDER BY sequence ASC
                LIMIT ?`,
            [tenantId, stream, streamId, after, clamped],
          );
    return rows.map((row) => ({
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
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
  ): Promise<{ headSequence: number; count: number }> {
    const row = await this.sql.get<{ head: number; count: number }>(
      `SELECT COALESCE(MAX(sequence), 0) AS head, COUNT(*) AS count
          FROM stream_events WHERE tenant_id = ? AND stream_type = ? AND stream_id = ?`,
      [tenantId, stream, streamId],
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
  ): Promise<StoredEvent[]> {
    const clamped = Math.max(1, Math.min(500, Math.floor(limit)));
    const cutoff = Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const rows = await this.sql.all<EventRow>(
      `SELECT packed FROM stream_events
          WHERE tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence < ?
          ORDER BY sequence DESC
          LIMIT ?`,
      [tenantId, stream, streamId, cutoff, clamped],
    );
    return rows
      .map((row) => ({
        ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
        tenantId,
      }))
      .reverse();
  }

  private async readIdempotentEvent(
    tenantId: string,
    replicaId: string,
    requestId: string,
  ): Promise<CachedIdempotentEvent | undefined> {
    const row = await this.sql.get<IdempotencyRow>(
      "SELECT result_event_id, created_at FROM idempotency_keys WHERE tenant_id = ? AND replica_id = ? AND request_id = ?",
      [tenantId, replicaId, requestId],
    );
    if (!row) return undefined;
    const createdAtMs = Date.parse(row.created_at);
    // Enforce the replay-window bound at lookup time, independent of any
    // durable retention/pruning: a record older than the window is treated as
    // not-seen even if its row still exists.
    if (!this.#withinReplayWindow(createdAtMs)) {
      return undefined;
    }
    const event = await this.readByEventId(tenantId, row.result_event_id);
    return event ? { event, createdAtMs } : undefined;
  }

  private async readByEventId(
    tenantId: string,
    eventId: string,
  ): Promise<StoredEvent | undefined> {
    const row = await this.sql.get<EventRow>(
      "SELECT packed FROM stream_events WHERE tenant_id = ? AND event_id = ?",
      [tenantId, eventId],
    );
    if (!row) return undefined;
    return {
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
    };
  }

  private async nextSequence(tenantId: string, stream: string, streamId: string): Promise<number> {
    const row = await this.sql.get<{ next_sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM stream_events WHERE tenant_id = ? AND stream_type = ? AND stream_id = ?`,
      [tenantId, stream, streamId],
    );
    return Number(row!.next_sequence);
  }
}
