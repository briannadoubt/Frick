//! In-memory test push adapter (map 06 §3.11; `apps/server/src/push/test-adapter.ts`).
//!
//! Records every delivery and always reports `delivered` with
//! `receiptId = "test-receipt-" + <uuid>`. Two uses:
//!   1. Tests that assert "an intent fanned out to these devices" without a real
//!      APNs/FCM mock.
//!   2. Local development — operators poke the admin route then read
//!      [`delivered`](TestPushAdapter::delivered) to see what would have shipped.
//!
//! The framework registers this by default for platform `test` unless an app
//! already claims it (TS `server.ts:870-879`).
//!
//! Determinism: the receipt-id source and the `attemptedAt` clock are injected
//! (the TS uses `randomUUID()` + `new Date()`); [`TestPushAdapter::new`] wires
//! the production seams, [`TestPushAdapter::with_seams`] takes fixed ones.

use std::sync::{Arc, Mutex};

use super::types::{
    FrickNotificationContext, FrickNotificationIntent, FrickPushDelivery, PushDeviceRegistration,
    PushPlatform,
};
use super::{SharedPushClock, SystemPushClock};
use crate::push::registry::PushAdapter;

/// Receipt-id source. Production wires a uuid generator; tests inject a counter.
pub type ReceiptIdFn = Arc<dyn Fn() -> String + Send + Sync>;

/// In-memory always-`delivered` adapter (TS `FrickTestPushAdapter`).
pub struct TestPushAdapter {
    delivered: Mutex<Vec<FrickPushDelivery>>,
    clock: SharedPushClock,
    receipt_id: ReceiptIdFn,
}

impl Default for TestPushAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl TestPushAdapter {
    /// Production adapter: system clock + uuid receipt ids.
    #[must_use]
    pub fn new() -> Self {
        Self::with_seams(
            Arc::new(SystemPushClock),
            Arc::new(|| format!("test-receipt-{}", uuid::Uuid::new_v4())),
        )
    }

    /// Adapter with explicit determinism seams (fixed clock + receipt source).
    #[must_use]
    pub fn with_seams(clock: SharedPushClock, receipt_id: ReceiptIdFn) -> Self {
        Self {
            delivered: Mutex::new(Vec::new()),
            clock,
            receipt_id,
        }
    }

    /// Every delivery the adapter has performed, in order (TS `adapter.delivered`).
    #[must_use]
    pub fn delivered(&self) -> Vec<FrickPushDelivery> {
        self.delivered.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Clear the recorded delivery list (TS `reset()`).
    pub fn reset(&self) {
        if let Ok(mut delivered) = self.delivered.lock() {
            delivered.clear();
        }
    }
}

impl PushAdapter for TestPushAdapter {
    fn platform(&self) -> PushPlatform {
        PushPlatform::Test
    }

    fn send<'a>(
        &'a self,
        _intent: &'a FrickNotificationIntent,
        registration: &'a PushDeviceRegistration,
        _ctx: &'a FrickNotificationContext<'a>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<FrickPushDelivery, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            let delivery = FrickPushDelivery::delivered(
                registration.clone(),
                crate::push::router::iso_from_epoch_ms(self.clock.now_ms()),
                Some((self.receipt_id)()),
            );
            if let Ok(mut delivered) = self.delivered.lock() {
                delivered.push(delivery.clone());
            }
            Ok(delivery)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::FixedPushClock;
    use crate::push::types::{NotificationBody, PushDeliveryStatus, PushEnvironment};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn registration() -> PushDeviceRegistration {
        PushDeviceRegistration {
            registration_id: "push-1".to_string(),
            tenant_id: "tenant-1".to_string(),
            user_id: "user-1".to_string(),
            device_id: "dev-1".to_string(),
            platform: PushPlatform::Test,
            token: "tok".to_string(),
            environment: PushEnvironment::Production,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_seen_at: "2026-01-01T00:00:00.000Z".to_string(),
            revoked_at: None,
        }
    }

    fn intent() -> FrickNotificationIntent {
        FrickNotificationIntent {
            intent: "message.new".to_string(),
            tenant_id: "tenant-1".to_string(),
            recipient_user_ids: vec!["user-1".to_string()],
            body: NotificationBody::default(),
            thread_id: None,
            deep_link: None,
        }
    }

    #[tokio::test]
    async fn always_delivered_records_and_resets() {
        let counter = Arc::new(AtomicU64::new(0));
        let counter2 = Arc::clone(&counter);
        let adapter = TestPushAdapter::with_seams(
            Arc::new(FixedPushClock(1_700_000_000_000)),
            Arc::new(move || format!("test-receipt-{}", counter2.fetch_add(1, Ordering::SeqCst))),
        );
        let store = crate::push::router::tests_support::store().await;
        let intent = intent();
        let reg = registration();
        let ctx = FrickNotificationContext {
            tenant_id: "tenant-1",
            intent: &intent,
            store: &store,
        };
        let delivery = adapter.send(&intent, &reg, &ctx).await.unwrap();
        assert_eq!(delivery.status, PushDeliveryStatus::Delivered);
        assert_eq!(delivery.receipt_id.as_deref(), Some("test-receipt-0"));
        assert_eq!(adapter.delivered().len(), 1);
        adapter.reset();
        assert!(adapter.delivered().is_empty());
    }
}
