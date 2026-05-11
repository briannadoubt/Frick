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
  requestId: string;
  replicaId: string;
  stream: string;
  streamId: string;
  event: string;
  payload: PlainObject;
}

export interface StoredEvent extends StreamEventInput {}

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
    const cacheKey = `${input.replicaId}|${input.requestId}`;
    const cached = this.idempotencyCache?.get(cacheKey);
    if (cached) {
      return { event: cached, created: false };
    }
    const existing = this.readIdempotentEvent(input.replicaId, input.requestId);
    if (existing) {
      this.idempotencyCache?.set(cacheKey, existing);
      return { event: existing, created: false };
    }

    const sequence = this.nextSequence(input.stream, input.streamId);
    const eventId = `event-${randomUUID()}`;
    const event: StoredEvent = {
      stream: input.stream,
      streamId: input.streamId,
      sequence,
      eventId,
      event: input.event,
      payload: input.payload,
    };
    const packed = packStreamEvent(this.schema, event);
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO stream_events
          (stream_type, stream_id, sequence, event_id, event_type, packed, replica_id, request_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
          (replica_id, request_id, result_event_id, created_at)
          VALUES (?, ?, ?, ?)`,
      )
      .run(input.replicaId, input.requestId, eventId, createdAt);

    this.idempotencyCache?.set(cacheKey, event);
    return { event, created: true };
  }

  read(stream: string, streamId: string, after: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT packed FROM stream_events
          WHERE stream_type = ? AND stream_id = ? AND sequence > ?
          ORDER BY sequence ASC`,
      )
      .all(stream, streamId, after) as unknown as EventRow[];
    return rows.map((row) => unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent));
  }

  private readIdempotentEvent(replicaId: string, requestId: string): StoredEvent | undefined {
    const row = this.db
      .prepare("SELECT result_event_id FROM idempotency_keys WHERE replica_id = ? AND request_id = ?")
      .get(replicaId, requestId) as IdempotencyRow | undefined;
    return row ? this.readByEventId(row.result_event_id) : undefined;
  }

  private readByEventId(eventId: string): StoredEvent | undefined {
    const row = this.db
      .prepare("SELECT packed FROM stream_events WHERE event_id = ?")
      .get(eventId) as EventRow | undefined;
    return row ? unpackStreamEvent(this.schema, decode(row.packed) as PackedStreamEvent) : undefined;
  }

  private nextSequence(stream: string, streamId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM stream_events WHERE stream_type = ? AND stream_id = ?`,
      )
      .get(stream, streamId) as { next_sequence: number };
    return Number(row.next_sequence);
  }
}
