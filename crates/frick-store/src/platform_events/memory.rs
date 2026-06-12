//! In-process platform-events driver (`MemoryPlatformEventPipeline`,
//! `apps/server/src/platform-events/memory.ts`).
//!
//! Holds the published events and the per-consumer delivery state in a single
//! [`Mutex`]-guarded struct. The TS class relies on JS's single-threaded model;
//! the Rust port takes the lock for each (synchronous) operation — no lock is
//! ever held across an `.await` (there are none inside). This is the default
//! driver for tests and single-node dev where durability across restarts is not
//! required.
//!
//! Determinism: every method takes `now_ms`; `publish` takes the caller's
//! `event_id`. Nothing reads the clock or generates ids internally — see the
//! module-level note in [`super`].

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::error::StoreError;
use crate::stores::blob_bytes::iso_from_epoch_ms;

use super::sqlite::{
    DEFAULT_PLATFORM_EVENTS_MAX_ROWS, DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
    PlatformEventsPruneResult,
};
use super::{
    PlatformEventClaimOptions, PlatformEventConsumerHealth, PlatformEventDelivery,
    PlatformEventDeliveryAttempt, PlatformEventEnvelope, PlatformEventHealth, PlatformEventInput,
    PlatformEventPublishReceipt, PlatformEventsAdapter, PlatformEventsDriver, clamp_batch_size,
    idempotency_scope, normalize_consumer_name, normalize_platform_event_input,
};

/// Per-consumer delivery status (`DeliveryStatus`, memory.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeliveryStatus {
    Pending,
    Claimed,
    Retry,
    Acked,
    DeadLettered,
}

/// One consumer's view of one event (`DeliveryState`, memory.ts).
#[derive(Debug, Clone)]
struct DeliveryState {
    status: DeliveryStatus,
    attempt: i64,
    available_at: String,
    claimed_at: Option<String>,
    #[allow(dead_code)]
    last_error: Option<String>,
}

/// The mutable interior, guarded by the driver's [`Mutex`].
#[derive(Default)]
struct Inner {
    /// Published events, in publish (sequence) order.
    events: Vec<PlatformEventEnvelope>,
    /// `idempotency_scope(tenant, key)` → the event that first claimed it.
    idempotency: HashMap<String, PlatformEventEnvelope>,
    /// event_id → accepted_at (the receipt time, distinct from occurred_at).
    accepted_at: HashMap<String, String>,
    /// consumer → (event_id → delivery state).
    deliveries: HashMap<String, HashMap<String, DeliveryState>>,
    /// Monotonic sequence counter.
    sequence: i64,
}

/// In-process platform-events driver (`MemoryPlatformEventPipeline`).
pub struct MemoryPlatformEvents {
    inner: Mutex<Inner>,
    retention_ms: i64,
    max_rows: i64,
}

impl Default for MemoryPlatformEvents {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryPlatformEvents {
    /// A pipeline with the default retention / cap knobs.
    #[must_use]
    pub fn new() -> Self {
        Self::with_options(
            DEFAULT_PLATFORM_EVENTS_RETENTION_MS,
            DEFAULT_PLATFORM_EVENTS_MAX_ROWS,
        )
    }

    /// A pipeline with explicit retention / cap knobs (used by [`prune`]).
    ///
    /// [`prune`]: PlatformEventsDriver::prune
    #[must_use]
    pub fn with_options(retention_ms: i64, max_rows: i64) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            retention_ms,
            max_rows,
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, StoreError> {
        self.inner
            .lock()
            .map_err(|_| StoreError::store("platform events memory mutex poisoned".to_string()))
    }
}

#[async_trait]
impl PlatformEventsDriver for MemoryPlatformEvents {
    fn adapter(&self) -> PlatformEventsAdapter {
        PlatformEventsAdapter::Memory
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
        let mut inner = self.lock()?;

        if let Some(key) = &normalized.idempotency_key {
            let scope = idempotency_scope(normalized.tenant_id.as_deref(), key);
            if let Some(existing) = inner.idempotency.get(&scope) {
                let receipt = PlatformEventPublishReceipt {
                    id: existing.id.clone(),
                    sequence: existing.sequence,
                    accepted_at: inner
                        .accepted_at
                        .get(&existing.id)
                        .cloned()
                        .unwrap_or_else(|| accepted_at.clone()),
                    duplicate: true,
                };
                return Ok(receipt);
            }
        }

        inner.sequence += 1;
        let sequence = inner.sequence;
        let event = PlatformEventEnvelope {
            id: event_id.to_string(),
            schema_version: normalized.schema_version,
            sequence,
            accepted_at: accepted_at.clone(),
            occurred_at: normalized.occurred_at,
            family: normalized.family,
            name: normalized.name,
            source: normalized.source,
            tenant_id: normalized.tenant_id,
            account_id: normalized.account_id,
            subject_id: normalized.subject_id,
            trace_id: normalized.trace_id,
            idempotency_key: normalized.idempotency_key,
            payload: normalized.payload,
            attributes: normalized.attributes,
        };
        inner.events.push(event.clone());
        inner
            .accepted_at
            .insert(event.id.clone(), accepted_at.clone());
        if let Some(key) = &event.idempotency_key {
            let scope = idempotency_scope(event.tenant_id.as_deref(), key);
            inner.idempotency.insert(scope, event.clone());
        }
        Ok(PlatformEventPublishReceipt {
            id: event.id,
            sequence,
            accepted_at,
            duplicate: false,
        })
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
        // `clamp_batch_size` returns a value in `[1, 1000]`, so the `usize` cast
        // never wraps.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let batch_size = clamp_batch_size(options.batch_size) as usize;
        let mut inner = self.lock()?;

        // Materialize a pending delivery for every event this consumer has not
        // seen yet (memory.ts: backfill from `#events`). The events list is the
        // source of order, so snapshot the ids first to avoid borrowing both.
        let event_ids_and_accepted: Vec<(String, String)> = inner
            .events
            .iter()
            .map(|event| (event.id.clone(), event.accepted_at.clone()))
            .collect();
        let state = inner.deliveries.entry(name.clone()).or_default();
        for (event_id, accepted_at) in &event_ids_and_accepted {
            state.entry(event_id.clone()).or_insert(DeliveryState {
                status: DeliveryStatus::Pending,
                attempt: 0,
                available_at: accepted_at.clone(),
                claimed_at: None,
                last_error: None,
            });
        }

        // Re-borrow events + state separately (events is read-only here).
        let mut deliveries = Vec::new();
        // Collect the claimable event order from the events list, then mutate
        // the per-consumer state map.
        let order: Vec<(String, PlatformEventEnvelope)> = inner
            .events
            .iter()
            .map(|event| (event.id.clone(), event.clone()))
            .collect();
        let state = inner
            .deliveries
            .get_mut(&name)
            .expect("consumer state was just inserted");
        for (event_id, event) in order {
            if deliveries.len() >= batch_size {
                break;
            }
            let Some(delivery) = state.get_mut(&event_id) else {
                continue;
            };
            let claimable = match delivery.status {
                DeliveryStatus::Pending | DeliveryStatus::Retry => {
                    delivery.available_at <= available_at
                }
                _ => false,
            };
            if !claimable {
                continue;
            }
            let claimed_at = now_iso.clone();
            delivery.status = DeliveryStatus::Claimed;
            delivery.attempt += 1;
            delivery.claimed_at = Some(claimed_at.clone());
            deliveries.push(PlatformEventDelivery {
                event,
                consumer: name.clone(),
                attempt: delivery.attempt,
                claimed_at,
            });
        }
        Ok(deliveries)
    }

    async fn ack(
        &self,
        consumer: &str,
        event_id: &str,
        attempt: &PlatformEventDeliveryAttempt,
        _now_ms: i64,
    ) -> Result<(), StoreError> {
        let name = normalize_consumer_name(consumer)?;
        let mut inner = self.lock()?;
        if let Some(delivery) = inner
            .deliveries
            .get_mut(&name)
            .and_then(|state| state.get_mut(event_id))
            && matches_attempt(delivery, attempt)
        {
            delivery.status = DeliveryStatus::Acked;
        }
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
        let mut inner = self.lock()?;
        if let Some(delivery) = inner
            .deliveries
            .get_mut(&name)
            .and_then(|state| state.get_mut(event_id))
            && matches_attempt(delivery, attempt)
        {
            delivery.status = DeliveryStatus::Retry;
            delivery.available_at = available;
            delivery.claimed_at = None;
            delivery.last_error = Some(error.to_string());
        }
        Ok(())
    }

    async fn dead_letter(
        &self,
        consumer: &str,
        event_id: &str,
        attempt: &PlatformEventDeliveryAttempt,
        error: &str,
        _now_ms: i64,
    ) -> Result<(), StoreError> {
        let name = normalize_consumer_name(consumer)?;
        let mut inner = self.lock()?;
        if let Some(delivery) = inner
            .deliveries
            .get_mut(&name)
            .and_then(|state| state.get_mut(event_id))
            && matches_attempt(delivery, attempt)
        {
            delivery.status = DeliveryStatus::DeadLettered;
            delivery.last_error = Some(error.to_string());
        }
        Ok(())
    }

    async fn health(&self) -> Result<PlatformEventHealth, StoreError> {
        let inner = self.lock()?;
        let mut consumers: Vec<PlatformEventConsumerHealth> = inner
            .deliveries
            .iter()
            .map(|(name, deliveries)| {
                let counts = count_deliveries(deliveries.values());
                PlatformEventConsumerHealth {
                    name: name.clone(),
                    pending: counts.pending,
                    claimed: counts.claimed,
                    dead_lettered: counts.dead_lettered,
                    lag: counts.pending + counts.claimed,
                }
            })
            .collect();
        consumers.sort_by(|a, b| a.name.cmp(&b.name));

        let pending = consumers.iter().map(|row| row.pending).sum();
        let claimed = consumers.iter().map(|row| row.claimed).sum();
        let dead_lettered = consumers.iter().map(|row| row.dead_lettered).sum();

        // An event is "claimed" (i.e. tracked by some consumer) when any
        // consumer has a delivery row for it (memory.ts `claimedEventIds`).
        let tracked: std::collections::HashSet<&String> = inner
            .deliveries
            .values()
            .flat_map(|state| state.keys())
            .collect();
        let retained = i64::try_from(inner.events.len()).unwrap_or(i64::MAX);
        let tracked_count = i64::try_from(tracked.len()).unwrap_or(i64::MAX);
        let unclaimed = (retained - tracked_count).max(0);

        Ok(PlatformEventHealth {
            adapter: PlatformEventsAdapter::Memory,
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
        let mut inner = self.lock()?;

        // Age sweep: drop events whose occurred_at < cutoff, and forget their
        // per-consumer deliveries / idempotency / accepted_at entries.
        let mut dropped: Vec<String> = Vec::new();
        inner.events.retain(|event| {
            if event.occurred_at < cutoff_iso {
                dropped.push(event.id.clone());
                false
            } else {
                true
            }
        });
        let pruned_by_age = dropped.len() as u64;
        forget(&mut inner, &dropped);

        // Cap sweep: trim the oldest events down to the row cap.
        let max_rows = usize::try_from(self.max_rows.max(0)).unwrap_or(usize::MAX);
        let mut pruned_by_cap = 0_u64;
        let overflow = inner.events.len().saturating_sub(max_rows);
        if overflow > 0 {
            let removed: Vec<String> = inner
                .events
                .drain(0..overflow)
                .map(|event| event.id)
                .collect();
            pruned_by_cap = removed.len() as u64;
            forget(&mut inner, &removed);
        }

        Ok(PlatformEventsPruneResult {
            pruned_by_age,
            pruned_by_cap,
        })
    }
}

/// Forget every trace of the given event ids: idempotency scope, accepted_at,
/// and the per-consumer delivery rows.
fn forget(inner: &mut Inner, event_ids: &[String]) {
    if event_ids.is_empty() {
        return;
    }
    let dropped: std::collections::HashSet<&String> = event_ids.iter().collect();
    for id in event_ids {
        inner.accepted_at.remove(id);
    }
    inner
        .idempotency
        .retain(|_, event| !dropped.contains(&event.id));
    for state in inner.deliveries.values_mut() {
        state.retain(|event_id, _| !dropped.contains(event_id));
    }
}

/// A delivery is mutable by a terminal call only when it is still `claimed` and
/// the `(attempt, claimed_at)` matches the claim (`matchesDeliveryAttempt`,
/// memory.ts) — this rejects stale attempts and terminal deliveries.
fn matches_attempt(delivery: &DeliveryState, attempt: &PlatformEventDeliveryAttempt) -> bool {
    delivery.status == DeliveryStatus::Claimed
        && delivery.attempt == attempt.attempt
        && delivery.claimed_at.as_deref() == Some(attempt.claimed_at.as_str())
}

struct DeliveryCounts {
    pending: i64,
    claimed: i64,
    dead_lettered: i64,
}

/// `countDeliveries` (memory.ts): pending = pending|retry, plus claimed and
/// dead-lettered tallies.
fn count_deliveries<'a>(deliveries: impl Iterator<Item = &'a DeliveryState>) -> DeliveryCounts {
    let mut counts = DeliveryCounts {
        pending: 0,
        claimed: 0,
        dead_lettered: 0,
    };
    for delivery in deliveries {
        match delivery.status {
            DeliveryStatus::Pending | DeliveryStatus::Retry => counts.pending += 1,
            DeliveryStatus::Claimed => counts.claimed += 1,
            DeliveryStatus::DeadLettered => counts.dead_lettered += 1,
            DeliveryStatus::Acked => {}
        }
    }
    counts
}
