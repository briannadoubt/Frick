import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  normalizePlatformEventInput,
  type PlatformEventClaimOptions,
  type PlatformEventDeadLetterOptions,
  type PlatformEventDelivery,
  type PlatformEventEnvelope,
  type PlatformEventHealth,
  type PlatformEventInput,
  type PlatformEventPipeline,
  type PlatformEventPublishReceipt,
  type PlatformEventRetryOptions,
} from "./types.js";

export const DEFAULT_PLATFORM_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PLATFORM_EVENTS_MAX_ROWS = 1_000_000;
export const DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

export interface SqlitePlatformEventPipelineOptions {
  readonly retentionMs: number;
  readonly maxRows: number;
  readonly now?: () => Date;
}

export interface SqlitePlatformEventsPruneOptions {
  readonly retentionMs?: number;
  readonly maxRows?: number;
}

export interface SqlitePlatformEventsPruneResult {
  readonly prunedByAge: number;
  readonly prunedByCap: number;
}

interface PlatformEventRow {
  id: number;
  event_id: string;
  schema_version: number;
  accepted_at: string;
  occurred_at: string;
  family: string;
  name: string;
  source: string;
  tenant_id: string | null;
  account_id: string | null;
  subject_id: string | null;
  trace_id: string | null;
  idempotency_key: string | null;
  payload: string;
  attributes: string;
}

interface DeliveryRow extends PlatformEventRow {
  consumer: string;
  attempt_count: number;
  claimed_at: string | null;
}

interface CountRow {
  count: number;
}

interface DeliveryCountsRow {
  pending: number | null;
  claimed: number | null;
  dead_lettered: number | null;
}

interface ConsumerCountsRow extends DeliveryCountsRow {
  name: string;
}

export class SqlitePlatformEventPipeline implements PlatformEventPipeline {
  readonly adapter = "sqlite" as const;
  readonly #db: DatabaseSync;
  readonly #retentionMs: number;
  readonly #maxRows: number;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, options: SqlitePlatformEventPipelineOptions) {
    this.#db = db;
    this.#retentionMs = options.retentionMs;
    this.#maxRows = options.maxRows;
    this.#now = options.now ?? (() => new Date());
  }

  async publish(input: PlatformEventInput): Promise<PlatformEventPublishReceipt> {
    const normalized = normalizePlatformEventInput(input, this.#now);
    const acceptedAt = this.#now().toISOString();
    if (normalized.idempotencyKey) {
      const existing = this.#findByIdempotencyKey(
        normalized.tenantId,
        normalized.idempotencyKey,
      );
      if (existing) {
        return receiptFromRow(existing, true);
      }
    }

    const eventId = randomUUID();
    const payloadJson = JSON.stringify(normalized.payload);
    const attributesJson = JSON.stringify(normalized.attributes);
    try {
      const result = this.#db
        .prepare(
          `INSERT INTO platform_events (
              event_id, schema_version, accepted_at, occurred_at, family, name, source,
              tenant_id, account_id, subject_id, trace_id, idempotency_key, payload, attributes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          normalized.schemaVersion,
          acceptedAt,
          normalized.occurredAt,
          normalized.family,
          normalized.name,
          normalized.source,
          normalized.tenantId,
          normalized.accountId,
          normalized.subjectId,
          normalized.traceId,
          normalized.idempotencyKey,
          payloadJson,
          attributesJson,
        );
      return {
        id: eventId,
        sequence: Number(result.lastInsertRowid),
        acceptedAt,
        duplicate: false,
      };
    } catch (error) {
      if (normalized.idempotencyKey) {
        const existing = this.#findByIdempotencyKey(
          normalized.tenantId,
          normalized.idempotencyKey,
        );
        if (existing) {
          return receiptFromRow(existing, true);
        }
      }
      throw error;
    }
  }

  async claim(
    consumer: string,
    options: PlatformEventClaimOptions = {},
  ): Promise<PlatformEventDelivery[]> {
    const name = normalizeConsumerName(consumer);
    const availableAt = options.availableAt ?? this.#now().toISOString();
    const claimedAt = this.#now().toISOString();
    const batchSize = clampBatchSize(options.batchSize);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO platform_event_deliveries (
              consumer, event_id, status, attempt_count, available_at
            )
            SELECT ?, event_id, 'pending', 0, accepted_at
              FROM platform_events`,
        )
        .run(name);

      const selected = this.#db
        .prepare(
          `SELECT d.event_id
            FROM platform_event_deliveries d
            JOIN platform_events e ON e.event_id = d.event_id
            WHERE d.consumer = ?
              AND d.status IN ('pending', 'retry')
              AND d.available_at <= ?
            ORDER BY e.id ASC
            LIMIT ?`,
        )
        .all(name, availableAt, batchSize) as Array<{ event_id: string }>;
      const eventIds = selected.map((row) => row.event_id);
      if (eventIds.length === 0) {
        this.#db.exec("COMMIT");
        return [];
      }

      const placeholders = sqlPlaceholders(eventIds.length);
      this.#db
        .prepare(
          `UPDATE platform_event_deliveries
            SET status = 'claimed',
                attempt_count = attempt_count + 1,
                claimed_at = ?
            WHERE consumer = ?
              AND event_id IN (${placeholders})`,
        )
        .run(claimedAt, name, ...eventIds);

      const rows = this.#db
        .prepare(
          `SELECT
              e.id, e.event_id, e.schema_version, e.accepted_at, e.occurred_at,
              e.family, e.name, e.source, e.tenant_id, e.account_id, e.subject_id,
              e.trace_id, e.idempotency_key, e.payload, e.attributes,
              d.consumer, d.attempt_count, d.claimed_at
            FROM platform_events e
            JOIN platform_event_deliveries d ON d.event_id = e.event_id
            WHERE d.consumer = ?
              AND e.event_id IN (${placeholders})
            ORDER BY e.id ASC`,
        )
        .all(name, ...eventIds) as unknown as DeliveryRow[];
      const deliveries = rows.map((row) => ({
        event: envelopeFromRow(row),
        consumer: row.consumer,
        attempt: Number(row.attempt_count),
        claimedAt: row.claimed_at ?? claimedAt,
      }));
      this.#db.exec("COMMIT");
      return deliveries;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Surface the original cause.
      }
      throw error;
    }
  }

  async ack(consumer: string, eventId: string): Promise<void> {
    const name = normalizeConsumerName(consumer);
    this.#db
      .prepare(
        `UPDATE platform_event_deliveries
          SET status = 'acked', acked_at = ?
          WHERE consumer = ? AND event_id = ? AND status = 'claimed'`,
      )
      .run(this.#now().toISOString(), name, eventId);
  }

  async retry(
    consumer: string,
    eventId: string,
    options: PlatformEventRetryOptions,
  ): Promise<void> {
    const name = normalizeConsumerName(consumer);
    this.#db
      .prepare(
        `UPDATE platform_event_deliveries
          SET status = 'retry',
              available_at = ?,
              claimed_at = NULL,
              last_error = ?
          WHERE consumer = ?
            AND event_id = ?
            AND status NOT IN ('acked', 'dead_lettered')`,
      )
      .run(options.availableAt ?? this.#now().toISOString(), options.error, name, eventId);
  }

  async deadLetter(
    consumer: string,
    eventId: string,
    options: PlatformEventDeadLetterOptions,
  ): Promise<void> {
    const name = normalizeConsumerName(consumer);
    this.#db
      .prepare(
        `UPDATE platform_event_deliveries
          SET status = 'dead_lettered',
              dead_lettered_at = ?,
              last_error = ?
          WHERE consumer = ?
            AND event_id = ?
            AND status NOT IN ('acked', 'dead_lettered')`,
      )
      .run(this.#now().toISOString(), options.error, name, eventId);
  }

  async health(): Promise<PlatformEventHealth> {
    const retained = this.#count("platform_events");
    const unclaimed = this.#db
      .prepare(
        `SELECT COUNT(*) AS count
          FROM platform_events e
          WHERE NOT EXISTS (
            SELECT 1 FROM platform_event_deliveries d WHERE d.event_id = e.event_id
          )`,
      )
      .get() as unknown as CountRow;
    const aggregate = this.#db
      .prepare(
        `SELECT
            SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
            SUM(CASE WHEN status = 'dead_lettered' THEN 1 ELSE 0 END) AS dead_lettered
          FROM platform_event_deliveries`,
      )
      .get() as unknown as DeliveryCountsRow;
    const consumers = (
      this.#db
        .prepare(
          `SELECT
              consumer AS name,
              SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
              SUM(CASE WHEN status = 'dead_lettered' THEN 1 ELSE 0 END) AS dead_lettered
            FROM platform_event_deliveries
            GROUP BY consumer
            ORDER BY consumer ASC`,
        )
        .all() as unknown as ConsumerCountsRow[]
    ).map((row) => {
      const pending = Number(row.pending ?? 0);
      const claimed = Number(row.claimed ?? 0);
      const deadLettered = Number(row.dead_lettered ?? 0);
      return {
        name: row.name,
        pending,
        claimed,
        deadLettered,
        lag: pending + claimed,
      };
    });

    return {
      adapter: this.adapter,
      ok: true,
      pending: Number(aggregate.pending ?? 0),
      claimed: Number(aggregate.claimed ?? 0),
      deadLettered: Number(aggregate.dead_lettered ?? 0),
      retained,
      unclaimed: Number(unclaimed.count ?? 0),
      consumers,
    };
  }

  prune(options: SqlitePlatformEventsPruneOptions = {}): SqlitePlatformEventsPruneResult {
    const retentionMs = options.retentionMs ?? this.#retentionMs;
    const maxRows = options.maxRows ?? this.#maxRows;
    const cutoffIso = new Date(this.#now().getTime() - retentionMs).toISOString();
    let prunedByAge = 0;
    let prunedByCap = 0;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `DELETE FROM platform_event_deliveries
            WHERE event_id IN (
              SELECT event_id FROM platform_events WHERE occurred_at < ?
            )`,
        )
        .run(cutoffIso);
      const ageResult = this.#db
        .prepare("DELETE FROM platform_events WHERE occurred_at < ?")
        .run(cutoffIso);
      prunedByAge = Number(ageResult.changes ?? 0);

      const remaining = this.#db
        .prepare("SELECT COUNT(*) AS count FROM platform_events")
        .get() as unknown as CountRow;
      const overflow = Number(remaining.count) - maxRows;
      if (overflow > 0) {
        this.#db
          .prepare(
            `DELETE FROM platform_event_deliveries
              WHERE event_id IN (
                SELECT event_id FROM platform_events
                  ORDER BY id ASC
                  LIMIT ?
              )`,
          )
          .run(overflow);
        const capResult = this.#db
          .prepare(
            `DELETE FROM platform_events
              WHERE event_id IN (
                SELECT event_id FROM platform_events
                  ORDER BY id ASC
                  LIMIT ?
              )`,
          )
          .run(overflow);
        prunedByCap = Number(capResult.changes ?? 0);
      }

      this.#db.exec("COMMIT");
      return { prunedByAge, prunedByCap };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Surface the original cause.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    // The FrickStore owns the DatabaseSync handle. The adapter has no separate
    // resource to close.
  }

  #findByIdempotencyKey(
    tenantId: string | null,
    idempotencyKey: string,
  ): PlatformEventRow | undefined {
    return this.#db
      .prepare(
        `SELECT *
          FROM platform_events
          WHERE idempotency_key = ?
            AND tenant_id IS ?`,
      )
      .get(idempotencyKey, tenantId) as PlatformEventRow | undefined;
  }

  #count(table: "platform_events" | "platform_event_deliveries"): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as CountRow | undefined;
    return Number(row?.count ?? 0);
  }
}

function receiptFromRow(
  row: Pick<PlatformEventRow, "event_id" | "id" | "accepted_at">,
  duplicate: boolean,
): PlatformEventPublishReceipt {
  return {
    id: row.event_id,
    sequence: Number(row.id),
    acceptedAt: row.accepted_at,
    duplicate,
  };
}

function envelopeFromRow(row: PlatformEventRow): PlatformEventEnvelope {
  return {
    id: row.event_id,
    schemaVersion: row.schema_version as 1,
    sequence: Number(row.id),
    acceptedAt: row.accepted_at,
    occurredAt: row.occurred_at,
    family: row.family as PlatformEventEnvelope["family"],
    name: row.name,
    source: row.source,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    subjectId: row.subject_id,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
    payload: decodeJsonObject(row.payload),
    attributes: decodeJsonObject(row.attributes) as Record<string, string | number | boolean>,
  };
}

function decodeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to an empty object for corrupt historical rows.
  }
  return {};
}

function normalizeConsumerName(consumer: string): string {
  const name = consumer.trim();
  if (name.length === 0) {
    throw new Error("platform event consumer name cannot be empty");
  }
  return name;
}

function clampBatchSize(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value) || value <= 0) return 100;
  return Math.min(1000, Math.floor(value));
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
