//! Notification router + `push.deliver` job handler (map 06 §3.4;
//! `apps/server/src/push/router.ts`).
//!
//! The router is wired into the job framework as the `push.deliver` handler: the
//! worker hands it a job whose payload is a serialized [`FrickNotificationIntent`],
//! and the router fans the intent out to every active push registration for the
//! listed recipients. Lifecycle for one job:
//!
//!   1. Decode the payload into an intent ([`decode_intent`]).
//!   2. For each recipient user id → list their active registrations.
//!   3. Resolve the adapter per registration; none → `skipped` with
//!      `push.unknownAdapter`.
//!   4. `adapter.send(...)`; a returned `Err` → synthetic `failed` with
//!      `adapter.threw`. On `delivered` → `touch`; on `failed` + a revocation
//!      code → `revoke`.
//!   5. Record a `frick.push.delivery` telemetry event (fire-and-forget).
//!
//! `deliver` de-dupes by `registration_id` across the whole intent so a repeated
//! recipient can't double-send. **Partial delivery is intentional** — the job
//! completes even if every delivery failed; only an undecodable payload
//! (`push.invalidIntent`, non-retryable) or a router infra error
//! (`push.routerError`, retryable) fails the job.
//!
//! # Integrator wiring
//!
//! ```ignore
//! use std::sync::Arc;
//! use frick_server::push::{PushRegistry, TestPushAdapter, SystemPushClock, NoopTelemetry};
//! use frick_server::push::router::{NotificationRouter, NotificationRouterOptions, PUSH_DELIVER_JOB_TYPE};
//! use frick_server::push::credentials::ProcessCredentialEnv;
//! use frick_server::jobs::JobHandlerRegistry;
//!
//! // 1. Build + populate the adapter registry (app adapters first, then the
//! //    default test adapter unless an app already claims `test`).
//! let mut push_registry = PushRegistry::new();
//! // push_registry.register_adapter(Arc::new(my_apns_adapter))?;
//! if !push_registry.contains(frick_server::push::PushPlatform::Test) {
//!     push_registry.register_adapter(Arc::new(TestPushAdapter::new()))?;
//! }
//!
//! // 2. Build the router over the shared store.
//! let router = Arc::new(NotificationRouter::new(NotificationRouterOptions {
//!     store: store.clone(),                       // Arc<FrickStore>
//!     registry: Arc::new(push_registry),
//!     clock: Arc::new(SystemPushClock),
//!     telemetry: Arc::new(NoopTelemetry),         // or a DevTools-event sink
//!     credential_env: Arc::new(ProcessCredentialEnv),
//! }));
//!
//! // 3. Register the handler under `push.deliver`.
//! let mut jobs = JobHandlerRegistry::new();
//! jobs.register(PUSH_DELIVER_JOB_TYPE, router.job_handler())?;
//! ```

use std::sync::Arc;

use frick_protocol::Value;
use frick_store::FrickStore;
use frick_store::stores::job::{EnqueueInput, JobRow};

use super::credentials::{CredentialEnv, ProcessCredentialEnv};
use super::registry::PushRegistry;
use super::types::{
    FrickNotificationContext, FrickNotificationIntent, FrickPushDelivery, NotificationBody,
    PushDeliveryStatus, PushDeviceRegistration, PushPlatform, is_push_revocation_error,
};
use super::{
    NoopTelemetry, PushTelemetryEvent, SharedPushClock, SharedPushTelemetry, SystemPushClock,
};
use crate::jobs::{JobContext, JobError, JobHandler, JobHandlerFuture};

/// `PUSH_DELIVER_JOB_TYPE` (router.ts:44).
pub const PUSH_DELIVER_JOB_TYPE: &str = "push.deliver";

/// Construction options for [`NotificationRouter`].
pub struct NotificationRouterOptions {
    /// The shared store (registrations, jobs, tenant settings).
    pub store: Arc<FrickStore>,
    /// The adapter registry.
    pub registry: Arc<PushRegistry>,
    /// Clock seam (`attemptedAt`).
    pub clock: SharedPushClock,
    /// Delivery-telemetry sink (`frick.push.delivery`).
    pub telemetry: SharedPushTelemetry,
    /// Credential env seam (for adapters that load per-tenant credentials).
    pub credential_env: Arc<dyn CredentialEnv + Send + Sync>,
}

/// The notification router (TS `NotificationRouter`, router.ts:46-58).
pub struct NotificationRouter {
    store: Arc<FrickStore>,
    registry: Arc<PushRegistry>,
    clock: SharedPushClock,
    telemetry: SharedPushTelemetry,
    #[allow(dead_code)] // surfaced to adapters via ctx in a later wiring slice
    credential_env: Arc<dyn CredentialEnv + Send + Sync>,
}

impl NotificationRouter {
    /// Build a router from explicit options.
    #[must_use]
    pub fn new(options: NotificationRouterOptions) -> Self {
        Self {
            store: options.store,
            registry: options.registry,
            clock: options.clock,
            telemetry: options.telemetry,
            credential_env: options.credential_env,
        }
    }

    /// Convenience constructor with production seams (system clock, no-op
    /// telemetry, process credential env).
    #[must_use]
    pub fn with_defaults(store: Arc<FrickStore>, registry: Arc<PushRegistry>) -> Self {
        Self::new(NotificationRouterOptions {
            store,
            registry,
            clock: Arc::new(SystemPushClock),
            telemetry: Arc::new(NoopTelemetry),
            credential_env: Arc::new(ProcessCredentialEnv),
        })
    }

    /// `enqueueIntent` (router.ts:199-205): package the intent as a
    /// `push.deliver` job row so HTTP routes / app code don't repeat the
    /// encoding. `now_ms` stamps the job's timestamps.
    pub async fn enqueue_intent(
        &self,
        intent: &FrickNotificationIntent,
        now_ms: i64,
    ) -> Result<JobRow, frick_store::StoreError> {
        self.store
            .jobs()
            .enqueue(
                EnqueueInput {
                    tenant_id: intent.tenant_id.clone(),
                    app_id: None,
                    job_type: PUSH_DELIVER_JOB_TYPE.to_string(),
                    payload: encode_intent(intent),
                    idempotency_key: None,
                    available_at: None,
                    max_attempts: None,
                },
                now_ms,
            )
            .await
    }

    /// `deliver` (router.ts:69-86): fan the intent out to every active
    /// registration of every recipient, de-duping by `registration_id` across
    /// the whole intent. Returns one delivery per registration, in order.
    pub async fn deliver(
        &self,
        intent: &FrickNotificationIntent,
    ) -> Result<Vec<FrickPushDelivery>, frick_store::StoreError> {
        let mut deliveries = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for user_id in &intent.recipient_user_ids {
            let registrations = self
                .store
                .push_registrations()
                .list_by_user(&intent.tenant_id, user_id)
                .await?;
            for registration in registrations {
                if !seen.insert(registration.registration_id.clone()) {
                    continue;
                }
                if !platform_accepts_intent(registration.platform, &intent.intent) {
                    continue;
                }
                let delivery = self.deliver_one(intent, registration).await?;
                deliveries.push(delivery);
            }
        }
        Ok(deliveries)
    }

    /// `deliverOne` (router.ts:88-163): resolve the adapter, dispatch, apply
    /// touch/revoke, and record telemetry.
    async fn deliver_one(
        &self,
        intent: &FrickNotificationIntent,
        registration: PushDeviceRegistration,
    ) -> Result<FrickPushDelivery, frick_store::StoreError> {
        let now_ms = self.clock.now_ms();
        let attempted_at = iso_from_epoch_ms(now_ms);

        // 1. resolveAdapter; none → skipped push.unknownAdapter.
        let Some(adapter) = self.registry.resolve(registration.platform) else {
            let platform = registration.platform.as_str();
            let delivery = FrickPushDelivery::skipped(
                registration.clone(),
                attempted_at,
                "push.unknownAdapter",
                format!("No adapter registered for platform \"{platform}\""),
            );
            self.record_telemetry(&intent.intent, &delivery);
            return Ok(delivery);
        };

        // 2/3. send; a returned Err becomes a synthetic failed/adapter.threw.
        let ctx = FrickNotificationContext {
            tenant_id: &intent.tenant_id,
            intent,
            store: &self.store,
        };
        let delivery = match adapter.send(intent, &registration, &ctx).await {
            Ok(delivery) => delivery,
            Err(message) => {
                tracing::error!(
                    target: "frick.push.adapter_threw",
                    intent = %intent.intent,
                    tenant_id = %intent.tenant_id,
                    registration_id = %registration.registration_id,
                    platform = %registration.platform.as_str(),
                    error = %message,
                    "push adapter threw",
                );
                FrickPushDelivery::failed(
                    registration.clone(),
                    attempted_at,
                    "adapter.threw",
                    message,
                )
            }
        };

        // 4. delivered → touch; failed + revocation code → revoke.
        match delivery.status {
            PushDeliveryStatus::Delivered => {
                self.store
                    .push_registrations()
                    .touch(
                        &delivery.registration.registration_id,
                        &delivery.registration.tenant_id,
                        now_ms,
                    )
                    .await?;
            }
            PushDeliveryStatus::Failed
                if is_push_revocation_error(delivery.error.as_ref().map(|e| e.code.as_str())) =>
            {
                self.store
                    .push_registrations()
                    .revoke(
                        &delivery.registration.registration_id,
                        &delivery.registration.tenant_id,
                        now_ms,
                    )
                    .await?;
                tracing::info!(
                    target: "frick.push.revoked",
                    reason = delivery.error.as_ref().map(|e| e.code.as_str()),
                    "push registration revoked",
                );
            }
            _ => {}
        }

        // 5. telemetry, always, fire-and-forget.
        self.record_telemetry(&intent.intent, &delivery);
        Ok(delivery)
    }

    /// Record the `frick.push.delivery` telemetry event for one delivery
    /// (router.ts:147-161). `intent_id` is the originating intent's semantic id.
    fn record_telemetry(&self, intent_id: &str, delivery: &FrickPushDelivery) {
        let event = PushTelemetryEvent {
            tenant_id: delivery.registration.tenant_id.clone(),
            intent: intent_id.to_string(),
            platform: delivery.registration.platform.as_str().to_string(),
            registration_id: delivery.registration.registration_id.clone(),
            user_id: delivery.registration.user_id.clone(),
            status: delivery.status.as_str().to_string(),
            error_code: delivery.error.as_ref().map(|e| e.code.clone()),
            receipt_id: delivery.receipt_id.clone(),
        };
        self.telemetry.record(&event);
    }

    /// The boxed `push.deliver` job handler. Register it on the
    /// [`JobHandlerRegistry`](crate::jobs::JobHandlerRegistry) under
    /// [`PUSH_DELIVER_JOB_TYPE`].
    #[must_use]
    pub fn job_handler(self: &Arc<Self>) -> Arc<dyn JobHandler> {
        Arc::new(PushDeliverHandler {
            router: Arc::clone(self),
        })
    }

    /// Run the `push.deliver` job body for a payload (TS `handler`,
    /// router.ts:165-197). Exposed for direct testing.
    pub async fn run_job(&self, payload: &Value) -> Result<Value, JobError> {
        let intent = match decode_intent(payload) {
            Ok(intent) => intent,
            Err(message) => {
                return Err(JobError::fatal("push.invalidIntent", message));
            }
        };
        match self.deliver(&intent).await {
            Ok(deliveries) => Ok(job_result(&intent, &deliveries)),
            Err(error) => Err(JobError::retryable("push.routerError", error.to_string())),
        }
    }
}

/// Purpose-limit PushKit tokens to incoming calls and keep ordinary APNs
/// tokens out of the VoIP path. Other platforms retain call delivery (Android
/// high-priority FCM and browser Web Push), while the test adapter remains a
/// useful platform-neutral conformance seam.
fn platform_accepts_intent(platform: PushPlatform, intent: &str) -> bool {
    match (platform, intent) {
        (PushPlatform::ApnsVoip, "call.ringing") => true,
        (PushPlatform::ApnsVoip, _) | (PushPlatform::Apns, "call.ringing") => false,
        _ => true,
    }
}

/// The `push.deliver` [`JobHandler`] (TS handler arm, router.ts:165-197).
struct PushDeliverHandler {
    router: Arc<NotificationRouter>,
}

impl JobHandler for PushDeliverHandler {
    fn handle<'a>(&'a self, ctx: JobContext<'a>) -> JobHandlerFuture<'a> {
        Box::pin(async move { self.router.run_job(&ctx.payload).await })
    }
}

/// `encodeIntent` (router.ts:210-219): the `push.deliver` payload. Keys in order
/// `intent, tenantId, recipientUserIds, body[, threadId][, deepLink]`, omitting
/// absent optionals. `body` is `{ [title][, body][, data] }`.
#[must_use]
pub fn encode_intent(intent: &FrickNotificationIntent) -> Value {
    let mut entries: Vec<(Value, Value)> = vec![
        (Value::from("intent"), Value::from(intent.intent.as_str())),
        (
            Value::from("tenantId"),
            Value::from(intent.tenant_id.as_str()),
        ),
        (
            Value::from("recipientUserIds"),
            Value::Array(
                intent
                    .recipient_user_ids
                    .iter()
                    .map(|u| Value::from(u.as_str()))
                    .collect(),
            ),
        ),
        (Value::from("body"), encode_body(&intent.body)),
    ];
    if let Some(thread_id) = &intent.thread_id {
        entries.push((Value::from("threadId"), Value::from(thread_id.as_str())));
    }
    if let Some(deep_link) = &intent.deep_link {
        entries.push((Value::from("deepLink"), Value::from(deep_link.as_str())));
    }
    Value::Map(entries)
}

fn encode_body(body: &NotificationBody) -> Value {
    let mut entries: Vec<(Value, Value)> = Vec::new();
    if let Some(title) = &body.title {
        entries.push((Value::from("title"), Value::from(title.as_str())));
    }
    if let Some(text) = &body.body {
        entries.push((Value::from("body"), Value::from(text.as_str())));
    }
    if let Some(data) = &body.data {
        entries.push((Value::from("data"), data.clone()));
    }
    Value::Map(entries)
}

/// `decodeIntent` (router.ts:221-259): validate the `push.deliver` payload into
/// an intent. Returns a human-readable error string on rejection (→
/// `push.invalidIntent`).
///
/// Rules: payload must be a non-array map; `intent`/`tenantId` non-empty
/// strings; `recipientUserIds` an array of non-empty strings; `body` defaults
/// `{}` and only string `title`/`body` and a map `data` are kept; string
/// `threadId`/`deepLink` copied if present.
pub fn decode_intent(payload: &Value) -> Result<FrickNotificationIntent, String> {
    let Value::Map(entries) = payload else {
        return Err("push.deliver payload must be an object".to_string());
    };
    let get = |key: &str| -> Option<&Value> {
        entries
            .iter()
            .find(|(k, _)| k.as_str() == Some(key))
            .map(|(_, v)| v)
    };

    let intent = get("intent")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("push.deliver payload.intent must be a non-empty string")?
        .to_string();
    let tenant_id = get("tenantId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("push.deliver payload.tenantId must be a non-empty string")?
        .to_string();

    let Some(Value::Array(recipient_values)) = get("recipientUserIds") else {
        return Err("push.deliver payload.recipientUserIds must be an array".to_string());
    };
    let mut recipient_user_ids = Vec::with_capacity(recipient_values.len());
    for value in recipient_values {
        let Some(user) = value.as_str().filter(|s| !s.is_empty()) else {
            return Err("push.deliver payload.recipientUserIds must be strings".to_string());
        };
        recipient_user_ids.push(user.to_string());
    }

    let body = match get("body") {
        Some(Value::Map(body_entries)) => decode_body(body_entries),
        _ => NotificationBody::default(),
    };

    let thread_id = get("threadId").and_then(Value::as_str).map(str::to_string);
    let deep_link = get("deepLink").and_then(Value::as_str).map(str::to_string);

    Ok(FrickNotificationIntent {
        intent,
        tenant_id,
        recipient_user_ids,
        body,
        thread_id,
        deep_link,
    })
}

fn decode_body(entries: &[(Value, Value)]) -> NotificationBody {
    let get = |key: &str| -> Option<&Value> {
        entries
            .iter()
            .find(|(k, _)| k.as_str() == Some(key))
            .map(|(_, v)| v)
    };
    NotificationBody {
        title: get("title").and_then(Value::as_str).map(str::to_string),
        body: get("body").and_then(Value::as_str).map(str::to_string),
        // Only a map `data` is kept (a non-array object in TS).
        data: get("data").filter(|v| matches!(v, Value::Map(_))).cloned(),
    }
}

/// The completed-job result (router.ts:178-185): `{ intent, tenantId,
/// deliveries: serializeDelivery[] }`.
fn job_result(intent: &FrickNotificationIntent, deliveries: &[FrickPushDelivery]) -> Value {
    Value::Map(vec![
        (Value::from("intent"), Value::from(intent.intent.as_str())),
        (
            Value::from("tenantId"),
            Value::from(intent.tenant_id.as_str()),
        ),
        (
            Value::from("deliveries"),
            Value::Array(deliveries.iter().map(serialize_delivery).collect()),
        ),
    ])
}

/// `serializeDelivery` (router.ts:261-273): `{ registrationId, userId,
/// deviceId, platform, attemptedAt, status[, error][, receiptId] }`.
fn serialize_delivery(delivery: &FrickPushDelivery) -> Value {
    let reg = &delivery.registration;
    let mut entries: Vec<(Value, Value)> = vec![
        (
            Value::from("registrationId"),
            Value::from(reg.registration_id.as_str()),
        ),
        (Value::from("userId"), Value::from(reg.user_id.as_str())),
        (Value::from("deviceId"), Value::from(reg.device_id.as_str())),
        (Value::from("platform"), Value::from(reg.platform.as_str())),
        (
            Value::from("attemptedAt"),
            Value::from(delivery.attempted_at.as_str()),
        ),
        (Value::from("status"), Value::from(delivery.status.as_str())),
    ];
    if let Some(error) = &delivery.error {
        entries.push((
            Value::from("error"),
            Value::Map(vec![
                (Value::from("code"), Value::from(error.code.as_str())),
                (Value::from("message"), Value::from(error.message.as_str())),
            ]),
        ));
    }
    if let Some(receipt_id) = &delivery.receipt_id {
        entries.push((Value::from("receiptId"), Value::from(receipt_id.as_str())));
    }
    Value::Map(entries)
}

/// Render epoch milliseconds as a `Date.toISOString`-compatible UTC string. The
/// push subsystem stamps `attemptedAt` from this (the TS uses
/// `new Date().toISOString()`).
#[must_use]
pub fn iso_from_epoch_ms(epoch_ms: i64) -> String {
    crate::boot::iso_from_epoch_ms(epoch_ms)
}

#[cfg(test)]
pub(crate) mod tests_support {
    use frick_store::{FrickStore, FrickStoreOptions};

    /// An in-memory store for adapter/router tests.
    pub async fn store() -> FrickStore {
        FrickStore::open(FrickStoreOptions::memory()).await.unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::registry::{PushAdapter, PushRegistry};
    use crate::push::test_adapter::TestPushAdapter;
    use crate::push::types::{NotificationBody, PushDeliveryStatus};
    use crate::push::{FixedPushClock, RecordingTelemetry};
    use frick_store::stores::push_registration::{
        PushEnvironment, PushPlatform, PushRegistrationInput,
    };

    const NOW: i64 = 1_700_000_000_000;

    fn input(
        user: &str,
        device: &str,
        platform: PushPlatform,
        token: &str,
    ) -> PushRegistrationInput {
        PushRegistrationInput {
            tenant_id: "tenant-1".to_string(),
            user_id: user.to_string(),
            device_id: device.to_string(),
            platform,
            token: token.to_string(),
            environment: PushEnvironment::Production,
        }
    }

    fn intent(recipients: &[&str]) -> FrickNotificationIntent {
        FrickNotificationIntent {
            intent: "message.new".to_string(),
            tenant_id: "tenant-1".to_string(),
            recipient_user_ids: recipients.iter().map(|s| (*s).to_string()).collect(),
            body: NotificationBody {
                title: Some("Hi".to_string()),
                body: Some("there".to_string()),
                data: None,
            },
            thread_id: Some("t-1".to_string()),
            deep_link: None,
        }
    }

    fn router_with(
        store: std::sync::Arc<frick_store::FrickStore>,
        registry: PushRegistry,
        telemetry: RecordingTelemetry,
    ) -> std::sync::Arc<NotificationRouter> {
        std::sync::Arc::new(NotificationRouter::new(NotificationRouterOptions {
            store,
            registry: std::sync::Arc::new(registry),
            clock: std::sync::Arc::new(FixedPushClock(NOW)),
            telemetry: std::sync::Arc::new(telemetry),
            credential_env: std::sync::Arc::new(
                crate::push::credentials::FixedCredentialEnv::default(),
            ),
        }))
    }

    struct PurposeAdapter {
        platform: PushPlatform,
    }

    impl PushAdapter for PurposeAdapter {
        fn platform(&self) -> PushPlatform {
            self.platform
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
                Ok(FrickPushDelivery::delivered(
                    registration.clone(),
                    iso_from_epoch_ms(NOW),
                    None,
                ))
            })
        }
    }

    #[tokio::test]
    async fn deliver_resolves_registrations_dispatches_test_adapter_and_records_telemetry() {
        let store = std::sync::Arc::new(tests_support::store().await);
        // Two active test registrations for user-1.
        store
            .push_registrations()
            .register(
                &input("user-1", "dev-a", PushPlatform::Test, "tok-a"),
                "push-a",
                NOW,
            )
            .await
            .unwrap();
        store
            .push_registrations()
            .register(
                &input("user-1", "dev-b", PushPlatform::Test, "tok-b"),
                "push-b",
                NOW,
            )
            .await
            .unwrap();

        let mut registry = PushRegistry::new();
        let test_adapter = std::sync::Arc::new(TestPushAdapter::with_seams(
            std::sync::Arc::new(FixedPushClock(NOW)),
            std::sync::Arc::new(|| "test-receipt-fixed".to_string()),
        ));
        registry
            .register_adapter(test_adapter.clone() as std::sync::Arc<dyn PushAdapter>)
            .unwrap();
        let telemetry = RecordingTelemetry::new();

        let router = router_with(store.clone(), registry, telemetry.clone());
        // Repeat the recipient — de-dupe must not double-send.
        let deliveries = router
            .deliver(&intent(&["user-1", "user-1"]))
            .await
            .unwrap();

        assert_eq!(deliveries.len(), 2);
        assert!(
            deliveries
                .iter()
                .all(|d| d.status == PushDeliveryStatus::Delivered)
        );
        // The test adapter recorded both (and only both).
        assert_eq!(test_adapter.delivered().len(), 2);
        // attemptedAt stamped from the fixed clock.
        assert_eq!(deliveries[0].attempted_at, iso_from_epoch_ms(NOW));
        // Telemetry: one frick.push.delivery event per delivery.
        let events = telemetry.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].intent, "message.new");
        assert_eq!(events[0].tenant_id, "tenant-1");
        assert_eq!(events[0].platform, "test");
        assert_eq!(events[0].status, "delivered");
        assert_eq!(events[0].receipt_id.as_deref(), Some("test-receipt-fixed"));
        assert_eq!(events[0].user_id, "user-1");
    }

    #[tokio::test]
    async fn deliver_skips_when_no_adapter_for_platform() {
        let store = std::sync::Arc::new(tests_support::store().await);
        store
            .push_registrations()
            .register(
                &input("user-1", "dev-a", PushPlatform::Apns, "tok-a"),
                "push-a",
                NOW,
            )
            .await
            .unwrap();
        // Empty registry: no adapter for apns.
        let telemetry = RecordingTelemetry::new();
        let router = router_with(store.clone(), PushRegistry::new(), telemetry.clone());
        let deliveries = router.deliver(&intent(&["user-1"])).await.unwrap();

        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].status, PushDeliveryStatus::Skipped);
        let error = deliveries[0].error.as_ref().unwrap();
        assert_eq!(error.code, "push.unknownAdapter");
        assert_eq!(error.message, "No adapter registered for platform \"apns\"");
        assert_eq!(telemetry.events()[0].status, "skipped");
        assert_eq!(
            telemetry.events()[0].error_code.as_deref(),
            Some("push.unknownAdapter")
        );
    }

    #[tokio::test]
    async fn purpose_limits_apns_and_pushkit_registrations() {
        let store = std::sync::Arc::new(tests_support::store().await);
        for (id, platform) in [
            ("push-alert", PushPlatform::Apns),
            ("push-voip", PushPlatform::ApnsVoip),
        ] {
            store
                .push_registrations()
                .register(&input("user-1", id, platform, id), id, NOW)
                .await
                .unwrap();
        }

        let mut registry = PushRegistry::new();
        for platform in [PushPlatform::Apns, PushPlatform::ApnsVoip] {
            registry
                .register_adapter(std::sync::Arc::new(PurposeAdapter { platform }))
                .unwrap();
        }
        let router = router_with(store, registry, RecordingTelemetry::new());

        let message_deliveries = router.deliver(&intent(&["user-1"])).await.unwrap();
        assert_eq!(message_deliveries.len(), 1);
        assert_eq!(
            message_deliveries[0].registration.platform,
            PushPlatform::Apns
        );

        let mut call_intent = intent(&["user-1"]);
        call_intent.intent = "call.ringing".to_string();
        let call_deliveries = router.deliver(&call_intent).await.unwrap();
        assert_eq!(call_deliveries.len(), 1);
        assert_eq!(
            call_deliveries[0].registration.platform,
            PushPlatform::ApnsVoip
        );
    }

    // An adapter that always fails with a revocation code, to exercise the
    // router's revoke + telemetry path.
    struct RevokingAdapter;
    impl PushAdapter for RevokingAdapter {
        fn platform(&self) -> PushPlatform {
            PushPlatform::Apns
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
                Ok(FrickPushDelivery::failed(
                    registration.clone(),
                    iso_from_epoch_ms(NOW),
                    "push.unregistered",
                    "APNs 410 Unregistered",
                ))
            })
        }
    }

    #[tokio::test]
    async fn failed_delivery_with_revocation_code_tombstones_registration() {
        let store = std::sync::Arc::new(tests_support::store().await);
        store
            .push_registrations()
            .register(
                &input("user-1", "dev-a", PushPlatform::Apns, "tok-a"),
                "push-a",
                NOW,
            )
            .await
            .unwrap();
        let mut registry = PushRegistry::new();
        registry
            .register_adapter(std::sync::Arc::new(RevokingAdapter))
            .unwrap();
        let router = router_with(store.clone(), registry, RecordingTelemetry::new());

        let deliveries = router.deliver(&intent(&["user-1"])).await.unwrap();
        assert_eq!(deliveries[0].status, PushDeliveryStatus::Failed);
        // The registration is now revoked (the next listByUser excludes it).
        let active = store
            .push_registrations()
            .list_by_user("tenant-1", "user-1")
            .await
            .unwrap();
        assert!(active.is_empty());
        // getById still finds the tombstone with a revoked_at.
        let tombstone = store
            .push_registrations()
            .get_by_id("push-a", "tenant-1")
            .await
            .unwrap()
            .unwrap();
        assert!(tombstone.revoked_at.is_some());
    }

    #[tokio::test]
    async fn job_handler_decode_errors_are_non_retryable() {
        let store = std::sync::Arc::new(tests_support::store().await);
        let router = router_with(store, PushRegistry::new(), RecordingTelemetry::new());
        // Non-object payload → push.invalidIntent, non-retryable.
        let err = router
            .run_job(&Value::from("not an object"))
            .await
            .unwrap_err();
        assert_eq!(err.error_code, "push.invalidIntent");
        assert!(!err.retryable);
    }

    #[tokio::test]
    async fn job_handler_completes_with_serialized_deliveries() {
        let store = std::sync::Arc::new(tests_support::store().await);
        store
            .push_registrations()
            .register(
                &input("user-1", "dev-a", PushPlatform::Test, "tok-a"),
                "push-a",
                NOW,
            )
            .await
            .unwrap();
        let mut registry = PushRegistry::new();
        registry
            .register_adapter(std::sync::Arc::new(TestPushAdapter::with_seams(
                std::sync::Arc::new(FixedPushClock(NOW)),
                std::sync::Arc::new(|| "test-receipt-fixed".to_string()),
            )) as std::sync::Arc<dyn PushAdapter>)
            .unwrap();
        let router = router_with(store, registry, RecordingTelemetry::new());

        let payload = encode_intent(&intent(&["user-1"]));
        let result = router.run_job(&payload).await.unwrap();
        // result.deliveries[0] carries the serialized delivery shape.
        let Value::Map(entries) = &result else {
            panic!("expected map result");
        };
        let deliveries = entries
            .iter()
            .find(|(k, _)| k.as_str() == Some("deliveries"))
            .map(|(_, v)| v)
            .unwrap();
        let Value::Array(items) = deliveries else {
            panic!("deliveries should be an array");
        };
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn encode_decode_intent_round_trips_omitting_optionals() {
        // No threadId / deepLink → omitted on encode; decode yields None.
        let original = FrickNotificationIntent {
            intent: "call.ringing".to_string(),
            tenant_id: "tenant-9".to_string(),
            recipient_user_ids: vec!["user-7".to_string()],
            body: NotificationBody {
                title: None,
                body: Some("ring".to_string()),
                data: Some(Value::Map(vec![(
                    Value::from("callId"),
                    Value::from("c-1"),
                )])),
            },
            thread_id: None,
            deep_link: None,
        };
        let encoded = encode_intent(&original);
        let decoded = decode_intent(&encoded).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn decode_intent_rejects_bad_payloads() {
        assert!(decode_intent(&Value::Array(vec![])).is_err());
        assert!(decode_intent(&Value::Map(vec![])).is_err()); // missing intent
        let no_recipients = Value::Map(vec![
            (Value::from("intent"), Value::from("x")),
            (Value::from("tenantId"), Value::from("t")),
        ]);
        assert!(decode_intent(&no_recipients).is_err());
    }
}
