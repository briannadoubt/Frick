//! Durable platform-events driver (`SqlitePlatformEventPipeline`,
//! `apps/server/src/platform-events/sqlite.ts`).
//!
//! Backed by the migrated `platform_events` (the immutable event log) and
//! `platform_event_deliveries` (per-consumer delivery state) tables. Despite the
//! name it runs over either arm of [`SqlDriver`]: the SQLite arm serializes on a
//! single connection; the Postgres arm adds `FOR UPDATE … SKIP LOCKED` so two
//! nodes can claim disjoint batches (FR-28). All statements use `?` placeholders
//! (the Postgres arm rewrites `?`→`$n`).
//!
//! Determinism: every method takes `now_ms`; `publish` takes the caller's
//! `event_id`. The visibility timeout / retention / row-cap are config knobs.

use std::sync::Arc;

use async_trait::async_trait;

use crate::driver::{SqlDialect, SqlDriver, SqlExec, SqlRow, SqlValue};
use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

use super::{
    PlatformEventClaimOptions, PlatformEventConsumerHealth, PlatformEventDelivery,
    PlatformEventDeliveryAttempt, PlatformEventEnvelope, PlatformEventHealth, PlatformEventInput,
    PlatformEventPublishReceipt, PlatformEventsAdapter, PlatformEventsDriver, clamp_batch_size,
    decode_json_object, encode_json_object, normalize_consumer_name,
    normalize_platform_event_input,
};

/// Default retention window: 7 days (`DEFAULT_PLATFORM_EVENTS_RETENTION_MS`).
pub const DEFAULT_PLATFORM_EVENTS_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Default hard row cap (`DEFAULT_PLATFORM_EVENTS_MAX_ROWS`).
pub const DEFAULT_PLATFORM_EVENTS_MAX_ROWS: i64 = 1_000_000;
/// Default prune cadence: 15 min (`DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS`).
pub const DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS: i64 = 15 * 60 * 1000;
/// Default delivery visibility timeout: 5 min
/// (`DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS`). A delivery claimed but not
/// acked within this window becomes claimable again (at-least-once).
pub const DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS: i64 = 5 * 60 * 1000;

/// `prune` result (`SqlitePlatformEventsPruneResult`): rows dropped by each
/// sweep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PlatformEventsPruneResult {
    pub pruned_by_age: u64,
    pub pruned_by_cap: u64,
}

/// Durable platform-events driver over the `platform_events` tables.
pub struct SqlitePlatformEvents {
    sql: Arc<SqlDriver>,
    retention_ms: i64,
    max_rows: i64,
    claim_timeout_ms: i64,
}

impl SqlitePlatformEvents {
    /// Construct with the configured retention / cap / visibility-timeout knobs
    /// (the constructor in sqlite.ts). The facade resolves defaults before
    /// calling.
    #[must_use]
    pub fn new(
        sql: Arc<SqlDriver>,
        retention_ms: i64,
        max_rows: i64,
        claim_timeout_ms: i64,
    ) -> Self {
        Self {
            sql,
            retention_ms,
            max_rows,
            claim_timeout_ms,
        }
    }

    /// Construct with the default knobs.
    #[must_use]
    pub fn with_defaults(sql: Arc<SqlDriver>) -> Self {
        Self::new(
            sql,
            DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
            DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
            DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS,
        )
    }

    /// `#findByIdempotencyKey` (sqlite.ts): split on NULL tenant so both dialects
    /// run plain, portable predicates.
    async fn find_by_idempotency_key(
        &self,
        tenant_id: Option<&str>,
        idempotency_key: &str,
    ) -> Result<Option<SqlRow>, StoreError> {
        match tenant_id {
            None => {
                self.sql
                    .get(
                        "SELECT * FROM platform_events
                           WHERE idempotency_key = ? AND tenant_id IS NULL",
                        &[idempotency_key.into()],
                    )
                    .await
            }
            Some(tenant) => {
                self.sql
                    .get(
                        "SELECT * FROM platform_events
                           WHERE idempotency_key = ? AND tenant_id = ?",
                        &[idempotency_key.into(), tenant.into()],
                    )
                    .await
            }
        }
    }

    async fn count(&self, table: &str) -> Result<i64, StoreError> {
        let row = self
            .sql
            .get(&format!("SELECT COUNT(*) AS count FROM {table}"), &[])
            .await?;
        Ok(row.and_then(|row| row.i64("count")).unwrap_or(0))
    }
}

#[async_trait]
impl PlatformEventsDriver for SqlitePlatformEvents {
    fn adapter(&self) -> PlatformEventsAdapter {
        PlatformEventsAdapter::Sqlite
    }

    async fn publish(
        &self,
        input: &PlatformEventInput,
        event_id: &str,
        now_ms: i64,
    ) -> Result<PlatformEventPublishReceipt, StoreError> {
        let now_iso = iso_from_epoch_ms(now_ms);
        let normalized = normalize_platform_event_input(input, &now_iso)?;
        let accepted_at = now_iso;

        if let Some(key) = &normalized.idempotency_key
            && let Some(existing) = self
                .find_by_idempotency_key(normalized.tenant_id.as_deref(), key)
                .await?
        {
            return Ok(receipt_from_row(&existing, true));
        }

        let payload_json = encode_json_object(&normalized.payload);
        let attributes_json = encode_json_object(&normalized.attributes);
        let params: Vec<SqlValue> = vec![
            event_id.into(),
            normalized.schema_version.into(),
            accepted_at.clone().into(),
            normalized.occurred_at.clone().into(),
            normalized.family.clone().into(),
            normalized.name.clone().into(),
            normalized.source.clone().into(),
            normalized.tenant_id.clone().into(),
            normalized.account_id.clone().into(),
            normalized.subject_id.clone().into(),
            normalized.trace_id.clone().into(),
            normalized.idempotency_key.clone().into(),
            payload_json.into(),
            attributes_json.into(),
        ];

        // `INSERT … RETURNING id` returns a row, so it goes through the query
        // path (`get`), not `run` (which `execute`s and errors on a result set,
        // and Postgres exposes the generated key only via RETURNING). Mirrors
        // the admin-audit / job stores' dialect-portable pattern.
        let insert = self
            .sql
            .get(
                "INSERT INTO platform_events (
                     event_id, schema_version, accepted_at, occurred_at, family, name, source,
                     tenant_id, account_id, subject_id, trace_id, idempotency_key, payload, attributes
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   RETURNING id",
                &params,
            )
            .await;

        match insert {
            Ok(row) => Ok(PlatformEventPublishReceipt {
                id: event_id.to_string(),
                sequence: row.and_then(|row| row.i64("id")).unwrap_or(0),
                accepted_at,
                duplicate: false,
            }),
            Err(error) => {
                // A unique-index collision on (tenant, idempotency_key) raced us;
                // re-read the winner and report it as a duplicate.
                if let Some(key) = &normalized.idempotency_key
                    && let Some(existing) = self
                        .find_by_idempotency_key(normalized.tenant_id.as_deref(), key)
                        .await?
                {
                    return Ok(receipt_from_row(&existing, true));
                }
                Err(error)
            }
        }
    }

    async fn claim(
        &self,
        consumer: &str,
        options: &PlatformEventClaimOptions,
        now_ms: i64,
    ) -> Result<Vec<PlatformEventDelivery>, StoreError> {
        let name = normalize_consumer_name(consumer)?;
        let now_iso = iso_from_epoch_ms(now_ms);
        let available_at = options
            .available_at
            .clone()
            .unwrap_or_else(|| now_iso.clone());
        let claimed_at = now_iso;
        let stale_claimed_before = iso_from_epoch_ms(now_ms - self.claim_timeout_ms);
        let batch_size = clamp_batch_size(options.batch_size);
        // Multi-node safety (FR-28): lock-and-skip the eligible delivery rows on
        // Postgres so two nodes can't claim the same delivery. SQLite serializes.
        let lock_clause = if self.sql.dialect() == SqlDialect::Postgres {
            "FOR UPDATE OF d SKIP LOCKED"
        } else {
            ""
        };

        self.sql
            .transaction(move |tx| {
                let name = name.clone();
                let available_at = available_at.clone();
                let claimed_at = claimed_at.clone();
                let stale_claimed_before = stale_claimed_before.clone();
                Box::pin(async move {
                    claim_in_tx(
                        tx,
                        &name,
                        &available_at,
                        &claimed_at,
                        &stale_claimed_before,
                        batch_size,
                        lock_clause,
                    )
                    .await
                })
            })
            .await
    }

    async fn ack(
        &self,
        consumer: &str,
        event_id: &str,
        attempt: &PlatformEventDeliveryAttempt,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let name = normalize_consumer_name(consumer)?;
        self.sql
            .run(
                "UPDATE platform_event_deliveries
                   SET status = 'acked', acked_at = ?
                   WHERE consumer = ?
                     AND event_id = ?
                     AND status = 'claimed'
                     AND attempt_count = ?
                     AND claimed_at = ?",
                &[
                    iso_from_epoch_ms(now_ms).into(),
                    name.into(),
                    event_id.into(),
                    attempt.attempt.into(),
                    attempt.claimed_at.as_str().into(),
                ],
            )
            .await?;
        Ok(())
    }

    async fn retry(
        &self,
        consumer: &str,
        event_id: &str,
        attempt: &PlatformEventDeliveryAttempt,
        error: &str,
        available_at: Option<&str>,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let name = normalize_consumer_name(consumer)?;
        let available = available_at.map_or_else(|| iso_from_epoch_ms(now_ms), ToString::to_string);
        self.sql
            .run(
                "UPDATE platform_event_deliveries
                   SET status = 'retry',
                       available_at = ?,
                       claimed_at = NULL,
                       last_error = ?
                   WHERE consumer = ?
                     AND event_id = ?
                     AND status = 'claimed'
                     AND attempt_count = ?
                     AND claimed_at = ?",
                &[
                    available.into(),
                    error.into(),
                    name.into(),
                    event_id.into(),
                    attempt.attempt.into(),
                    attempt.claimed_at.as_str().into(),
                ],
            )
            .await?;
        Ok(())
    }

    async fn dead_letter(
        &self,
        consumer: &str,
        event_id: &str,
        attempt: &PlatformEventDeliveryAttempt,
        error: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        let name = normalize_consumer_name(consumer)?;
        self.sql
            .run(
                "UPDATE platform_event_deliveries
                   SET status = 'dead_lettered',
                       dead_lettered_at = ?,
                       last_error = ?
                   WHERE consumer = ?
                     AND event_id = ?
                     AND status = 'claimed'
                     AND attempt_count = ?
                     AND claimed_at = ?",
                &[
                    iso_from_epoch_ms(now_ms).into(),
                    error.into(),
                    name.into(),
                    event_id.into(),
                    attempt.attempt.into(),
                    attempt.claimed_at.as_str().into(),
                ],
            )
            .await?;
        Ok(())
    }

    async fn health(&self) -> Result<PlatformEventHealth, StoreError> {
        let retained = self.count("platform_events").await?;
        let unclaimed = self
            .sql
            .get(
                "SELECT COUNT(*) AS count
                   FROM platform_events e
                   WHERE NOT EXISTS (
                     SELECT 1 FROM platform_event_deliveries d WHERE d.event_id = e.event_id
                   )",
                &[],
            )
            .await?
            .and_then(|row| row.i64("count"))
            .unwrap_or(0);
        let aggregate = self
            .sql
            .get(
                "SELECT
                     SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
                     SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
                     SUM(CASE WHEN status = 'dead_lettered' THEN 1 ELSE 0 END) AS dead_lettered
                   FROM platform_event_deliveries",
                &[],
            )
            .await?;
        let (pending, claimed, dead_lettered) = aggregate.as_ref().map_or((0, 0, 0), |row| {
            (
                row.i64("pending").unwrap_or(0),
                row.i64("claimed").unwrap_or(0),
                row.i64("dead_lettered").unwrap_or(0),
            )
        });

        let consumer_rows = self
            .sql
            .all(
                "SELECT
                     consumer AS name,
                     SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
                     SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
                     SUM(CASE WHEN status = 'dead_lettered' THEN 1 ELSE 0 END) AS dead_lettered
                   FROM platform_event_deliveries
                   GROUP BY consumer
                   ORDER BY consumer ASC",
                &[],
            )
            .await?;
        let consumers: Vec<PlatformEventConsumerHealth> = consumer_rows
            .iter()
            .map(|row| {
                let pending = row.i64("pending").unwrap_or(0);
                let claimed = row.i64("claimed").unwrap_or(0);
                let dead_lettered = row.i64("dead_lettered").unwrap_or(0);
                PlatformEventConsumerHealth {
                    name: row.text("name").unwrap_or_default().to_string(),
                    pending,
                    claimed,
                    dead_lettered,
                    lag: pending + claimed,
                }
            })
            .collect();

        Ok(PlatformEventHealth {
            adapter: PlatformEventsAdapter::Sqlite,
            ok: true,
            pending,
            claimed,
            dead_lettered,
            retained,
            unclaimed,
            consumers,
        })
    }

    async fn prune(&self, now_ms: i64) -> Result<PlatformEventsPruneResult, StoreError> {
        let cutoff_iso = iso_from_epoch_ms(now_ms - self.retention_ms);
        let max_rows = self.max_rows;

        self.sql
            .transaction(move |tx| {
                let cutoff_iso = cutoff_iso.clone();
                Box::pin(async move { prune_in_tx(tx, &cutoff_iso, max_rows).await })
            })
            .await
    }
}

/// The body of `claim`, inside the open transaction (sqlite.ts `claim`).
async fn claim_in_tx(
    tx: &SqlExec<'_>,
    name: &str,
    available_at: &str,
    claimed_at: &str,
    stale_claimed_before: &str,
    batch_size: i64,
    lock_clause: &str,
) -> Result<Vec<PlatformEventDelivery>, StoreError> {
    // Materialize a pending delivery row for every event this consumer has not
    // seen yet. `ON CONFLICT DO NOTHING` (portable) skips already-tracked events.
    tx.run(
        "INSERT INTO platform_event_deliveries (
             consumer, event_id, status, attempt_count, available_at
           )
           SELECT ?, event_id, 'pending', 0, accepted_at
             FROM platform_events
             WHERE true
           ON CONFLICT (consumer, event_id) DO NOTHING",
        &[name.into()],
    )
    .await?;

    let select_sql = format!(
        "SELECT d.event_id AS event_id
           FROM platform_event_deliveries d
           JOIN platform_events e ON e.event_id = d.event_id
           WHERE d.consumer = ?
             AND (
               (d.status IN ('pending', 'retry') AND d.available_at <= ?)
               OR (d.status = 'claimed' AND (d.claimed_at IS NULL OR d.claimed_at <= ?))
             )
           ORDER BY e.id ASC
           LIMIT ?
           {lock_clause}"
    );
    let selected = tx
        .all(
            &select_sql,
            &[
                name.into(),
                available_at.into(),
                stale_claimed_before.into(),
                batch_size.into(),
            ],
        )
        .await?;
    let event_ids: Vec<String> = selected
        .iter()
        .filter_map(|row| row.text("event_id").map(ToString::to_string))
        .collect();
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = sql_placeholders(event_ids.len());
    let mut update_params: Vec<SqlValue> = vec![claimed_at.into(), name.into()];
    update_params.extend(event_ids.iter().map(|id| SqlValue::from(id.as_str())));
    tx.run(
        &format!(
            "UPDATE platform_event_deliveries
               SET status = 'claimed',
                   attempt_count = attempt_count + 1,
                   claimed_at = ?
               WHERE consumer = ?
                 AND event_id IN ({placeholders})"
        ),
        &update_params,
    )
    .await?;

    let mut select_params: Vec<SqlValue> = vec![name.into()];
    select_params.extend(event_ids.iter().map(|id| SqlValue::from(id.as_str())));
    let rows = tx
        .all(
            &format!(
                "SELECT
                     e.id AS id, e.event_id AS event_id, e.schema_version AS schema_version,
                     e.accepted_at AS accepted_at, e.occurred_at AS occurred_at,
                     e.family AS family, e.name AS name, e.source AS source,
                     e.tenant_id AS tenant_id, e.account_id AS account_id,
                     e.subject_id AS subject_id, e.trace_id AS trace_id,
                     e.idempotency_key AS idempotency_key, e.payload AS payload,
                     e.attributes AS attributes,
                     d.consumer AS consumer, d.attempt_count AS attempt_count,
                     d.claimed_at AS claimed_at
                   FROM platform_events e
                   JOIN platform_event_deliveries d ON d.event_id = e.event_id
                   WHERE d.consumer = ?
                     AND e.event_id IN ({placeholders})
                   ORDER BY e.id ASC"
            ),
            &select_params,
        )
        .await?;

    Ok(rows
        .iter()
        .map(|row| PlatformEventDelivery {
            event: envelope_from_row(row),
            consumer: row.text("consumer").unwrap_or_default().to_string(),
            attempt: row.i64("attempt_count").unwrap_or(0),
            claimed_at: row
                .text("claimed_at")
                .map_or_else(|| claimed_at.to_string(), ToString::to_string),
        })
        .collect())
}

/// The body of `prune`, inside the open transaction (sqlite.ts `prune`).
async fn prune_in_tx(
    tx: &SqlExec<'_>,
    cutoff_iso: &str,
    max_rows: i64,
) -> Result<PlatformEventsPruneResult, StoreError> {
    tx.run(
        "DELETE FROM platform_event_deliveries
           WHERE event_id IN (
             SELECT event_id FROM platform_events WHERE occurred_at < ?
           )",
        &[cutoff_iso.into()],
    )
    .await?;
    let age = tx
        .run(
            "DELETE FROM platform_events WHERE occurred_at < ?",
            &[cutoff_iso.into()],
        )
        .await?;
    let pruned_by_age = age.changes;

    let mut pruned_by_cap = 0_u64;
    let remaining = tx
        .get("SELECT COUNT(*) AS count FROM platform_events", &[])
        .await?
        .and_then(|row| row.i64("count"))
        .unwrap_or(0);
    let overflow = remaining - max_rows;
    if overflow > 0 {
        tx.run(
            "DELETE FROM platform_event_deliveries
               WHERE event_id IN (
                 SELECT event_id FROM platform_events
                   ORDER BY id ASC
                   LIMIT ?
               )",
            &[overflow.into()],
        )
        .await?;
        let cap = tx
            .run(
                "DELETE FROM platform_events
                   WHERE event_id IN (
                     SELECT event_id FROM platform_events
                       ORDER BY id ASC
                       LIMIT ?
                   )",
                &[overflow.into()],
            )
            .await?;
        pruned_by_cap = cap.changes;
    }

    Ok(PlatformEventsPruneResult {
        pruned_by_age,
        pruned_by_cap,
    })
}

/// `receiptFromRow` (sqlite.ts): build a (duplicate) receipt from an existing
/// row's `event_id` / `id` / `accepted_at`.
fn receipt_from_row(row: &SqlRow, duplicate: bool) -> PlatformEventPublishReceipt {
    PlatformEventPublishReceipt {
        id: row.text("event_id").unwrap_or_default().to_string(),
        sequence: row.i64("id").unwrap_or(0),
        accepted_at: row.text("accepted_at").unwrap_or_default().to_string(),
        duplicate,
    }
}

/// `envelopeFromRow` (sqlite.ts): a joined row → [`PlatformEventEnvelope`]. JSON
/// columns decode to empty maps on corruption.
fn envelope_from_row(row: &SqlRow) -> PlatformEventEnvelope {
    PlatformEventEnvelope {
        id: row.text("event_id").unwrap_or_default().to_string(),
        schema_version: row.i64("schema_version").unwrap_or(1),
        sequence: row.i64("id").unwrap_or(0),
        accepted_at: row.text("accepted_at").unwrap_or_default().to_string(),
        occurred_at: row.text("occurred_at").unwrap_or_default().to_string(),
        family: row.text("family").unwrap_or_default().to_string(),
        name: row.text("name").unwrap_or_default().to_string(),
        source: row.text("source").unwrap_or_default().to_string(),
        tenant_id: row.text("tenant_id").map(ToString::to_string),
        account_id: row.text("account_id").map(ToString::to_string),
        subject_id: row.text("subject_id").map(ToString::to_string),
        trace_id: row.text("trace_id").map(ToString::to_string),
        idempotency_key: row.text("idempotency_key").map(ToString::to_string),
        payload: decode_json_object(row.text("payload")),
        attributes: decode_json_object(row.text("attributes")),
    }
}

/// `?, ?, …` for an `IN (…)` clause of `count` placeholders.
fn sql_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}
