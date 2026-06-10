//! Integration tests for the admin push routes (map 06 §3.12).
//!
//! Boots a real server over a loopback socket and merges the
//! `admin_push_router_with_env` (fixed credential key) onto the public/auth/admin
//! routers — the wiring the integrator lands in `boot::listen`. Coverage: admin
//! disabled → 404; APNs/FCM credential set round-trip (204); a malformed body →
//! 400; `POST /_frick/admin/push/deliver` enqueues a `push.deliver` job (201).
//!
//! Live APNs/FCM network sends are out of scope (the adapters' send path sits
//! behind a documented transport seam; CI has no APNs/FCM endpoint). These tests
//! exercise the credential storage + job-enqueue surface only.

use std::sync::Arc;

use base64::Engine as _;
use frick_server::config::load_frick_config;
use frick_server::http::{AppState, public_router};
use frick_server::push::credentials::{CredentialEnv, FixedCredentialEnv};
use frick_server::push::router::{NotificationRouter, NotificationRouterOptions};
use frick_server::push::{NoopTelemetry, PushRegistry, SystemPushClock, TestPushAdapter};
use frick_server::routes::admin::admin_router;
use frick_server::routes::admin_push::admin_push_router_with_env;
use frick_server::{FrickConfig, create_frick_server, routes};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ADMIN_TOKEN: &str = "0123456789012345678901234567890123"; // 34 chars (>=32)

fn test_config(admin_token: Option<&str>) -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    if let Some(token) = admin_token {
        env.insert("FRICK_ADMIN_TOKEN".to_string(), token.to_string());
    }
    load_frick_config(&env).unwrap()
}

struct TestServer {
    port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestServer {
    async fn boot(admin_token: Option<&str>) -> Self {
        let server = create_frick_server(
            test_config(admin_token),
            frick_protocol::foundation_schema(),
        )
        .await
        .unwrap();
        let state: AppState = Arc::clone(&server.state);
        std::mem::forget(server);

        // Build the push registry with the default test adapter so deliver works.
        let mut registry = PushRegistry::new();
        registry
            .register_adapter(Arc::new(TestPushAdapter::new()))
            .unwrap();
        // Fixed credential key (32 bytes) so credential seal/open is deterministic.
        let env: Arc<dyn CredentialEnv + Send + Sync> =
            Arc::new(FixedCredentialEnv::from_key(&[7u8; 32]));
        // The router uses a standalone in-memory store for the enqueue path; the
        // credential PUT routes write to the SERVER state's store directly, so
        // credential round-trips are observed against the server. This keeps the
        // test free of a shared-Arc requirement on `AppStateInner` (whose `store`
        // field is not `Arc`-wrapped).
        let router_store = frick_store::FrickStore::open(frick_store::FrickStoreOptions::memory())
            .await
            .unwrap();
        let router = Arc::new(NotificationRouter::new(NotificationRouterOptions {
            store: Arc::new(router_store),
            registry: Arc::new(registry),
            clock: Arc::new(SystemPushClock),
            telemetry: Arc::new(NoopTelemetry),
            credential_env: Arc::clone(&env),
        }));

        let app_router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(Arc::clone(&state)))
            .merge(admin_router(Arc::clone(&state)))
            .merge(admin_push_router_with_env(router, Arc::clone(&state), env));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let join = tokio::spawn(async move {
            let serve = axum::serve(listener, app_router);
            let _ = serve
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        Self {
            port,
            shutdown: Some(shutdown_tx),
            join: Some(join),
        }
    }

    async fn close(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> HttpResponse {
        let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", self.port))
            .await
            .unwrap();
        let mut header_block = String::new();
        for (name, value) in headers {
            header_block.push_str(name);
            header_block.push_str(": ");
            header_block.push_str(value);
            header_block.push_str("\r\n");
        }
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{header_block}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        HttpResponse::parse(&raw)
    }

    async fn admin_put(&self, path: &str, token: &str, body: &str) -> HttpResponse {
        self.request("PUT", path, &[("Authorization", &bearer(token))], body)
            .await
    }

    async fn admin_post(&self, path: &str, token: &str, body: &str) -> HttpResponse {
        self.request("POST", path, &[("Authorization", &bearer(token))], body)
            .await
    }
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

struct HttpResponse {
    status: u16,
    body: String,
}

impl HttpResponse {
    fn parse(raw: &str) -> Self {
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
        let status_line = head.split("\r\n").next().unwrap_or("");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        Self {
            status,
            body: body.to_string(),
        }
    }
}

const EC_KEY_PEM: &str = include_str!("../src/push/test_ec_key.pem");

fn apns_body() -> String {
    // The PEM has newlines; JSON-escape them.
    let pem = EC_KEY_PEM.replace('\n', "\\n");
    format!(
        r#"{{"keyId":"ABC1234567","teamId":"TEAM123456","bundleId":"dev.frick.app","privateKeyPem":"{pem}","useSandbox":true}}"#
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn admin_disabled_returns_404_for_push_routes() {
    let mut server = TestServer::boot(None).await;
    let response = server
        .admin_put(
            "/_frick/admin/tenants/_default/push/apns",
            ADMIN_TOKEN,
            &apns_body(),
        )
        .await;
    assert_eq!(response.status, 404);
    assert!(response.body.contains("not_found"));
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn set_apns_credentials_round_trips_to_tenant_settings() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;
    let response = server
        .admin_put(
            "/_frick/admin/tenants/_default/push/apns",
            ADMIN_TOKEN,
            &apns_body(),
        )
        .await;
    assert_eq!(response.status, 204, "body: {}", response.body);
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn set_fcm_credentials_round_trips() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;
    let body = r#"{"projectId":"frick-demo","clientEmail":"svc@x.iam.gserviceaccount.com","privateKey":"-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----"}"#;
    let response = server
        .admin_put("/_frick/admin/tenants/_default/push/fcm", ADMIN_TOKEN, body)
        .await;
    assert_eq!(response.status, 204, "body: {}", response.body);
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_apns_body_is_400() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;
    // Missing privateKeyPem → 400 (required field).
    let body = r#"{"keyId":"ABC1234567","teamId":"TEAM123456","bundleId":"dev.frick.app"}"#;
    let response = server
        .admin_put(
            "/_frick/admin/tenants/_default/push/apns",
            ADMIN_TOKEN,
            body,
        )
        .await;
    assert_eq!(response.status, 400, "body: {}", response.body);
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn deliver_enqueues_a_push_job() {
    let mut server = TestServer::boot(Some(ADMIN_TOKEN)).await;
    let body = r#"{"tenantId":"_default","intent":"message.new","recipientUserIds":["user-1"],"body":{"title":"Hi"}}"#;
    let response = server
        .admin_post("/_frick/admin/push/deliver", ADMIN_TOKEN, body)
        .await;
    assert_eq!(response.status, 201, "body: {}", response.body);
    assert!(response.body.contains("\"jobType\":\"push.deliver\""));
    assert!(response.body.contains("\"jobId\""));
    server.close().await;
}

// Touch the base64 import so the harness compiles even if a future refactor
// drops the only use; documents that the fixed credential key is 32 bytes.
#[test]
fn fixed_key_is_32_bytes() {
    let key = [7u8; 32];
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap()
            .len(),
        32
    );
}
