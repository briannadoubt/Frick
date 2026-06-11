use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::*;
use crate::push::FixedPushClock;
use crate::push::credentials::{FixedCredentialEnv, save_web_push_credentials};
use crate::push::types::{NotificationBody, PushDeliveryStatus, PushEnvironment};

const NOW_MS: i64 = 1_700_000_000_000;

// A deterministic EC P-256 PKCS#8 PEM (shared with the APNs tests).
const VAPID_KEY_PEM: &str = include_str!("../test_ec_key.pem");
// base64url uncompressed P-256 public point derived from `VAPID_KEY_PEM`.
const VAPID_PUBLIC_KEY: &str =
    "BAJ_j2bbjJCl0cU-fkye6P2PzcHemSWXpQ4wM3C6xDjCmyATz9N96qt4PDbGVtnyJMQCv3I8e2WVku3ZXSvjEKI";

// A fixed browser subscription keypair (private/public/auth) for the encryption
// round-trip. `P256DH` is the 65-byte uncompressed public point; `UA_PRIVATE` is
// its scalar; `AUTH` is the 16-byte auth secret — all base64url.
const UA_PRIVATE: &str = "qrpwFibSS1BeNK5Fw2QBhkWGAUPH85p9VdVrve1ehbI";
const P256DH: &str =
    "BB4pc_sj0NvjI70tjdu5KrVY7oMZd72Pb3nI0RQVeq3umvuMmKBBda2sTfwuamTV3ylXFwdJiLS1U7pZp_AL2Ok";
const AUTH: &str = "4S26COvxaJgF9GSZHATycg";

const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/abc123";

fn creds() -> WebPushCredentials {
    WebPushCredentials {
        subject: "mailto:ops@frick.dev".to_string(),
        public_key: VAPID_PUBLIC_KEY.to_string(),
        private_key: VAPID_KEY_PEM.to_string(),
    }
}

fn subscription_token(with_keys: bool) -> String {
    if with_keys {
        format!(r#"{{"endpoint":"{ENDPOINT}","keys":{{"p256dh":"{P256DH}","auth":"{AUTH}"}}}}"#)
    } else {
        format!(r#"{{"endpoint":"{ENDPOINT}"}}"#)
    }
}

fn registration(token: String) -> PushDeviceRegistration {
    PushDeviceRegistration {
        registration_id: "push-1".to_string(),
        tenant_id: "tenant-1".to_string(),
        user_id: "user-1".to_string(),
        device_id: "dev-1".to_string(),
        platform: PushPlatform::WebPush,
        token,
        environment: PushEnvironment::Production,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        last_seen_at: "2026-01-01T00:00:00.000Z".to_string(),
        revoked_at: None,
    }
}

fn intent_with(body: NotificationBody) -> FrickNotificationIntent {
    FrickNotificationIntent {
        intent: "message.new".to_string(),
        tenant_id: "tenant-1".to_string(),
        recipient_user_ids: vec!["user-1".to_string()],
        body,
        thread_id: Some("t-1".to_string()),
        deep_link: Some("frick://x".to_string()),
    }
}

fn full_body() -> NotificationBody {
    NotificationBody {
        title: Some("Hi".to_string()),
        body: Some("there".to_string()),
        data: Some(frick_protocol::Value::Map(vec![(
            frick_protocol::Value::from("convoId"),
            frick_protocol::Value::from("c-9"),
        )])),
    }
}

fn adapter() -> WebPushAdapter {
    WebPushAdapter::new(WebPushAdapterOptions {
        clock: Arc::new(FixedPushClock(NOW_MS)),
        env: Arc::new(FixedCredentialEnv::from_key(&[5u8; 32])),
        transport: Arc::new(UnavailableWebPushTransport),
    })
}

async fn store_with_creds() -> frick_store::FrickStore {
    let store = crate::push::router::tests_support::store().await;
    let env = FixedCredentialEnv::from_key(&[5u8; 32]);
    save_web_push_credentials(store.tenant_settings(), "tenant-1", &creds(), &env, NOW_MS)
        .await
        .unwrap();
    store
}

#[test]
fn vapid_jwt_header_and_claims_match_rfc8292() {
    let exp = NOW_MS / 1000 + VAPID_EXP_SECONDS;
    let jwt = sign_vapid_jwt(&creds(), "https://fcm.googleapis.com", exp).unwrap();
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3);

    let header: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    assert_eq!(header["alg"], "ES256");
    assert_eq!(header["typ"], "JWT");

    let claims: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(claims["aud"], "https://fcm.googleapis.com");
    assert_eq!(claims["sub"], "mailto:ops@frick.dev");
    assert_eq!(claims["exp"], exp);

    // IEEE-P1363 r||s signature is 64 bytes, NOT a DER blob.
    let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
    assert_eq!(sig.len(), 64);
}

#[tokio::test]
async fn build_request_carries_vapid_and_content_headers() {
    let store = store_with_creds().await;
    let request = adapter()
        .build_request(
            &intent_with(full_body()),
            &registration(subscription_token(true)),
            &store,
        )
        .await
        .unwrap();

    assert_eq!(request.endpoint, ENDPOINT);
    assert_eq!(request.ttl, WEB_PUSH_TTL);
    // `authorization: vapid t=<jwt>, k=<publicKey>` (RFC 8292 §3).
    assert!(request.authorization.starts_with("vapid t="));
    assert!(
        request
            .authorization
            .ends_with(&format!(", k={VAPID_PUBLIC_KEY}"))
    );
    // Encrypted body present with the aes128gcm content-encoding.
    assert_eq!(request.content_encoding.as_deref(), Some("aes128gcm"));
    assert!(!request.body.is_empty());
    // RFC 8188 framing: salt(16) || rs(4) || idlen(1)=65 || keyid(65) || ct.
    assert!(request.body.len() > 16 + 4 + 1 + 65);
    assert_eq!(
        request.body[20], 65,
        "idlen must be 65 (uncompressed point)"
    );
    assert!(
        request.body.len() <= MAX_WEB_PUSH_PAYLOAD,
        "encrypted body must fit the 4 KB cap"
    );
}

#[tokio::test]
async fn build_request_empty_body_when_no_subscription_keys() {
    let store = store_with_creds().await;
    let request = adapter()
        .build_request(
            &intent_with(full_body()),
            &registration(subscription_token(false)),
            &store,
        )
        .await
        .unwrap();
    // No browser keys → empty-body wake-up push (no content-encoding).
    assert_eq!(request.content_encoding, None);
    assert!(request.body.is_empty());
    assert!(request.authorization.starts_with("vapid t="));
}

#[tokio::test]
async fn build_request_empty_body_when_payload_absent() {
    let store = store_with_creds().await;
    // Title/body/data all absent → no payload → empty-body wake-up even with keys.
    let request = adapter()
        .build_request(
            &intent_with(NotificationBody::default()),
            &registration(subscription_token(true)),
            &store,
        )
        .await
        .unwrap();
    assert_eq!(request.content_encoding, None);
    assert!(request.body.is_empty());
}

#[tokio::test]
async fn missing_credentials_skip_the_delivery() {
    // Store with NO web-push credentials saved.
    let store = crate::push::router::tests_support::store().await;
    let intent = intent_with(full_body());
    let reg = registration(subscription_token(true));
    let ctx = FrickNotificationContext {
        tenant_id: "tenant-1",
        intent: &intent,
        store: &store,
    };
    let delivery = adapter().send(&intent, &reg, &ctx).await.unwrap();
    assert_eq!(delivery.status, PushDeliveryStatus::Skipped);
    assert_eq!(delivery.error.unwrap().code, "push.credentials.missing");
}

#[tokio::test]
async fn unparseable_or_unsafe_token_fails_bad_device_token() {
    let store = store_with_creds().await;
    for token in [
        "not json".to_string(),
        r#"{"endpoint":"http://example.com/x"}"#.to_string(), // not https
        r#"{"endpoint":"https://localhost/x"}"#.to_string(),  // SSRF: localhost
        r#"{"endpoint":"https://169.254.169.254/x"}"#.to_string(), // SSRF: link-local
        r#"{"keys":{}}"#.to_string(),                         // missing endpoint
    ] {
        let intent = intent_with(full_body());
        let reg = registration(token.clone());
        let ctx = FrickNotificationContext {
            tenant_id: "tenant-1",
            intent: &intent,
            store: &store,
        };
        let delivery = adapter().send(&intent, &reg, &ctx).await.unwrap();
        assert_eq!(
            delivery.status,
            PushDeliveryStatus::Failed,
            "token {token:?} should fail"
        );
        let error = delivery.error.unwrap();
        assert_eq!(error.code, "push.badDeviceToken");
        assert_eq!(
            error.message,
            "Registration token is not a valid PushSubscription JSON"
        );
    }
}

#[test]
fn ssrf_guard_classifies_endpoints() {
    // Safe: public https host + public literal IP.
    assert!(is_safe_web_push_endpoint(
        "https://updates.push.services.mozilla.com/wpush/v2/xyz"
    ));
    assert!(is_safe_web_push_endpoint("https://93.184.216.34/x"));
    // Unsafe scheme / hosts / private + special-use ranges.
    assert!(!is_safe_web_push_endpoint("http://example.com/x"));
    assert!(!is_safe_web_push_endpoint("https://localhost/x"));
    assert!(!is_safe_web_push_endpoint("https://a.localhost/x"));
    assert!(!is_safe_web_push_endpoint(
        "https://metadata.google.internal/x"
    ));
    assert!(!is_safe_web_push_endpoint("https://127.0.0.1/x"));
    assert!(!is_safe_web_push_endpoint("https://10.0.0.5/x"));
    assert!(!is_safe_web_push_endpoint("https://192.168.1.1/x"));
    assert!(!is_safe_web_push_endpoint("https://172.16.4.4/x"));
    assert!(!is_safe_web_push_endpoint("https://169.254.0.1/x"));
    assert!(!is_safe_web_push_endpoint("https://[::1]/x"));
    assert!(!is_safe_web_push_endpoint("https://[fe80::1]/x"));
    assert!(!is_safe_web_push_endpoint("https://[fc00::1]/x"));
}

#[test]
fn validate_token_rejects_unsafe_and_accepts_safe() {
    assert!(validate_web_push_registration_token(&subscription_token(true)).is_ok());
    let err = validate_web_push_registration_token("nope").unwrap_err();
    assert!(err.contains("PushSubscription JSON"));
}

#[test]
fn encrypt_round_trips_through_ece_decrypt() {
    use p256::SecretKey;
    use p256::elliptic_curve::sec1::ToEncodedPoint;

    let payload = br#"{"intent":"message.new","title":"Hi"}"#;
    let envelope = encrypt_web_push_payload(payload, P256DH, AUTH).unwrap();

    // RFC 8188 header sanity.
    assert_eq!(&envelope[16..20], &[0x00, 0x00, 0x10, 0x00], "rs == 4096");
    assert_eq!(envelope[20], 65);

    // Decrypt with the subscription's private key via the ece crate — proves the
    // envelope is a valid RFC 8291 message the browser would accept.
    let ua_private = URL_SAFE_NO_PAD.decode(UA_PRIVATE).unwrap();
    let ua_secret = SecretKey::from_slice(&ua_private).unwrap();
    let ua_public = ua_secret.public_key().to_encoded_point(false);
    let components = ece::EcKeyComponents::new(ua_private.clone(), ua_public.as_bytes().to_vec());
    let auth = URL_SAFE_NO_PAD.decode(AUTH).unwrap();

    super::ece_backend::install_cryptographer();
    let decrypted = ece::decrypt(&components, &auth, &envelope).unwrap();
    assert_eq!(decrypted, payload);
}

#[test]
fn encrypt_rejects_malformed_keys() {
    // p256dh not a 65-byte 0x04 point.
    assert!(encrypt_web_push_payload(b"x", "AAAA", AUTH).is_err());
    // auth empty.
    assert!(encrypt_web_push_payload(b"x", P256DH, "").is_err());
}

#[test]
fn encode_notification_payload_key_order_and_omission() {
    // Full payload: intent + title + body + data + threadId + deepLink.
    let json = encode_notification_payload(&intent_with(full_body())).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["intent"], "message.new");
    assert_eq!(value["title"], "Hi");
    assert_eq!(value["body"], "there");
    assert_eq!(value["data"]["convoId"], "c-9");
    assert_eq!(value["threadId"], "t-1");
    assert_eq!(value["deepLink"], "frick://x");

    // Empty body → None (empty-body wake-up fallback).
    let mut bare = intent_with(NotificationBody::default());
    bare.thread_id = None;
    bare.deep_link = None;
    assert!(encode_notification_payload(&bare).is_none());
}

#[test]
fn result_translation_maps_statuses() {
    let reg = registration(subscription_token(true));
    let ok = translate_web_push_result(201, reg.clone(), "t".to_string());
    assert_eq!(ok.status, PushDeliveryStatus::Delivered);
    assert!(ok.receipt_id.is_none());

    let gone = translate_web_push_result(410, reg.clone(), "t".to_string());
    assert_eq!(gone.error.as_ref().unwrap().code, "push.unregistered");
    assert_eq!(gone.error.as_ref().unwrap().message, "Web push 410");

    assert_eq!(
        translate_web_push_result(413, reg.clone(), "t".to_string())
            .error
            .unwrap()
            .code,
        "push.payloadTooLarge"
    );
    assert_eq!(
        translate_web_push_result(429, reg.clone(), "t".to_string())
            .error
            .unwrap()
            .code,
        "push.rateLimited"
    );
    assert_eq!(
        translate_web_push_result(503, reg.clone(), "t".to_string())
            .error
            .unwrap()
            .code,
        "push.serverError"
    );
    assert_eq!(
        translate_web_push_result(400, reg, "t".to_string())
            .error
            .unwrap()
            .code,
        "push.deliveryFailed"
    );
}

#[test]
fn status_mapping_table() {
    assert_eq!(map_web_push_status(404), "push.unregistered");
    assert_eq!(map_web_push_status(410), "push.unregistered");
    assert_eq!(map_web_push_status(413), "push.payloadTooLarge");
    assert_eq!(map_web_push_status(429), "push.rateLimited");
    assert_eq!(map_web_push_status(500), "push.serverError");
    assert_eq!(map_web_push_status(403), "push.deliveryFailed");
}

#[tokio::test]
async fn registers_under_webpush_platform() {
    use crate::push::registry::PushRegistry;
    let mut registry = PushRegistry::new();
    registry
        .register_adapter(Arc::new(adapter()))
        .expect("webPush adapter registers");
    assert!(registry.resolve(PushPlatform::WebPush).is_some());
    assert!(registry.resolve(PushPlatform::Apns).is_none());
}

#[tokio::test]
async fn transport_failure_maps_to_delivery_failed() {
    let store = store_with_creds().await;
    let intent = intent_with(full_body());
    let reg = registration(subscription_token(true));
    let ctx = FrickNotificationContext {
        tenant_id: "tenant-1",
        intent: &intent,
        store: &store,
    };
    // The default UnavailableWebPushTransport always errors.
    let delivery = adapter().send(&intent, &reg, &ctx).await.unwrap();
    assert_eq!(delivery.status, PushDeliveryStatus::Failed);
    let error = delivery.error.unwrap();
    assert_eq!(error.code, "push.deliveryFailed");
    assert!(error.message.starts_with("Web Push transport: "));
}

#[tokio::test]
async fn recording_transport_delivers_on_2xx() {
    use std::sync::Mutex as StdMutex;

    struct Recording {
        seen: StdMutex<Vec<WebPushRequest>>,
        status: u16,
    }
    impl WebPushTransport for Recording {
        fn send<'a>(
            &'a self,
            request: &'a WebPushRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<WebPushResponse, String>> + Send + 'a>,
        > {
            Box::pin(async move {
                self.seen.lock().unwrap().push(request.clone());
                Ok(WebPushResponse {
                    status: self.status,
                })
            })
        }
    }

    let store = store_with_creds().await;
    let transport = Arc::new(Recording {
        seen: StdMutex::new(Vec::new()),
        status: 201,
    });
    let adapter = WebPushAdapter::new(WebPushAdapterOptions {
        clock: Arc::new(FixedPushClock(NOW_MS)),
        env: Arc::new(FixedCredentialEnv::from_key(&[5u8; 32])),
        transport: Arc::clone(&transport) as Arc<dyn WebPushTransport>,
    });
    let intent = intent_with(full_body());
    let reg = registration(subscription_token(true));
    let ctx = FrickNotificationContext {
        tenant_id: "tenant-1",
        intent: &intent,
        store: &store,
    };
    let delivery = adapter.send(&intent, &reg, &ctx).await.unwrap();
    assert_eq!(delivery.status, PushDeliveryStatus::Delivered);
    assert!(delivery.receipt_id.is_none());

    let seen = transport.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].endpoint, ENDPOINT);
    assert_eq!(seen[0].content_encoding.as_deref(), Some("aes128gcm"));
}
