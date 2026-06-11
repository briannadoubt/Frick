//! Shared conformance contract for the platform-events drivers, ported from
//! `apps/server/tests/platform-events.conformance.ts`.
//!
//! Both the [`MemoryPlatformEvents`](super::memory::MemoryPlatformEvents) and
//! [`SqlitePlatformEvents`](super::sqlite::SqlitePlatformEvents) drivers must
//! satisfy every case here. The TS suite is parameterized by a
//! `PlatformEventConformanceHarness`; the Rust port is a set of `async`
//! functions each taking a freshly-built `Arc<dyn PlatformEventsDriver>`, driven
//! from per-driver `#[tokio::test]` wrappers in `memory_tests` / `sqlite_tests`.
//!
//! Determinism: the TS drivers read `Date.now()` internally; the Rust drivers
//! take `now_ms`. The harness threads a fixed clock + a monotonic event-id
//! counter so a run is fully reproducible, matching the determinism seam.

#![cfg(test)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};

use super::{
    PlatformEventClaimOptions, PlatformEventDelivery, PlatformEventDeliveryAttempt,
    PlatformEventInput, PlatformEventsDriver,
};

/// A fixed publish clock for the suite (2026-05-01T00:00:00.000Z). Chosen to sit
/// before the `future_occurred_at_claimable` claim cutoff (2026-05-17) and after
/// the `retries_after_availability` "not yet available" cutoff (2026-01-01), so
/// the hardcoded `available_at` overrides those cases use behave as the TS suite
/// intends.
pub(crate) const NOW: i64 = 1_777_593_600_000;

/// A monotonic, deterministic event-id source (stands in for `randomUUID()`).
pub(crate) struct EventIds {
    counter: AtomicU64,
}

impl EventIds {
    pub(crate) fn new() -> Self {
        Self {
            counter: AtomicU64::new(0),
        }
    }

    pub(crate) fn next(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The `baseEvent` fixture (conformance.ts).
pub(crate) fn base_event() -> PlatformEventInput {
    PlatformEventInput {
        family: "analytics.user_event".into(),
        name: "message.sent".into(),
        source: "test".into(),
        tenant_id: Some("tenant-a".into()),
        account_id: Some("account-a".into()),
        payload: object(json!({ "messageId": "message-1" })),
        attributes: object(json!({ "platform": "web", "beta": true, "count": 1 })),
        ..Default::default()
    }
}

fn attempt_of(delivery: Option<&PlatformEventDelivery>) -> PlatformEventDeliveryAttempt {
    let delivery = delivery.expect("expected a delivery");
    delivery.attempt_fingerprint()
}

// ---------------------------------------------------------------------------
// The shared cases. Each takes a fresh driver + its id source.
// ---------------------------------------------------------------------------

/// publish → claim returns the typed event for a named consumer.
pub(crate) async fn publishes_and_claims(driver: Arc<dyn PlatformEventsDriver>, ids: &EventIds) {
    let receipt = driver
        .publish(&base_event(), &ids.next(), NOW)
        .await
        .unwrap();
    assert!(!receipt.duplicate);
    assert!(receipt.sequence > 0);

    let deliveries = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions {
                batch_size: Some(10),
                ..Default::default()
            },
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(deliveries.len(), 1);
    let event = &deliveries[0].event;
    assert_eq!(event.id, receipt.id);
    assert_eq!(event.sequence, receipt.sequence);
    assert_eq!(event.family, "analytics.user_event");
    assert_eq!(event.name, "message.sent");
    assert_eq!(event.tenant_id.as_deref(), Some("tenant-a"));
    assert_eq!(event.account_id.as_deref(), Some("account-a"));
    assert_eq!(
        event.payload.get("messageId"),
        Some(&Value::from("message-1"))
    );
    assert_eq!(event.attributes.get("platform"), Some(&Value::from("web")));
    assert_eq!(event.attributes.get("beta"), Some(&Value::from(true)));
    assert_eq!(event.attributes.get("count"), Some(&Value::from(1)));
    assert_eq!(deliveries[0].attempt, 1);
}

/// An acked event is not redelivered to the same consumer, but is to another.
pub(crate) async fn does_not_redeliver_acked(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    let receipt = driver
        .publish(&base_event(), &ids.next(), NOW)
        .await
        .unwrap();
    let first = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(first.first().map(|d| &d.event.id), Some(&receipt.id));

    driver
        .ack(
            "analytics-worker",
            &receipt.id,
            &attempt_of(first.first()),
            NOW,
        )
        .await
        .unwrap();

    assert!(
        driver
            .claim(
                "analytics-worker",
                &PlatformEventClaimOptions::default(),
                NOW
            )
            .await
            .unwrap()
            .is_empty()
    );
    let second = driver
        .claim("export-worker", &PlatformEventClaimOptions::default(), NOW)
        .await
        .unwrap();
    assert_eq!(
        second.first().map(|d| d.event.id.as_str()),
        Some(receipt.id.as_str())
    );
}

/// A retried delivery is claimable only after its availability time.
pub(crate) async fn retries_after_availability(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    let receipt = driver
        .publish(&base_event(), &ids.next(), NOW)
        .await
        .unwrap();
    let first = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(first.first().map(|d| d.attempt), Some(1));

    driver
        .retry(
            "analytics-worker",
            &receipt.id,
            &attempt_of(first.first()),
            "temporary failure",
            Some("2099-01-01T00:00:00.000Z"),
            NOW,
        )
        .await
        .unwrap();

    // Not yet available.
    assert!(
        driver
            .claim(
                "analytics-worker",
                &PlatformEventClaimOptions {
                    available_at: Some("2026-01-01T00:00:00.000Z".into()),
                    ..Default::default()
                },
                NOW,
            )
            .await
            .unwrap()
            .is_empty()
    );

    let retried = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions {
                available_at: Some("2099-01-01T00:00:00.000Z".into()),
                ..Default::default()
            },
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(
        retried.first().map(|d| d.event.id.as_str()),
        Some(receipt.id.as_str())
    );
    assert_eq!(retried.first().map(|d| d.attempt), Some(2));
}

/// Dead-lettering parks a poison event per consumer and shows in health.
pub(crate) async fn dead_letters_poison(driver: Arc<dyn PlatformEventsDriver>, ids: &EventIds) {
    let receipt = driver
        .publish(&base_event(), &ids.next(), NOW)
        .await
        .unwrap();
    let first = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    driver
        .dead_letter(
            "analytics-worker",
            &receipt.id,
            &attempt_of(first.first()),
            "bad payload",
            NOW,
        )
        .await
        .unwrap();

    assert!(
        driver
            .claim(
                "analytics-worker",
                &PlatformEventClaimOptions::default(),
                NOW
            )
            .await
            .unwrap()
            .is_empty()
    );
    let health = driver.health().await.unwrap();
    assert!(health.dead_lettered >= 1);
    assert_eq!(
        health
            .consumers
            .iter()
            .find(|c| c.name == "analytics-worker")
            .map(|c| c.dead_lettered),
        Some(1)
    );
}

/// Publishes are deduplicated by idempotency key.
pub(crate) async fn dedupes_by_idempotency_key(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    let mut input = base_event();
    input.idempotency_key = Some("dedupe-1".into());
    let first = driver.publish(&input, &ids.next(), NOW).await.unwrap();
    let second = driver.publish(&input, &ids.next(), NOW).await.unwrap();

    assert_eq!(second.id, first.id);
    assert_eq!(second.sequence, first.sequence);
    assert!(second.duplicate);
    let deliveries = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions {
                batch_size: Some(10),
                ..Default::default()
            },
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(deliveries.len(), 1);
}

/// Idempotency keys are scoped per tenant.
pub(crate) async fn scopes_idempotency_by_tenant(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    let mut a = base_event();
    a.idempotency_key = Some("shared-key".into());
    a.tenant_id = Some("tenant-a".into());
    let mut b = base_event();
    b.idempotency_key = Some("shared-key".into());
    b.tenant_id = Some("tenant-b".into());

    let tenant_a = driver.publish(&a, &ids.next(), NOW).await.unwrap();
    let tenant_b = driver.publish(&b, &ids.next(), NOW).await.unwrap();
    assert_ne!(tenant_b.id, tenant_a.id);
    assert!(!tenant_b.duplicate);

    let deliveries = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions {
                batch_size: Some(10),
                ..Default::default()
            },
            NOW,
        )
        .await
        .unwrap();
    let mut tenants: Vec<String> = deliveries
        .iter()
        .filter_map(|d| d.event.tenant_id.clone())
        .collect();
    tenants.sort();
    assert_eq!(
        tenants,
        vec!["tenant-a".to_string(), "tenant-b".to_string()]
    );
}

/// Terminal deliveries are not retried or dead-lettered.
pub(crate) async fn ignores_terminal_transitions(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    let receipt = driver
        .publish(&base_event(), &ids.next(), NOW)
        .await
        .unwrap();
    let first = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    let attempt = attempt_of(first.first());
    driver
        .ack("analytics-worker", &receipt.id, &attempt, NOW)
        .await
        .unwrap();

    driver
        .retry(
            "analytics-worker",
            &receipt.id,
            &attempt,
            "too late",
            None,
            NOW,
        )
        .await
        .unwrap();
    driver
        .dead_letter(
            "analytics-worker",
            &receipt.id,
            &attempt,
            "also too late",
            NOW,
        )
        .await
        .unwrap();

    assert!(
        driver
            .claim(
                "analytics-worker",
                &PlatformEventClaimOptions::default(),
                NOW
            )
            .await
            .unwrap()
            .is_empty()
    );
    let health = driver.health().await.unwrap();
    assert_eq!(health.dead_lettered, 0);
}

/// Stale acks do not overwrite retry / dead-letter states.
pub(crate) async fn stale_acks_do_not_overwrite(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    // retry case.
    let mut retry_input = base_event();
    retry_input.idempotency_key = Some("stale-ack-retry".into());
    let retry_receipt = driver
        .publish(&retry_input, &ids.next(), NOW)
        .await
        .unwrap();
    let retry_first = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    driver
        .retry(
            "analytics-worker",
            &retry_receipt.id,
            &attempt_of(retry_first.first()),
            "temporary failure",
            Some("2099-01-01T00:00:00.000Z"),
            NOW,
        )
        .await
        .unwrap();
    // A stale ack (against the first attempt) must NOT terminate the retry.
    driver
        .ack(
            "analytics-worker",
            &retry_receipt.id,
            &attempt_of(retry_first.first()),
            NOW,
        )
        .await
        .unwrap();
    let retried = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions {
                available_at: Some("2099-01-01T00:00:00.000Z".into()),
                ..Default::default()
            },
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(
        retried.first().map(|d| d.event.id.as_str()),
        Some(retry_receipt.id.as_str())
    );

    // dead-letter case.
    let mut dl_input = base_event();
    dl_input.idempotency_key = Some("stale-ack-dead-letter".into());
    let dl_receipt = driver.publish(&dl_input, &ids.next(), NOW).await.unwrap();
    let dl_first = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    driver
        .dead_letter(
            "analytics-worker",
            &dl_receipt.id,
            &attempt_of(dl_first.first()),
            "bad payload",
            NOW,
        )
        .await
        .unwrap();
    driver
        .ack(
            "analytics-worker",
            &dl_receipt.id,
            &attempt_of(dl_first.first()),
            NOW,
        )
        .await
        .unwrap();
    let health = driver.health().await.unwrap();
    assert_eq!(health.dead_lettered, 1);
}

/// A stale delivery attempt cannot ack a newer claim.
pub(crate) async fn stale_attempt_cannot_ack_newer(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    let mut input = base_event();
    input.idempotency_key = Some("stale-attempt-ack".into());
    let receipt = driver.publish(&input, &ids.next(), NOW).await.unwrap();
    let first = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    driver
        .retry(
            "analytics-worker",
            &receipt.id,
            &attempt_of(first.first()),
            "temporary failure",
            None,
            NOW,
        )
        .await
        .unwrap();
    let second = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(second.first().map(|d| d.attempt), Some(2));

    // A stale ack against the FIRST attempt must not terminate the second claim.
    driver
        .ack(
            "analytics-worker",
            &receipt.id,
            &attempt_of(first.first()),
            NOW,
        )
        .await
        .unwrap();
    driver
        .retry(
            "analytics-worker",
            &receipt.id,
            &attempt_of(second.first()),
            "second retry",
            None,
            NOW,
        )
        .await
        .unwrap();
    let third = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(
        third.first().map(|d| d.event.id.as_str()),
        Some(receipt.id.as_str())
    );
    assert_eq!(third.first().map(|d| d.attempt), Some(3));
}

/// Payloads + attributes are snapshotted at publish time. (In Rust the input is
/// cloned into the driver, so a post-publish mutation of the caller's map cannot
/// reach a stored event — this asserts the stored values equal the publish-time
/// snapshot.)
pub(crate) async fn snapshots_payloads(driver: Arc<dyn PlatformEventsDriver>, ids: &EventIds) {
    let mut input = base_event();
    input.payload = object(json!({ "nested": { "count": 1 } }));
    input.attributes = object(json!({ "count": 1 }));
    driver.publish(&input, &ids.next(), NOW).await.unwrap();
    // Mutate the caller's copy after publish — must not affect the stored event.
    input.payload = object(json!({ "nested": { "count": 2 } }));
    input.attributes = object(json!({ "count": 2 }));

    let deliveries = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    let event = &deliveries.first().expect("a delivery").event;
    assert_eq!(event.payload, object(json!({ "nested": { "count": 1 } })));
    assert_eq!(event.attributes, object(json!({ "count": 1 })));
}

/// Future-`occurredAt` events are claimable at publish time.
pub(crate) async fn future_occurred_at_claimable(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    let mut input = base_event();
    input.occurred_at = Some("2099-01-01T00:00:00.000Z".into());
    let receipt = driver.publish(&input, &ids.next(), NOW).await.unwrap();

    let deliveries = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions {
                available_at: Some("2026-05-17T00:00:00.000Z".into()),
                ..Default::default()
            },
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(
        deliveries.first().map(|d| d.event.id.as_str()),
        Some(receipt.id.as_str())
    );
}

/// A claimed-but-unacked delivery is re-claimable after the visibility timeout
/// (at-least-once). This is NOT in the TS conformance suite (the TS used a
/// real clock); the assignment calls it out explicitly. The memory driver has
/// no visibility timeout, so this case is driven only against drivers that
/// support it (the sqlite driver) — see the per-driver wrappers.
pub(crate) async fn visibility_timeout_reclaims(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
    claim_timeout_ms: i64,
) {
    let receipt = driver
        .publish(&base_event(), &ids.next(), NOW)
        .await
        .unwrap();
    let first = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(first.first().map(|d| d.attempt), Some(1));

    // Before the timeout elapses: not re-claimable.
    assert!(
        driver
            .claim(
                "analytics-worker",
                &PlatformEventClaimOptions::default(),
                NOW + claim_timeout_ms - 1,
            )
            .await
            .unwrap()
            .is_empty()
    );

    // After the timeout: the stale claim is reclaimed, attempt bumped.
    let reclaimed = driver
        .claim(
            "analytics-worker",
            &PlatformEventClaimOptions::default(),
            NOW + claim_timeout_ms + 1,
        )
        .await
        .unwrap();
    assert_eq!(
        reclaimed.first().map(|d| d.event.id.as_str()),
        Some(receipt.id.as_str())
    );
    assert_eq!(reclaimed.first().map(|d| d.attempt), Some(2));
}

/// prune drops aged-out events then trims to the row cap. Driven against a
/// driver configured with a tight retention + cap.
pub(crate) async fn prune_drops_by_age_then_cap(
    driver: Arc<dyn PlatformEventsDriver>,
    ids: &EventIds,
) {
    // Retention is 1s and cap is 2 (configured by the caller). Two stale events
    // (occurredAt well in the past) + three fresh ones.
    let stale_iso = "2000-01-01T00:00:00.000Z";
    for _ in 0..2 {
        let mut input = base_event();
        input.idempotency_key = None;
        input.occurred_at = Some(stale_iso.into());
        driver.publish(&input, &ids.next(), NOW).await.unwrap();
    }
    for i in 0..3 {
        let mut input = base_event();
        input.idempotency_key = None;
        driver.publish(&input, &ids.next(), NOW + i).await.unwrap();
    }

    let result = driver.prune(NOW + 10).await.unwrap();
    assert_eq!(result.pruned_by_age, 2, "two stale events dropped by age");
    assert_eq!(
        result.pruned_by_cap, 1,
        "cap of 2 trims one of the three fresh"
    );

    let health = driver.health().await.unwrap();
    assert_eq!(health.retained, 2, "two events remain after prune");
}
