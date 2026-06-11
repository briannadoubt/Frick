//! Push-notification subsystem (map 06 §3; `apps/server/src/push/*.ts`).
//!
//! This is the privacy-safe, already-translated "what should be delivered to
//! whom" path: an app builds a [`FrickNotificationIntent`], the
//! [`NotificationRouter`](router::NotificationRouter) resolves the recipients'
//! active device registrations (via the finished `push_registration` store),
//! groups by platform, builds the FROZEN [`FrickPushPayload`] wire contract, and
//! dispatches each registration to a platform [`PushAdapter`](registry::PushAdapter).
//! Fan-out, revocation, retries, and delivery telemetry live in the router so
//! adapters stay focused on the platform-specific encoding step.
//!
//! # What lives here
//!
//! - [`types`] — §3.1 core types: [`FrickNotificationIntent`],
//!   [`FrickPushDelivery`], [`PushDeliveryStatus`], the revocation-error-code
//!   set, and the re-exported [`PushPlatform`] / [`PushEnvironment`] /
//!   [`PushDeviceRegistration`] from the store.
//! - [`payload`] — §3.10 the FROZEN [`FrickPushPayload`] wire contract decoded
//!   byte-for-byte by the Swift/Kotlin SDKs.
//! - [`credentials`] — §3.6 per-tenant APNs / FCM / Web Push credential records
//!   and the AES-256-GCM seal/open envelope keyed off `FRICK_PUSH_CRED_KEY`.
//! - [`registry`] — §3.5 the [`PushAdapter`](registry::PushAdapter) trait and
//!   the duplicate-rejecting [`PushRegistry`](registry::PushRegistry).
//! - [`test_adapter`] — §3.11 the in-memory always-`delivered` test adapter.
//! - [`apns_adapter`] / [`fcm_adapter`] / [`webpush_adapter`] — §3.7 / §3.8 /
//!   §3.9 the APNs / FCM / Web Push payload + JWT (and, for Web Push, the RFC
//!   8291 `aes128gcm` content encryption) builders, unit-testable behind a
//!   documented network seam.
//! - [`router`] — §3.4 the [`NotificationRouter`](router::NotificationRouter),
//!   the `push.deliver` [`JobHandler`](crate::jobs::JobHandler), and the
//!   intent encode/decode.
//!
//! # Determinism
//!
//! Time and randomness enter at the boundary. The router and adapters take a
//! [`PushClock`] (`now_ms`) so `attemptedAt`/JWT `iat` are injectable; the test
//! adapter's `receiptId` randomness is injected via a closure. Production wires
//! [`SystemPushClock`]; tests inject a fixed clock.
//!
//! # Integrator wiring
//!
//! See [`router`] for the full recipe. In short:
//! 1. Build a [`PushRegistry`](registry::PushRegistry), register the app's
//!    adapters, then the default [`test_adapter`] for platform `test` (unless an
//!    app already claimed it).
//! 2. Build the [`NotificationRouter`](router::NotificationRouter) over the
//!    `Arc<FrickStore>` + the registry + a [`PushClock`] + a
//!    [`PushTelemetry`] sink.
//! 3. Register [`NotificationRouter::job_handler`](router::NotificationRouter::job_handler)
//!    on the [`JobHandlerRegistry`](crate::jobs::JobHandlerRegistry) under
//!    [`PUSH_DELIVER_JOB_TYPE`](router::PUSH_DELIVER_JOB_TYPE).
//! 4. Merge [`admin_push_router`](crate::routes::admin_push::admin_push_router)
//!    into the server router (see that module's docs).

pub mod apns_adapter;
pub mod credentials;
pub mod fcm_adapter;
pub mod payload;
pub mod registry;
pub mod router;
pub mod test_adapter;
pub mod transports;
pub mod types;
pub mod webpush_adapter;

pub use credentials::{
    APNS_SETTINGS_KEY, ApnsCredentials, FCM_SETTINGS_KEY, FcmCredentials, PushCredentialError,
    PushCredentialErrorCode, PushCredentials, WEB_PUSH_SETTINGS_KEY, WebPushCredentials,
    decrypt_credential, encrypt_credential, load_apns_credentials, load_fcm_credentials,
    load_web_push_credentials, save_apns_credentials, save_fcm_credentials,
    save_web_push_credentials,
};
pub use payload::FrickPushPayload;
pub use registry::{DuplicatePushAdapterError, PushAdapter, PushRegistry};
pub use router::{NotificationRouter, PUSH_DELIVER_JOB_TYPE, decode_intent, encode_intent};
pub use test_adapter::TestPushAdapter;
pub use transports::{ReqwestApnsTransport, ReqwestFcmTransport, ReqwestWebPushTransport};
pub use types::{
    FrickNotificationContext, FrickNotificationIntent, FrickPushDelivery, NotificationBody,
    PUSH_REVOCATION_ERROR_CODES, PushDeliveryError, PushDeliveryStatus, is_push_revocation_error,
};

// Re-export the store-side registration types so push callers have one import.
pub use frick_store::stores::push_registration::{
    PushDeviceRegistration, PushEnvironment, PushPlatform,
};

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use frick_store::FrickStore;

use crate::push::apns_adapter::{ApnsAdapter, ApnsAdapterOptions, ApnsTransport};
use crate::push::credentials::CredentialEnv;
use crate::push::fcm_adapter::{FcmAdapter, FcmAdapterOptions, FcmTransport};
use crate::push::router::NotificationRouterOptions;
use crate::push::webpush_adapter::{WebPushAdapter, WebPushAdapterOptions, WebPushTransport};

/// The wired push subsystem returned by [`build_push_subsystem`]: the populated
/// adapter registry (held so the server can [`close_all`](PushRegistry::close_all)
/// at shutdown) and the [`NotificationRouter`] (registered on the job registry
/// under [`PUSH_DELIVER_JOB_TYPE`](router::PUSH_DELIVER_JOB_TYPE) and shared with
/// the admin-push routes).
pub struct PushSubsystem {
    /// The populated adapter registry (APNs, FCM, Web Push, test).
    pub registry: Arc<PushRegistry>,
    /// The notification router over the store + registry.
    pub router: Arc<NotificationRouter>,
}

/// The transport seams [`build_push_subsystem`] installs into the three live
/// adapters. Production wires [`production_transports`] (the real `reqwest`
/// clients); tests pass recording/stub transports so the whole boot path is
/// driven without touching the network.
pub struct PushTransports {
    /// APNs HTTP/2 transport.
    pub apns: Arc<dyn ApnsTransport>,
    /// FCM HTTP transport (token exchange + send).
    pub fcm: Arc<dyn FcmTransport>,
    /// Web Push HTTPS transport (owns the send-time SSRF DNS re-screen).
    pub web_push: Arc<dyn WebPushTransport>,
}

impl PushTransports {
    /// The live `reqwest`-backed transports (rustls). Wired by [`create_frick_server`].
    ///
    /// [`create_frick_server`]: crate::boot::create_frick_server
    #[must_use]
    pub fn production() -> Self {
        Self {
            apns: Arc::new(ReqwestApnsTransport::new()),
            fcm: Arc::new(ReqwestFcmTransport::new()),
            web_push: Arc::new(ReqwestWebPushTransport::new()),
        }
    }
}

/// Build the push subsystem: a [`PushRegistry`] populated with the APNs, FCM, and
/// Web Push adapters (each over the supplied transport + credential env) plus the
/// default `test` adapter, and a [`NotificationRouter`] over the store + that
/// registry.
///
/// Per-tenant credentials are read lazily by each adapter via the
/// [`CredentialEnv`] seam (`FRICK_PUSH_CRED_KEY`): a tenant with no creds for a
/// platform simply produces a `skipped` delivery — the adapter is always
/// registered, so this never panics and never blocks boot. The three live
/// adapters are always registered (single-tenant / `_default` and the
/// no-credentials case are handled gracefully downstream, not by omitting the
/// adapter).
///
/// `transports` lets a caller swap in recording transports for the boot-wiring
/// tests; production passes [`PushTransports::production`].
///
/// # Panics
///
/// Panics if two adapters claim the same platform — impossible here because the
/// four platforms (APNs, FCM, Web Push, test) are distinct and the registry is
/// freshly constructed. The `expect`s document that boot invariant.
#[must_use]
pub fn build_push_subsystem(
    store: Arc<FrickStore>,
    clock: SharedPushClock,
    telemetry: SharedPushTelemetry,
    credential_env: Arc<dyn CredentialEnv + Send + Sync>,
    transports: PushTransports,
) -> PushSubsystem {
    let mut registry = PushRegistry::new();

    let apns = ApnsAdapter::new(ApnsAdapterOptions {
        clock: Arc::clone(&clock),
        env: Arc::clone(&credential_env),
        transport: transports.apns,
        endpoint: None,
    });
    let fcm = FcmAdapter::new(FcmAdapterOptions {
        clock: Arc::clone(&clock),
        env: Arc::clone(&credential_env),
        transport: transports.fcm,
        fcm_base_url: None,
        token_uri: None,
    });
    let web_push = WebPushAdapter::new(WebPushAdapterOptions {
        clock: Arc::clone(&clock),
        env: Arc::clone(&credential_env),
        transport: transports.web_push,
    });

    // Registering each adapter is infallible here — the registry only errors on a
    // duplicate platform, and these four platforms are distinct. `expect` documents
    // that invariant rather than silently dropping an adapter.
    registry
        .register_adapter(Arc::new(apns) as Arc<dyn PushAdapter>)
        .expect("apns adapter is the only apns adapter");
    registry
        .register_adapter(Arc::new(fcm) as Arc<dyn PushAdapter>)
        .expect("fcm adapter is the only fcm adapter");
    registry
        .register_adapter(Arc::new(web_push) as Arc<dyn PushAdapter>)
        .expect("web push adapter is the only web push adapter");
    // The default `test` adapter (local dev + the conformance suite) unless an
    // app already claimed `test`.
    if !registry.contains(PushPlatform::Test) {
        registry
            .register_adapter(Arc::new(TestPushAdapter::new()) as Arc<dyn PushAdapter>)
            .expect("test adapter is the only test adapter");
    }

    let registry = Arc::new(registry);
    let router = Arc::new(NotificationRouter::new(NotificationRouterOptions {
        store,
        registry: Arc::clone(&registry),
        clock,
        telemetry,
        credential_env,
    }));

    PushSubsystem { registry, router }
}

/// Clock seam for the push subsystem (the TS adapters take an injectable
/// `now: () => number`). `now_ms()` returns epoch milliseconds; the router
/// renders `attemptedAt` from it and the adapters derive the JWT `iat`
/// (`floor(now_ms / 1000)`). Production wires [`SystemPushClock`]; tests inject
/// a fixed clock so `attemptedAt`/`iat` are deterministic.
pub trait PushClock: Send + Sync {
    /// Current time as epoch milliseconds.
    fn now_ms(&self) -> i64;
}

/// Production [`PushClock`] reading the system wall clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemPushClock;

impl PushClock for SystemPushClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }
}

/// A fixed-time [`PushClock`] for deterministic tests.
#[derive(Debug, Clone, Copy)]
pub struct FixedPushClock(pub i64);

impl PushClock for FixedPushClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

/// A shareable [`PushClock`].
pub type SharedPushClock = Arc<dyn PushClock>;

/// Telemetry sink for delivery events (the TS router fires a DevTools
/// `frick.push.delivery` event per delivery, §3.4 step 5). The Rust DevTools
/// event store is a later story (FR-249), so the router records through this
/// seam instead of coupling to it directly: production wires a sink that writes
/// the DevTools event; tests inject [`RecordingTelemetry`] to assert the fields.
///
/// `record` is fire-and-forget on the router's side — it MUST NOT block or
/// fail the delivery (it is called after the delivery outcome is decided).
pub trait PushTelemetry: Send + Sync {
    /// Record one delivery-telemetry event. Fields mirror the TS DevTools event
    /// `frick.push.delivery` (`{intent, platform, registrationId, userId,
    /// status[, errorCode][, receiptId]}`).
    fn record(&self, event: &PushTelemetryEvent);
}

/// One `frick.push.delivery` telemetry record (§3.4 step 5). `tenant_id` is the
/// DevTools event's `tenantId`; the rest are its `fields`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTelemetryEvent {
    /// Tenant the delivery belongs to (DevTools event `tenantId`).
    pub tenant_id: String,
    /// The intent's semantic id (`intent`).
    pub intent: String,
    /// Target platform wire literal (`platform`).
    pub platform: String,
    /// Target registration id (`registrationId`).
    pub registration_id: String,
    /// Recipient user id (`userId`).
    pub user_id: String,
    /// Delivery status wire literal (`status`).
    pub status: String,
    /// Error code when the delivery failed/was skipped (`errorCode`), else `None`.
    pub error_code: Option<String>,
    /// Platform receipt id when present (`receiptId`), else `None`.
    pub receipt_id: Option<String>,
}

/// A no-op [`PushTelemetry`] sink — drops every event. Use when telemetry is
/// disabled or until the DevTools event store (FR-249) is wired.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopTelemetry;

impl PushTelemetry for NoopTelemetry {
    fn record(&self, _event: &PushTelemetryEvent) {}
}

/// A test [`PushTelemetry`] sink that records every event in order. Cheaply
/// cloneable (shares the buffer); call [`events`](RecordingTelemetry::events)
/// to read the recorded list.
#[derive(Debug, Clone, Default)]
pub struct RecordingTelemetry {
    events: Arc<std::sync::Mutex<Vec<PushTelemetryEvent>>>,
}

impl RecordingTelemetry {
    /// An empty recorder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot the recorded events, in order.
    #[must_use]
    pub fn events(&self) -> Vec<PushTelemetryEvent> {
        self.events.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl PushTelemetry for RecordingTelemetry {
    fn record(&self, event: &PushTelemetryEvent) {
        if let Ok(mut events) = self.events.lock() {
            events.push(event.clone());
        }
    }
}

/// A shareable [`PushTelemetry`] sink.
pub type SharedPushTelemetry = Arc<dyn PushTelemetry>;
