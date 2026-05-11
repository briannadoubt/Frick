import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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

interface IdempotencyRow {
  result_event_id: string;
}

interface EventRow {
  packed: Uint8Array;
}

export class StreamStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly schema: FrickSchema,
    private readonly idempotencyCache?: IdempotencyCache<StoredEvent>,
  ) {}

  append(input: AppendInput): AppendResult {
    const cacheKey = `${input.tenantId}|${input.replicaId}|${input.requestId}`;
    const cached = this.idempotencyCache?.get(cacheKey);
    if (cached) {
      return { event: cached, created: false };
    }
    const existing = this.readIdempotentEvent(input.tenantId, input.replicaId, input.requestId);
    if (existing) {
      this.idempotencyCache?.set(cacheKey, existing);
      return { event: existing, created: false };
    }

    const sequence = this.nextSequence(input.tenantId, input.stream, input.streamId);
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

    this.db
      .prepare(
        `INSERT INTO stream_events
          (tenant_id, stream_type, stream_id, sequence, event_id, event_type, packed, replica_id, request_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );

    this.db
      .prepare(
        `INSERT INTO idempotency_keys
          (tenant_id, replica_id, request_id, result_event_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.tenantId, input.replicaId, input.requestId, eventId, createdAt);

    const event: StoredEvent = { ...wireEvent, tenantId: input.tenantId };
    this.idempotencyCache?.set(cacheKey, event);
    return { event, created: true };
  }

  read(tenantId: string, stream: string, streamId: string, after: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT packed FROM stream_events
          WHERE tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence > ?
          ORDER BY sequence ASC`,
      )
      .all(tenantId, stream, streamId, after) as unknown as EventRow[];
    return rows.map((row) => ({
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
    }));
  }

  private readIdempotentEvent(
    tenantId: string,
    replicaId: string,
    requestId: string,
  ): StoredEvent | undefined {
    const row = this.db
      .prepare(
        "SELECT result_event_id FROM idempotency_keys WHERE tenant_id = ? AND replica_id = ? AND request_id = ?",
      )
      .get(tenantId, replicaId, requestId) as IdempotencyRow | undefined;
    return row ? this.readByEventId(tenantId, row.result_event_id) : undefined;
  }

  private readByEventId(tenantId: string, eventId: string): StoredEvent | undefined {
    const row = this.db
      .prepare(
        "SELECT packed FROM stream_events WHERE tenant_id = ? AND event_id = ?",
      )
      .get(tenantId, eventId) as EventRow | undefined;
    if (!row) return undefined;
    return {
      ...unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent),
      tenantId,
    };
  }

  private nextSequence(tenantId: string, stream: string, streamId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM stream_events WHERE tenant_id = ? AND stream_type = ? AND stream_id = ?`,
      )
      .get(tenantId, stream, streamId) as { next_sequence: number };
    return Number(row.next_sequence);
  }
}
