//! Boot-wiring integration test for push delivery (FR-265).
//!
//! Proves the three things the assignment requires:
//!   (a) after `create_frick_server`, the durable-job `JobHandlerRegistry`
//!       resolves `push.deliver` to a real handler (it dead-lettered as
//!       `jobs.unknownHandler` before this story);
//!   (b) a `push.deliver` job dispatched through boot's wiring reaches the
//!       registered platform adapter and its (recording) transport — the full
//!       `enqueue → worker → router → adapter → transport` path; and
//!   (c) the three request-builders (APNs / FCM / Web Push) produce correct
//!       requests (endpoint/path, headers, auth shape, content-encoding).
//!
//! Live APNs/FCM/Web Push endpoints are unreachable from CI, so (b) drives the
//! path with a RECORDING transport injected via `BootSeams`: the test asserts
//! the request the adapter built actually arrives at the transport. Live network
//! delivery is, by construction, not verifiable here.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use frick_server::config::load_frick_config;
use frick_server::jobs::{JobWorker, JobWorkerOptions, StoreProvider};
use frick_server::push::apns_adapter::{
    APNS_PRODUCTION_ENDPOINT, ApnsAdapter, ApnsAdapterOptions, ApnsRequest, ApnsResponse,
    ApnsTransport, UnavailableApnsTransport,
};
use frick_server::push::credentials::{ApnsCredentials, FixedCredentialEnv, save_apns_credentials};
use frick_server::push::fcm_adapter::{FcmAdapter, FcmAdapterOptions, UnavailableFcmTransport};
use frick_server::push::types::{FrickNotificationIntent, NotificationBody};
use frick_server::push::webpush_adapter::{
    UnavailableWebPushTransport, WebPushAdapter, WebPushAdapterOptions,
};
use frick_server::push::{FixedPushClock, NoopTelemetry, PUSH_DELIVER_JOB_TYPE, PushTransports};
use frick_server::{BootSeams, FrickConfig, create_frick_server_with_seams};
use frick_store::stores::push_registration::{
    PushEnvironment, PushPlatform, PushRegistrationInput,
};

const NOW_MS: i64 = 1_700_000_000_000;
const CRED_KEY: [u8; 32] = [5u8; 32];

fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

const EC_KEY_PEM: &str = include_str!("../src/push/test_ec_key.pem");

fn apns_creds() -> ApnsCredentials {
    ApnsCredentials {
        key_id: "ABC1234567".to_string(),
        team_id: "TEAM123456".to_string(),
        bundle_id: "dev.frick.app".to_string(),
        private_key_pem: EC_KEY_PEM.to_string(),
        use_sandbox: false,
    }
}

/// A recording APNs transport: captures every request and replies 200 so the
/// router records a `delivered` and touches the registration.
#[derive(Default)]
struct RecordingApnsTransport {
    requests: Mutex<Vec<ApnsRequest>>,
}

impl RecordingApnsTransport {
    fn requests(&self) -> Vec<ApnsRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl ApnsTransport for RecordingApnsTransport {
    fn send<'a>(
        &'a self,
        request: &'a ApnsRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ApnsResponse, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request.clone());
            Ok(ApnsResponse {
                status: 200,
                apns_id: Some("apns-id-recorded".to_string()),
                body: String::new(),
            })
        })
    }
}

/// Seams that wire a recording APNs transport (and inert FCM/Web Push
/// transports) plus a fixed clock + credential env, so the boot path is fully
/// offline and deterministic.
fn recording_seams(apns: Arc<RecordingApnsTransport>) -> BootSeams {
    BootSeams {
        push_clock: Arc::new(FixedPushClock(NOW_MS)),
        push_telemetry: Arc::new(NoopTelemetry),
        credential_env: Arc::new(FixedCredentialEnv::from_key(&CRED_KEY)),
        push_transports: PushTransports {
            apns,
            fcm: Arc::new(UnavailableFcmTransport),
            web_push: Arc::new(UnavailableWebPushTransport),
        },
        email_router: Arc::new(frick_server::EmailRouter::noop()),
        // FR-269: the provider-verify JWKS seam is unused by these push tests;
        // take the production default.
        jwks_provider: BootSeams::production().jwks_provider,
        // FR-272: no blob processors for the push wiring tests.
        blob_processors: Vec::new(),
        // FR-296: no policy hooks for the push wiring tests.
        policy_hooks: Vec::new(),
        // FR-297: no app routes for the push wiring tests.
        app_router: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn boot_registers_push_deliver_handler() {
    // (a) The handler registry resolves `push.deliver` after boot.
    let server = create_frick_server_with_seams(
        test_config(),
        frick_protocol::foundation_schema(),
        recording_seams(Arc::new(RecordingApnsTransport::default())),
    )
    .await
    .unwrap();

    assert!(
        server.jobs.contains(PUSH_DELIVER_JOB_TYPE),
        "boot must register a push.deliver handler so the worker resolves it"
    );
    assert!(
        server.jobs.resolve(PUSH_DELIVER_JOB_TYPE).is_some(),
        "push.deliver must resolve to a real handler"
    );
    // The adapter registry holds all four platforms (the three live adapters +
    // the default `test` adapter).
    for platform in [
        PushPlatform::Apns,
        PushPlatform::Fcm,
        PushPlatform::WebPush,
        PushPlatform::Test,
    ] {
        assert!(
            server.state.push_registry.contains(platform),
            "registry must contain an adapter for {platform:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn deliver_job_reaches_the_recording_transport_through_boot() {
    // (b) A push.deliver job dispatched through boot's registry reaches the
    // platform adapter's recording transport — end-to-end.
    let apns = Arc::new(RecordingApnsTransport::default());
    let server = create_frick_server_with_seams(
        test_config(),
        frick_protocol::foundation_schema(),
        recording_seams(Arc::clone(&apns)),
    )
    .await
    .unwrap();

    // Seed per-tenant APNs credentials (so the adapter can build a request) and
    // one active APNs registration for user-1.
    save_apns_credentials(
        server.state.store.tenant_settings(),
        "_default",
        &apns_creds(),
        &FixedCredentialEnv::from_key(&CRED_KEY),
        NOW_MS,
    )
    .await
    .unwrap();
    server
        .state
        .store
        .push_registrations()
        .register(
            &PushRegistrationInput {
                tenant_id: "_default".to_string(),
                user_id: "user-1".to_string(),
                device_id: "dev-a".to_string(),
                platform: PushPlatform::Apns,
                token: "device-token-xyz".to_string(),
                environment: PushEnvironment::Production,
            },
            "push-a",
            NOW_MS,
        )
        .await
        .unwrap();

    // Enqueue a push.deliver job through the SAME router boot registered.
    let intent = FrickNotificationIntent {
        intent: "message.new".to_string(),
        tenant_id: "_default".to_string(),
        recipient_user_ids: vec!["user-1".to_string()],
        body: NotificationBody {
            title: Some("Hi".to_string()),
            body: Some("there".to_string()),
            data: None,
        },
        thread_id: None,
        deep_link: None,
    };
    let row = server
        .state
        .notification_router
        .enqueue_intent(&intent, NOW_MS)
        .await
        .unwrap();
    assert_eq!(row.job_type, PUSH_DELIVER_JOB_TYPE);

    // Drive ONE worker tick deterministically (no timer): build a worker over the
    // server's StoreProvider + the boot job registry — exactly what listen() runs.
    let worker = JobWorker::new(JobWorkerOptions {
        store: Arc::clone(&server.state) as Arc<dyn StoreProvider>,
        registry: Arc::clone(&server.jobs),
        worker_id: "worker-wiring-test".to_string(),
        poll_interval_ms: None,
        claim_batch_size: None,
    });
    let processed = worker.poll_once(NOW_MS).await;
    assert_eq!(
        processed, 1,
        "the push.deliver job must be claimed + processed"
    );

    // The recording transport received exactly one correctly-shaped request.
    let requests = apns.requests();
    assert_eq!(
        requests.len(),
        1,
        "the APNs adapter must reach the transport"
    );
    let request = &requests[0];
    assert_eq!(request.endpoint, APNS_PRODUCTION_ENDPOINT);
    assert_eq!(request.device_token, "device-token-xyz");
    assert!(request.authorization.starts_with("bearer "));
    assert_eq!(request.apns_topic, "dev.frick.app");
    assert_eq!(request.apns_push_type, "alert");

    // The job completed (not dead-lettered as jobs.unknownHandler).
    let job = server
        .state
        .store
        .jobs()
        .get_by_id(row.id, None, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        job.status,
        frick_store::stores::job::JobStatus::Completed,
        "the push.deliver job completed; last_error: {:?}",
        job.last_error_code
    );
}

#[tokio::test]
async fn request_builders_produce_correct_requests() {
    // (c) The three request-builders produce correct requests. The APNs + FCM
    // builders need credentials in a store; the Web Push builder is asserted via
    // its content-encoding on an encrypted request. (The exhaustive per-field
    // assertions live in each adapter's unit tests; this consolidates the boot
    // contract: each adapter, as wired, builds a real provider request.)
    let store = Arc::new(
        frick_store::FrickStore::open(frick_store::FrickStoreOptions::memory())
            .await
            .unwrap(),
    );
    let env = FixedCredentialEnv::from_key(&CRED_KEY);
    save_apns_credentials(
        store.tenant_settings(),
        "_default",
        &apns_creds(),
        &env,
        NOW_MS,
    )
    .await
    .unwrap();

    // --- APNs ---
    let apns = ApnsAdapter::new(ApnsAdapterOptions {
        clock: Arc::new(FixedPushClock(NOW_MS)),
        env: Arc::new(FixedCredentialEnv::from_key(&CRED_KEY)),
        transport: Arc::new(UnavailableApnsTransport),
        endpoint: None,
    });
    let intent = FrickNotificationIntent {
        intent: "message.new".to_string(),
        tenant_id: "_default".to_string(),
        recipient_user_ids: vec!["user-1".to_string()],
        body: NotificationBody::default(),
        thread_id: None,
        deep_link: None,
    };
    let reg = PushDeviceRegistration::apns("device-token-xyz");
    let apns_request = apns.build_request(&intent, &reg, &store).await.unwrap();
    assert_eq!(apns_request.endpoint, APNS_PRODUCTION_ENDPOINT);
    assert_eq!(apns_request.apns_topic, "dev.frick.app");
    assert!(apns_request.authorization.starts_with("bearer "));

    // --- FCM ---
    let fcm = FcmAdapter::new(FcmAdapterOptions {
        clock: Arc::new(FixedPushClock(NOW_MS)),
        env: Arc::new(FixedCredentialEnv::from_key(&CRED_KEY)),
        transport: Arc::new(UnavailableFcmTransport),
        fcm_base_url: None,
        token_uri: None,
    });
    let fcm_reg = PushDeviceRegistration::fcm("fcm-token");
    let fcm_request = fcm.build_send_request(&intent, &fcm_reg, "frick-demo", "tok-xyz");
    assert_eq!(
        fcm_request.url,
        "https://fcm.googleapis.com/v1/projects/frick-demo/messages:send"
    );
    assert_eq!(fcm_request.authorization.as_deref(), Some("Bearer tok-xyz"));

    // --- Web Push ---
    let web_push = WebPushAdapter::new(WebPushAdapterOptions {
        clock: Arc::new(FixedPushClock(NOW_MS)),
        env: Arc::new(FixedCredentialEnv::from_key(&CRED_KEY)),
        transport: Arc::new(UnavailableWebPushTransport),
    });
    // Web Push needs VAPID creds + a subscription token to build an encrypted
    // request; assert the content-encoding the adapter produces.
    save_web_push_creds(&store).await;
    let wp_intent = FrickNotificationIntent {
        intent: "message.new".to_string(),
        tenant_id: "_default".to_string(),
        recipient_user_ids: vec!["user-1".to_string()],
        body: NotificationBody {
            title: Some("Hi".to_string()),
            body: Some("there".to_string()),
            data: None,
        },
        thread_id: None,
        deep_link: None,
    };
    let wp_reg = PushDeviceRegistration::web_push(WEB_PUSH_SUBSCRIPTION);
    let wp_request = web_push
        .build_request(&wp_intent, &wp_reg, &store)
        .await
        .unwrap();
    assert!(
        wp_request.endpoint.starts_with("https://push.example.com/"),
        "endpoint was {}",
        wp_request.endpoint
    );
    assert_eq!(wp_request.content_encoding.as_deref(), Some("aes128gcm"));
    assert!(wp_request.authorization.starts_with("vapid t="));
    assert!(
        !wp_request.body.is_empty(),
        "encrypted body must be non-empty"
    );
}

// ---- Web Push fixtures -------------------------------------------------------

// A subscription with real browser keys so the adapter encrypts (aes128gcm).
// p256dh is a valid uncompressed P-256 point; auth is 16 bytes (base64url).
const WEB_PUSH_SUBSCRIPTION: &str = r#"{"endpoint":"https://push.example.com/sub/abc","keys":{"p256dh":"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4","auth":"BTBZMqHH6r4Tts7J_aSIgg"}}"#;

// A VAPID keypair (P-256). The private key is a PKCS#8 PEM; the public key is
// the base64url uncompressed point. These need not match the subscription keys.
const VAPID_PRIVATE_PEM: &str = include_str!("../src/push/test_ec_key.pem");
const VAPID_PUBLIC_B64: &str =
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

async fn save_web_push_creds(store: &frick_store::FrickStore) {
    use frick_server::push::credentials::{WebPushCredentials, save_web_push_credentials};
    save_web_push_credentials(
        store.tenant_settings(),
        "_default",
        &WebPushCredentials {
            subject: "mailto:ops@frick.dev".to_string(),
            public_key: VAPID_PUBLIC_B64.to_string(),
            private_key: VAPID_PRIVATE_PEM.to_string(),
        },
        &FixedCredentialEnv::from_key(&CRED_KEY),
        NOW_MS,
    )
    .await
    .unwrap();
}

// ---- registration fixtures ---------------------------------------------------

use frick_store::stores::push_registration::PushDeviceRegistration;

trait RegistrationFixture {
    fn apns(token: &str) -> Self;
    fn fcm(token: &str) -> Self;
    fn web_push(token: &str) -> Self;
}

impl RegistrationFixture for PushDeviceRegistration {
    fn apns(token: &str) -> Self {
        reg(PushPlatform::Apns, token)
    }
    fn fcm(token: &str) -> Self {
        reg(PushPlatform::Fcm, token)
    }
    fn web_push(token: &str) -> Self {
        reg(PushPlatform::WebPush, token)
    }
}

fn reg(platform: PushPlatform, token: &str) -> PushDeviceRegistration {
    PushDeviceRegistration {
        registration_id: "push-1".to_string(),
        tenant_id: "_default".to_string(),
        user_id: "user-1".to_string(),
        device_id: "dev-1".to_string(),
        platform,
        token: token.to_string(),
        environment: PushEnvironment::Production,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        last_seen_at: "2026-01-01T00:00:00.000Z".to_string(),
        revoked_at: None,
    }
}

// Touch base64 so the harness compiles even if a future refactor drops the only
// use; documents that the fixed credential key round-trips to 32 bytes.
#[test]
fn fixed_key_round_trips() {
    let encoded = base64::engine::general_purpose::STANDARD.encode(CRED_KEY);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap()
            .len(),
        32
    );
}
