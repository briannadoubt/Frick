import { randomUUID } from "node:crypto";
import type { SqlDriver } from "../storage/sql-driver.js";
import {
  normalizePlatformEventInput,
  type PlatformEventAckOptions,
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
export const DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

export interface SqlitePlatformEventPipelineOptions {
  readonly retentionMs: number;
  readonly maxRows: number;
  readonly claimTimeoutMs?: number;
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
  readonly #sql: SqlDriver;
  readonly #retentionMs: number;
  readonly #maxRows: number;
  readonly #claimTimeoutMs: number;
  readonly #now: () => Date;

  constructor(sql: SqlDriver, options: SqlitePlatformEventPipelineOptions) {
    this.#sql = sql;
    this.#retentionMs = options.retentionMs;
    this.#maxRows = options.maxRows;
    this.#claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
  }

  async publish(input: PlatformEventInput): Promise<PlatformEventPublishReceipt> {
    const normalized = normalizePlatformEventInput(input, this.#now);
    const acceptedAt = this.#now().toISOString();
    if (normalized.idempotencyKey) {
      const existing = await this.#findByIdempotencyKey(
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
      // `RETURNING id` so the Postgres driver can surface the generated
      // sequence via lastInsertRowid; harmless on SQLite, which also reports
      // lastInsertRowid natively.
      const result = await this.#sql.run(
        `INSERT INTO platform_events (
              event_id, schema_version, accepted_at, occurred_at, family, name, source,
              tenant_id, account_id, subject_id, trace_id, idempotency_key, payload, attributes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id`,
        [
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
        ],
      );
      return {
        id: eventId,
        sequence: Number(result.lastInsertRowid),
        acceptedAt,
        duplicate: false,
      };
    } catch (error) {
      if (normalized.idempotencyKey) {
        const existing = await this.#findByIdempotencyKey(
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
    const now = this.#now();
    const availableAt = options.availableAt ?? now.toISOString();
    const claimedAt = now.toISOString();
    const staleClaimedBefore = new Date(now.getTime() - this.#claimTimeoutMs).toISOString();
    const batchSize = clampBatchSize(options.batchSize);

    return this.#sql.transaction(async (tx) => {
      // Materialize a pending delivery row for every event this consumer has
      // not seen yet. `ON CONFLICT DO NOTHING` (portable across SQLite and
      // Postgres) skips events already tracked for this consumer.
      await tx.run(
        `INSERT INTO platform_event_deliveries (
              consumer, event_id, status, attempt_count, available_at
            )
            SELECT ?, event_id, 'pending', 0, accepted_at
              FROM platform_events
              WHERE true
            ON CONFLICT (consumer, event_id) DO NOTHING`,
        [name],
      );

      // Multi-node safety (FR-28): lock-and-skip the eligible delivery rows on
      // Postgres so two consumers on different nodes can't claim the same
      // delivery. SQLite serializes on one connection and omits the clause.
      // The lock is on the delivery rows (d), not the joined events.
      const lockClause = this.#sql.dialect === "postgres" ? "FOR UPDATE OF d SKIP LOCKED" : "";
      const selected = await tx.all<{ event_id: string }>(
        `SELECT d.event_id
            FROM platform_event_deliveries d
            JOIN platform_events e ON e.event_id = d.event_id
            WHERE d.consumer = ?
              AND (
                (d.status IN ('pending', 'retry') AND d.available_at <= ?)
                OR (d.status = 'claimed' AND (d.claimed_at IS NULL OR d.claimed_at <= ?))
              )
            ORDER BY e.id ASC
            LIMIT ?
            ${lockClause}`,
        [name, availableAt, staleClaimedBefore, batchSize],
      );
      const eventIds = selected.map((row) => row.event_id);
      if (eventIds.length === 0) {
        return [];
      }

      const placeholders = sqlPlaceholders(eventIds.length);
      await tx.run(
        `UPDATE platform_event_deliveries
            SET status = 'claimed',
                attempt_count = attempt_count + 1,
                claimed_at = ?
            WHERE consumer = ?
              AND event_id IN (${placeholders})`,
        [claimedAt, name, ...eventIds],
      );

      const rows = await tx.all<DeliveryRow>(
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
        [name, ...eventIds],
      );
      return rows.map((row) => ({
        event: envelopeFromRow(row),
        consumer: row.consumer,
        attempt: Number(row.attempt_count),
        claimedAt: row.claimed_at ?? claimedAt,
      }));
    });
  }

  async ack(
    consumer: string,
    eventId: string,
    options: PlatformEventAckOptions,
  ): Promise<void> {
    const name = normalizeConsumerName(consumer);
    await this.#sql.run(
      `UPDATE platform_event_deliveries
          SET status = 'acked', acked_at = ?
          WHERE consumer = ?
            AND event_id = ?
            AND status = 'claimed'
            AND attempt_count = ?
            AND claimed_at = ?`,
      [this.#now().toISOString(), name, eventId, options.attempt, options.claimedAt],
    );
  }

  async retry(
    consumer: string,
    eventId: string,
    options: PlatformEventRetryOptions,
  ): Promise<void> {
    const name = normalizeConsumerName(consumer);
    await this.#sql.run(
      `UPDATE platform_event_deliveries
          SET status = 'retry',
              available_at = ?,
              claimed_at = NULL,
              last_error = ?
          WHERE consumer = ?
            AND event_id = ?
            AND status = 'claimed'
            AND attempt_count = ?
            AND claimed_at = ?`,
      [
        options.availableAt ?? this.#now().toISOString(),
        options.error,
        name,
        eventId,
        options.attempt,
        options.claimedAt,
      ],
    );
  }

  async deadLetter(
    consumer: string,
    eventId: string,
    options: PlatformEventDeadLetterOptions,
  ): Promise<void> {
    const name = normalizeConsumerName(consumer);
    await this.#sql.run(
      `UPDATE platform_event_deliveries
          SET status = 'dead_lettered',
              dead_lettered_at = ?,
              last_error = ?
          WHERE consumer = ?
            AND event_id = ?
            AND status = 'claimed'
            AND attempt_count = ?
            AND claimed_at = ?`,
      [this.#now().toISOString(), options.error, name, eventId, options.attempt, options.claimedAt],
    );
  }

  async health(): Promise<PlatformEventHealth> {
    const retained = await this.#count("platform_events");
    const unclaimed = (await this.#sql.get<CountRow>(
      `SELECT COUNT(*) AS count
          FROM platform_events e
          WHERE NOT EXISTS (
            SELECT 1 FROM platform_event_deliveries d WHERE d.event_id = e.event_id
          )`,
    )) ?? { count: 0 };
    const aggregate = (await this.#sql.get<DeliveryCountsRow>(
      `SELECT
            SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
            SUM(CASE WHEN status = 'dead_lettered' THEN 1 ELSE 0 END) AS dead_lettered
          FROM platform_event_deliveries`,
    )) ?? { pending: 0, claimed: 0, dead_lettered: 0 };
    const consumers = (
      await this.#sql.all<ConsumerCountsRow>(
        `SELECT
              consumer AS name,
              SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
              SUM(CASE WHEN status = 'dead_lettered' THEN 1 ELSE 0 END) AS dead_lettered
            FROM platform_event_deliveries
            GROUP BY consumer
            ORDER BY consumer ASC`,
      )
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

  async prune(
    options: SqlitePlatformEventsPruneOptions = {},
  ): Promise<SqlitePlatformEventsPruneResult> {
    const retentionMs = options.retentionMs ?? this.#retentionMs;
    const maxRows = options.maxRows ?? this.#maxRows;
    const cutoffIso = new Date(this.#now().getTime() - retentionMs).toISOString();

    return this.#sql.transaction(async (tx) => {
      await tx.run(
        `DELETE FROM platform_event_deliveries
            WHERE event_id IN (
              SELECT event_id FROM platform_events WHERE occurred_at < ?
            )`,
        [cutoffIso],
      );
      const ageResult = await tx.run("DELETE FROM platform_events WHERE occurred_at < ?", [
        cutoffIso,
      ]);
      const prunedByAge = Number(ageResult.changes ?? 0);

      let prunedByCap = 0;
      const remaining = await tx.get<CountRow>("SELECT COUNT(*) AS count FROM platform_events");
      const overflow = Number(remaining?.count ?? 0) - maxRows;
      if (overflow > 0) {
        await tx.run(
          `DELETE FROM platform_event_deliveries
              WHERE event_id IN (
                SELECT event_id FROM platform_events
                  ORDER BY id ASC
                  LIMIT ?
              )`,
          [overflow],
        );
        const capResult = await tx.run(
          `DELETE FROM platform_events
              WHERE event_id IN (
                SELECT event_id FROM platform_events
                  ORDER BY id ASC
                  LIMIT ?
              )`,
          [overflow],
        );
        prunedByCap = Number(capResult.changes ?? 0);
      }
      return { prunedByAge, prunedByCap };
    });
  }

  async close(): Promise<void> {
    // The FrickStore owns the SqlDriver. The adapter has no separate resource
    // to close.
  }

  async #findByIdempotencyKey(
    tenantId: string | null,
    idempotencyKey: string,
  ): Promise<PlatformEventRow | undefined> {
    // SQLite's `tenant_id IS ?` NULL-safe equality is not valid in Postgres
    // (which spells it `IS NOT DISTINCT FROM`). Split on null instead so both
    // backends run plain, portable predicates.
    if (tenantId === null) {
      return this.#sql.get<PlatformEventRow>(
        `SELECT * FROM platform_events
            WHERE idempotency_key = ? AND tenant_id IS NULL`,
        [idempotencyKey],
      );
    }
    return this.#sql.get<PlatformEventRow>(
      `SELECT * FROM platform_events
          WHERE idempotency_key = ? AND tenant_id = ?`,
      [idempotencyKey, tenantId],
    );
  }

  async #count(table: "platform_events" | "platform_event_deliveries"): Promise<number> {
    const row = await this.#sql.get<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`);
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
