//! The platform-events pipeline (FR-275): an outbox / event-stream of domain
//! events with pluggable drivers, ported from `apps/server/src/platform-events/`
//! (`types.ts` + `memory.ts` + `sqlite.ts`).
//!
//! A *platform event* is a typed, immutable domain fact (analytics, telemetry,
//! audit, job/sync lifecycle, …). Producers `publish` events; named *consumers*
//! `claim` batches, process them, then `ack` / `retry` / `dead_letter`. Each
//! consumer sees every event exactly once on the happy path and at-least-once
//! under failure (a claimed-but-unacked delivery becomes claimable again after a
//! visibility timeout). The pipeline is the durable seam the analytics /
//! audit / sync workers read.
//!
//! ## Drivers (this story: memory + sqlite; kafka deferred)
//!
//! [`PlatformEventsDriver`] is the trait every backend implements. Two land
//! here:
//!   - [`MemoryPlatformEvents`](memory::MemoryPlatformEvents) — an in-process
//!     queue, the default for tests and single-node dev;
//!   - [`SqlitePlatformEvents`](sqlite::SqlitePlatformEvents) — durable, over the
//!     migrated `platform_events` / `platform_event_deliveries` tables (works on
//!     the Postgres arm of [`SqlDriver`](crate::driver::SqlDriver) too).
//!
//! Kafka / Redpanda is a documented follow-up: it needs a Kafka-client
//! dependency decision, so the driver selector in `frick-server` returns a clean
//! "not yet ported" error for `FRICK_PLATFORM_EVENTS_DRIVER=kafka` rather than a
//! stub adapter. See the `kafka =>` arm in `crate::config` / the boot wiring.
//!
//! ## Determinism (map 03 §7, "Clock"/"ids as params")
//!
//! No driver reads the system clock or generates ids internally. Every mutating
//! method takes `now_ms: i64`, and [`publish`](PlatformEventsDriver::publish)
//! takes the new event's `event_id` as a parameter — the route/facade boundary
//! is the time/random source, exactly like the sibling stores. The TS read
//! `this.now()` and called `randomUUID()` inside; the Rust port lifts both to
//! the caller so the pipeline is fully reproducible under test.

pub mod conformance;
pub mod memory;
pub mod sqlite;

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::error::StoreError;

pub use memory::MemoryPlatformEvents;
pub use sqlite::{
    DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS, DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
    DEFAULT_PLATFORM_EVENTS_PRUNE_INTERVAL_MS, DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
    PlatformEventsPruneResult, SqlitePlatformEvents,
};

/// The recognized platform-event families (`PLATFORM_EVENT_FAMILIES`,
/// types.ts:1-9). `publish` rejects any other `family`.
pub const PLATFORM_EVENT_FAMILIES: &[&str] = &[
    "analytics.user_event",
    "telemetry.client_error",
    "audit.dashboard_action",
    "jobs.lifecycle",
    "sync.lifecycle",
    "notifications.delivery",
    "dashboard.operator_action",
];

/// The pipeline adapter id, surfaced by [`PlatformEventsDriver::adapter`] and the
/// `/_frick/inspect/platform-events` report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformEventsAdapter {
    Memory,
    Sqlite,
}

impl PlatformEventsAdapter {
    /// The wire/log label (`"memory" | "sqlite"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Sqlite => "sqlite",
        }
    }
}

/// A validation failure raised by [`normalize_platform_event_input`]
/// (`PlatformEventValidationError`, types.ts). Surfaced as a
/// [`StoreError::Store`] from `publish` so the route maps it to a 4xx.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEventValidationError {
    pub message: String,
}

impl std::fmt::Display for PlatformEventValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PlatformEventValidationError {}

impl From<PlatformEventValidationError> for StoreError {
    fn from(error: PlatformEventValidationError) -> Self {
        StoreError::store(error.message)
    }
}

/// Producer-supplied input to [`PlatformEventsDriver::publish`]
/// (`PlatformEventInput`, types.ts). The optional fields default per the TS
/// `normalizePlatformEventInput`: `occurred_at` ⇒ the injected publish time,
/// the rest ⇒ SQL NULL / `{}`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlatformEventInput {
    pub family: String,
    pub name: String,
    pub source: String,
    pub tenant_id: Option<String>,
    pub account_id: Option<String>,
    pub subject_id: Option<String>,
    pub trace_id: Option<String>,
    pub idempotency_key: Option<String>,
    /// ISO-8601 occurrence time. `None` ⇒ the injected publish time (`now_ms`).
    pub occurred_at: Option<String>,
    pub payload: Map<String, Value>,
    pub attributes: Map<String, Value>,
}

/// The normalized, immutable form of an input — everything but the
/// publish-assigned `id` / `sequence` / `accepted_at` (`Omit<…>` in TS). The
/// driver fills those in to produce a [`PlatformEventEnvelope`].
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedPlatformEvent {
    pub schema_version: i64,
    pub family: String,
    pub name: String,
    pub source: String,
    pub occurred_at: String,
    pub tenant_id: Option<String>,
    pub account_id: Option<String>,
    pub subject_id: Option<String>,
    pub trace_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub payload: Map<String, Value>,
    pub attributes: Map<String, Value>,
}

/// A published, immutable platform event (`PlatformEventEnvelope`, types.ts).
/// `sequence` is the monotonic per-pipeline ordinal (the SQLite rowid / the
/// memory counter); `id` is the caller-supplied event id.
#[derive(Debug, Clone, PartialEq)]
pub struct PlatformEventEnvelope {
    pub id: String,
    pub schema_version: i64,
    pub sequence: i64,
    pub accepted_at: String,
    pub occurred_at: String,
    pub family: String,
    pub name: String,
    pub source: String,
    pub tenant_id: Option<String>,
    pub account_id: Option<String>,
    pub subject_id: Option<String>,
    pub trace_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub payload: Map<String, Value>,
    pub attributes: Map<String, Value>,
}

/// `publish` result (`PlatformEventPublishReceipt`, types.ts). `duplicate` is
/// `true` when an idempotency-key collision returned the existing event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEventPublishReceipt {
    pub id: String,
    pub sequence: i64,
    pub accepted_at: String,
    pub duplicate: bool,
}

/// A claimed delivery handed to a consumer (`PlatformEventDelivery`, types.ts).
/// `attempt` + `claimed_at` together identify *this* claim — the ack/retry/
/// dead-letter calls echo them back so a stale attempt cannot mutate a newer
/// claim.
#[derive(Debug, Clone, PartialEq)]
pub struct PlatformEventDelivery {
    pub event: PlatformEventEnvelope,
    pub consumer: String,
    pub attempt: i64,
    pub claimed_at: String,
}

/// The `(attempt, claimed_at)` fingerprint a consumer carries from
/// [`claim`](PlatformEventsDriver::claim) to its terminal call
/// (`PlatformEventDeliveryAttempt`, types.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEventDeliveryAttempt {
    pub attempt: i64,
    pub claimed_at: String,
}

impl PlatformEventDelivery {
    /// The `(attempt, claimed_at)` fingerprint of this delivery.
    #[must_use]
    pub fn attempt_fingerprint(&self) -> PlatformEventDeliveryAttempt {
        PlatformEventDeliveryAttempt {
            attempt: self.attempt,
            claimed_at: self.claimed_at.clone(),
        }
    }
}

/// Options for [`PlatformEventsDriver::claim`] (`PlatformEventClaimOptions`).
/// `batch_size` defaults to 100, clamped to `[1, 1000]`; `available_at`
/// overrides the visibility cutoff (defaults to the injected `now`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlatformEventClaimOptions {
    pub batch_size: Option<i64>,
    pub available_at: Option<String>,
}

/// Per-consumer health counts (`PlatformEventHealth.consumers[n]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEventConsumerHealth {
    pub name: String,
    pub pending: i64,
    pub claimed: i64,
    pub dead_lettered: i64,
    pub lag: i64,
}

/// The pipeline health snapshot (`PlatformEventHealth`, types.ts). Aggregate
/// counts across all consumers + the retained / unclaimed event totals + the
/// per-consumer breakdown (sorted by name).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEventHealth {
    pub adapter: PlatformEventsAdapter,
    pub ok: bool,
    pub pending: i64,
    pub claimed: i64,
    pub dead_lettered: i64,
    pub retained: i64,
    pub unclaimed: i64,
    pub consumers: Vec<PlatformEventConsumerHealth>,
}

/// The pipeline driver (`PlatformEventPipeline`, types.ts). Every mutating
/// method takes the injected `now_ms`; `publish` additionally takes the
/// caller-generated `event_id` (the determinism seam). `claim` is at-least-once:
/// a delivery claimed but not acked within the driver's visibility timeout
/// becomes claimable again.
#[async_trait]
pub trait PlatformEventsDriver: Send + Sync {
    /// The adapter id (`"memory" | "sqlite"`).
    fn adapter(&self) -> PlatformEventsAdapter;

    /// Publish an event. `event_id` is the caller-generated id assigned to a
    /// *new* event; on an idempotency-key collision the existing event is
    /// returned with `duplicate = true` and `event_id` is ignored. `now_ms`
    /// stamps `accepted_at` and the default `occurred_at`.
    async fn publish(
        &self,
        input: &PlatformEventInput,
        event_id: &str,
        now_ms: i64,
    ) -> Result<PlatformEventPublishReceipt, StoreError>;

    /// Claim a batch of deliveries for `consumer`, oldest-first by sequence.
    /// Returns pending/retry deliveries whose `available_at <= cutoff` plus any
    /// claimed-but-stale deliveries past the visibility timeout (at-least-once).
    /// Each returned delivery's `attempt` is incremented and `claimed_at` set.
    async fn claim(
        &self,
        consumer: &str,
        options: &PlatformEventClaimOptions,
        now_ms: i64,
    ) -> Result<Vec<PlatformEventDelivery>, StoreError>;

    /// Mark a delivery processed. A no-op unless the delivery is still
    /// `claimed` with the matching `(attempt, claimed_at)` — a stale attempt or
    /// a terminal delivery is ignored.
    async fn ack(
        &self,
        consumer: &str,
        event_id: &str,
        attempt: &PlatformEventDeliveryAttempt,
        now_ms: i64,
    ) -> Result<(), StoreError>;

    /// Return a delivery to the queue, available again at `available_at`
    /// (default `now`). Matching/terminal rules as [`ack`](Self::ack).
    async fn retry(
        &self,
        consumer: &str,
        event_id: &str,
        attempt: &PlatformEventDeliveryAttempt,
        error: &str,
        available_at: Option<&str>,
        now_ms: i64,
    ) -> Result<(), StoreError>;

    /// Park a poison delivery permanently for `consumer`. Matching/terminal
    /// rules as [`ack`](Self::ack).
    async fn dead_letter(
        &self,
        consumer: &str,
        event_id: &str,
        attempt: &PlatformEventDeliveryAttempt,
        error: &str,
        now_ms: i64,
    ) -> Result<(), StoreError>;

    /// The pipeline health snapshot (the `/_frick/inspect/platform-events`
    /// report).
    async fn health(&self) -> Result<PlatformEventHealth, StoreError>;

    /// Drop events older than the retention window, then trim the oldest events
    /// down to the row cap. `now_ms` derives the age cutoff. The memory driver
    /// implements this over its in-process queue; the SQLite driver over the
    /// tables. Returns the per-sweep counts.
    async fn prune(&self, now_ms: i64) -> Result<PlatformEventsPruneResult, StoreError>;
}

/// Whether `value` is a recognized platform-event family
/// (`isPlatformEventFamily`, types.ts).
#[must_use]
pub fn is_platform_event_family(value: &str) -> bool {
    PLATFORM_EVENT_FAMILIES.contains(&value)
}

/// `normalizePlatformEventInput` (types.ts): validate the family / name / source
/// and fill defaults. `now_iso` is the injected publish-time ISO string used for
/// `occurred_at` when the input omits it. Errors map to a 4xx at the route.
///
/// Name pattern: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` (a dotted, lowercase,
/// `_`-allowed identifier). Source: 1–120 chars after trimming.
pub fn normalize_platform_event_input(
    input: &PlatformEventInput,
    now_iso: &str,
) -> Result<NormalizedPlatformEvent, PlatformEventValidationError> {
    if !is_platform_event_family(&input.family) {
        return Err(PlatformEventValidationError {
            message: format!(
                "Unknown platform event family {}",
                json_quote(&input.family)
            ),
        });
    }
    let name = input.name.trim();
    if !is_valid_event_name(name) {
        return Err(PlatformEventValidationError {
            message: "platform event name must match /^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$/"
                .to_string(),
        });
    }
    let source = input.source.trim();
    if source.is_empty() || source.chars().count() > 120 {
        return Err(PlatformEventValidationError {
            message: "platform event source must be between 1 and 120 characters".to_string(),
        });
    }
    let occurred_at = input
        .occurred_at
        .clone()
        .unwrap_or_else(|| now_iso.to_string());
    Ok(NormalizedPlatformEvent {
        schema_version: 1,
        family: input.family.clone(),
        name: name.to_string(),
        source: source.to_string(),
        occurred_at,
        tenant_id: input.tenant_id.clone(),
        account_id: input.account_id.clone(),
        subject_id: input.subject_id.clone(),
        trace_id: input.trace_id.clone(),
        idempotency_key: input.idempotency_key.clone(),
        payload: input.payload.clone(),
        attributes: input.attributes.clone(),
    })
}

/// The TS `EVENT_NAME_PATTERN` test: a non-empty, dotted, lowercase identifier
/// where each `.`-separated segment matches `[a-z][a-z0-9_]*`.
fn is_valid_event_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    for segment in name.split('.') {
        let mut chars = segment.chars();
        match chars.next() {
            Some(first) if first.is_ascii_lowercase() => {}
            _ => return false,
        }
        if !chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_') {
            return false;
        }
    }
    true
}

/// Mirror `JSON.stringify(string)` for the error message: wrap in double quotes
/// with the minimal escaping the family names need (they are `[a-z._]`, so this
/// only ever quotes — escaping is defensive).
fn json_quote(value: &str) -> String {
    serde_json::Value::String(value.to_string()).to_string()
}

/// Tenant-scoped idempotency key (`idempotencyScope`, memory.ts): `tenant\0key`.
/// The NUL separator keys idempotency per `(tenant, key)` so two tenants can
/// reuse a key without colliding (the conformance "scopes idempotency keys by
/// tenant" case).
#[must_use]
pub(crate) fn idempotency_scope(tenant_id: Option<&str>, idempotency_key: &str) -> String {
    format!("{}\u{0}{}", tenant_id.unwrap_or(""), idempotency_key)
}

/// `clampBatchSize` (memory.ts / sqlite.ts): default 100, floor, clamp to
/// `[1, 1000]`. A `None` / `<= 0` value falls back to the default.
#[must_use]
pub(crate) fn clamp_batch_size(value: Option<i64>) -> i64 {
    match value {
        Some(value) if value > 0 => value.min(1000),
        _ => 100,
    }
}

/// `normalizeConsumerName` (memory.ts / sqlite.ts): trim; reject empty.
pub(crate) fn normalize_consumer_name(consumer: &str) -> Result<String, StoreError> {
    let name = consumer.trim();
    if name.is_empty() {
        return Err(StoreError::store(
            "platform event consumer name cannot be empty".to_string(),
        ));
    }
    Ok(name.to_string())
}

/// Serialize a JSON object map to a compact string for the `payload` /
/// `attributes` columns (`JSON.stringify`).
#[must_use]
pub(crate) fn encode_json_object(map: &Map<String, Value>) -> String {
    Value::Object(map.clone()).to_string()
}

/// Decode a `payload` / `attributes` column to an object map; a NULL / blank /
/// non-object / unparsable value yields an empty map (the TS `decodeJsonObject`
/// swallow-on-corrupt behavior).
#[must_use]
pub(crate) fn decode_json_object(value: Option<&str>) -> Map<String, Value> {
    value
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    fn base_input() -> PlatformEventInput {
        PlatformEventInput {
            family: "analytics.user_event".into(),
            name: "message.sent".into(),
            source: "test".into(),
            ..Default::default()
        }
    }

    #[test]
    fn rejects_unknown_family() {
        let mut input = base_input();
        input.family = "bogus.family".into();
        let error = normalize_platform_event_input(&input, "2026-01-01T00:00:00.000Z").unwrap_err();
        assert!(error.message.contains("Unknown platform event family"));
    }

    #[test]
    fn rejects_bad_event_names() {
        for bad in [
            "",
            "Message",
            "1message",
            "message..sent",
            ".message",
            "message.",
        ] {
            let mut input = base_input();
            input.name = bad.into();
            assert!(
                normalize_platform_event_input(&input, "2026-01-01T00:00:00.000Z").is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn accepts_dotted_lowercase_names() {
        for good in ["message", "message.sent", "a.b.c", "m1.s_2"] {
            let mut input = base_input();
            input.name = good.into();
            assert!(
                normalize_platform_event_input(&input, "2026-01-01T00:00:00.000Z").is_ok(),
                "{good:?} should be accepted"
            );
        }
    }

    #[test]
    fn rejects_empty_and_overlong_source() {
        let mut input = base_input();
        input.source = "   ".into();
        assert!(normalize_platform_event_input(&input, "2026-01-01T00:00:00.000Z").is_err());
        input.source = "x".repeat(121);
        assert!(normalize_platform_event_input(&input, "2026-01-01T00:00:00.000Z").is_err());
    }

    #[test]
    fn defaults_occurred_at_to_now() {
        let normalized =
            normalize_platform_event_input(&base_input(), "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(normalized.occurred_at, "2026-01-01T00:00:00.000Z");
        assert_eq!(normalized.schema_version, 1);
    }

    #[test]
    fn batch_size_clamps() {
        assert_eq!(clamp_batch_size(None), 100);
        assert_eq!(clamp_batch_size(Some(0)), 100);
        assert_eq!(clamp_batch_size(Some(-5)), 100);
        assert_eq!(clamp_batch_size(Some(10)), 10);
        assert_eq!(clamp_batch_size(Some(5000)), 1000);
    }

    #[test]
    fn idempotency_scope_separates_tenant() {
        assert_eq!(idempotency_scope(Some("t"), "k"), "t\u{0}k");
        assert_eq!(idempotency_scope(None, "k"), "\u{0}k");
        assert_ne!(
            idempotency_scope(Some("a"), "k"),
            idempotency_scope(Some("b"), "k")
        );
    }

    #[test]
    fn json_object_round_trips_and_swallows_corrupt() {
        let mut map = Map::new();
        map.insert("a".into(), Value::from(1));
        let encoded = encode_json_object(&map);
        assert_eq!(decode_json_object(Some(&encoded)), map);
        assert!(decode_json_object(Some("[1,2,3]")).is_empty());
        assert!(decode_json_object(Some("{not json")).is_empty());
        assert!(decode_json_object(None).is_empty());
    }
}

/// The effective post-`0014_platform_events` SQLite schema, used by the SQLite
/// driver tests to build an in-memory database. Kept byte-aligned with the
/// migration fixture body (`conformance/fixtures/migrations/sqlite.json`).
#[cfg(test)]
pub(crate) const PLATFORM_EVENTS_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS platform_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      accepted_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      family TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      tenant_id TEXT,
      account_id TEXT,
      subject_id TEXT,
      trace_id TEXT,
      idempotency_key TEXT,
      payload TEXT NOT NULL,
      attributes TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_platform_events_tenant_idempotency
      ON platform_events (ifnull(tenant_id, ''), idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX idx_platform_events_family_at ON platform_events (family, occurred_at DESC);
    CREATE INDEX idx_platform_events_tenant_at ON platform_events (tenant_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS platform_event_deliveries (
      consumer TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      acked_at TEXT,
      dead_lettered_at TEXT,
      last_error TEXT,
      PRIMARY KEY (consumer, event_id)
    );
    CREATE INDEX idx_platform_event_deliveries_status_available
      ON platform_event_deliveries (consumer, status, available_at);
    CREATE INDEX idx_platform_event_deliveries_event
      ON platform_event_deliveries (event_id);";

/// The shared conformance contract run against the memory driver.
#[cfg(test)]
mod memory_conformance {
    use std::sync::Arc;

    use super::conformance::{self, EventIds};
    use super::memory::MemoryPlatformEvents;
    use super::{PlatformEventsDriver, conformance as c};

    fn driver() -> (Arc<dyn PlatformEventsDriver>, EventIds) {
        (Arc::new(MemoryPlatformEvents::new()), EventIds::new())
    }

    macro_rules! case {
        ($name:ident, $fn:path) => {
            #[tokio::test]
            async fn $name() {
                let (driver, ids) = driver();
                $fn(driver, &ids).await;
            }
        };
    }

    case!(publishes_and_claims, c::publishes_and_claims);
    case!(does_not_redeliver_acked, c::does_not_redeliver_acked);
    case!(retries_after_availability, c::retries_after_availability);
    case!(dead_letters_poison, c::dead_letters_poison);
    case!(dedupes_by_idempotency_key, c::dedupes_by_idempotency_key);
    case!(
        scopes_idempotency_by_tenant,
        c::scopes_idempotency_by_tenant
    );
    case!(
        ignores_terminal_transitions,
        c::ignores_terminal_transitions
    );
    case!(stale_acks_do_not_overwrite, c::stale_acks_do_not_overwrite);
    case!(
        stale_attempt_cannot_ack_newer,
        c::stale_attempt_cannot_ack_newer
    );
    case!(snapshots_payloads, c::snapshots_payloads);
    case!(
        future_occurred_at_claimable,
        c::future_occurred_at_claimable
    );

    #[tokio::test]
    async fn prune_drops_by_age_then_cap() {
        // Retention 1s, cap 2.
        let driver: Arc<dyn PlatformEventsDriver> =
            Arc::new(MemoryPlatformEvents::with_options(1_000, 2));
        conformance::prune_drops_by_age_then_cap(driver, &EventIds::new()).await;
    }
}

/// The shared conformance contract run against the SQLite driver, plus the
/// at-least-once visibility-timeout case (SQLite-only — the memory driver has no
/// timeout).
#[cfg(test)]
mod sqlite_conformance {
    use std::sync::Arc;

    use super::conformance::{self, EventIds};
    use super::sqlite::{DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS, SqlitePlatformEvents};
    use super::{PLATFORM_EVENTS_SCHEMA, PlatformEventsDriver, conformance as c};
    use crate::driver::SqlDriver;

    async fn sql() -> Arc<SqlDriver> {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(PLATFORM_EVENTS_SCHEMA).await.unwrap();
        sql
    }

    async fn driver() -> (Arc<dyn PlatformEventsDriver>, EventIds) {
        let driver = SqlitePlatformEvents::with_defaults(sql().await);
        (Arc::new(driver), EventIds::new())
    }

    macro_rules! case {
        ($name:ident, $fn:path) => {
            #[tokio::test]
            async fn $name() {
                let (driver, ids) = driver().await;
                $fn(driver, &ids).await;
            }
        };
    }

    case!(publishes_and_claims, c::publishes_and_claims);
    case!(does_not_redeliver_acked, c::does_not_redeliver_acked);
    case!(retries_after_availability, c::retries_after_availability);
    case!(dead_letters_poison, c::dead_letters_poison);
    case!(dedupes_by_idempotency_key, c::dedupes_by_idempotency_key);
    case!(
        scopes_idempotency_by_tenant,
        c::scopes_idempotency_by_tenant
    );
    case!(
        ignores_terminal_transitions,
        c::ignores_terminal_transitions
    );
    case!(stale_acks_do_not_overwrite, c::stale_acks_do_not_overwrite);
    case!(
        stale_attempt_cannot_ack_newer,
        c::stale_attempt_cannot_ack_newer
    );
    case!(snapshots_payloads, c::snapshots_payloads);
    case!(
        future_occurred_at_claimable,
        c::future_occurred_at_claimable
    );

    #[tokio::test]
    async fn visibility_timeout_reclaims() {
        let (driver, ids) = driver().await;
        conformance::visibility_timeout_reclaims(
            driver,
            &ids,
            DEFAULT_PLATFORM_EVENTS_CLAIM_TIMEOUT_MS,
        )
        .await;
    }

    #[tokio::test]
    async fn prune_drops_by_age_then_cap() {
        // Retention 1s, cap 2.
        let driver: Arc<dyn PlatformEventsDriver> =
            Arc::new(SqlitePlatformEvents::new(sql().await, 1_000, 2, 1_000));
        conformance::prune_drops_by_age_then_cap(driver, &EventIds::new()).await;
    }
}
