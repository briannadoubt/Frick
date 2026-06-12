//! Integration tests for the DevTools / analytics inspect routes (FR-274):
//! `GET /_frick/inspect/devtools/events`, `.../events/:id`, `.../summary`, and
//! `GET /_frick/inspect/analytics/summary`.
//!
//! Boots a real server over a loopback socket with the public/auth/dataplane +
//! inspect routers merged (the same wiring `boot::listen` lands), seeds the
//! durable DevTools feed through the shared store, logs in for an inspect-tier
//! session, and asserts the wire shapes + the inspect auth/gating contract.

use std::sync::Arc;

use frick_protocol::FrickSchema;
use frick_server::config::load_frick_config;
use frick_server::http::{AppState, public_router};
use frick_server::routes::inspect::inspect_router;
use frick_server::{FrickConfig, create_frick_server, routes};
use frick_store::DevToolsEventInput;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

fn test_schema() -> FrickSchema {
    frick_protocol::foundation_schema()
}

struct TestServer {
    port: u16,
    state: AppState,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl TestServer {
    async fn boot() -> Self {
        let server = create_frick_server(test_config(), test_schema())
            .await
            .unwrap();
        let state: AppState = Arc::clone(&server.state);
        std::mem::forget(server);

        let router = public_router(Arc::clone(&state))
            .merge(frick_server::auth_routes::auth_router(Arc::clone(&state)))
            .merge(routes::dataplane_router(Arc::clone(&state)))
            .merge(inspect_router(Arc::clone(&state)));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let join = tokio::spawn(async move {
            let serve = axum::serve(listener, router);
            let _ = serve
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        Self {
            port,
            state,
            shutdown: Some(shutdown_tx),
            join: Some(join),
        }
    }

    /// Seed a row into the durable DevTools feed through the shared store.
    async fn seed_event(&self, input: DevToolsEventInput, now_ms: i64) {
        self.state
            .store
            .devtools_events()
            .record(&input, now_ms)
            .await;
    }

    async fn close(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }

    async fn login(&self, user_id: &str) -> String {
        let body = format!(r#"{{"userId":"{user_id}"}}"#);
        let response = self.request("POST", "/auth/dev-login", &[], &body).await;
        extract_json_string(&response.body, "sessionToken")
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

    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("body is not JSON ({e}): {}", self.body))
    }
}

fn extract_json_string(body: &str, key: &str) -> String {
    let needle = format!("\"{key}\":\"");
    let start = body.find(&needle).expect("key present") + needle.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}

fn input(kind: &str, tenant: Option<&str>, fields_json: Option<&str>) -> DevToolsEventInput {
    DevToolsEventInput {
        kind: kind.to_string(),
        tenant_id: tenant.map(str::to_string),
        fields_json: fields_json.map(str::to_string),
        occurred_at: None,
    }
}

/// `devtools/events` lists the feed newest-first with the camelCase wire shape,
/// and the `kind` filter narrows it.
#[tokio::test]
async fn devtools_events_lists_and_filters() {
    let mut server = TestServer::boot().await;
    server
        .seed_event(
            input("http.request", None, Some(r#"{"status":200}"#)),
            1_000,
        )
        .await;
    server
        .seed_event(
            input("job.failed", Some("t1"), Some(r#"{"errorCode":"boom"}"#)),
            2_000,
        )
        .await;
    let token = server.login("user-inspector").await;

    // Unfiltered: newest first.
    let response = server
        .request(
            "GET",
            "/_frick/inspect/devtools/events",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    let body = response.json();
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["kind"], serde_json::json!("job.failed"));
    assert_eq!(events[0]["tenantId"], serde_json::json!("t1"));
    assert_eq!(events[0]["fields"]["errorCode"], serde_json::json!("boom"));
    assert!(events[0]["id"].is_number());
    assert!(events[0]["occurredAt"].is_string());
    // A global event reports tenantId: null.
    assert_eq!(events[1]["kind"], serde_json::json!("http.request"));
    assert_eq!(events[1]["tenantId"], serde_json::Value::Null);

    // Filtered by kind.
    let filtered = server
        .request(
            "GET",
            "/_frick/inspect/devtools/events?kind=job.failed",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(filtered.status, 200);
    let filtered_events = filtered.json()["events"].as_array().unwrap().clone();
    assert_eq!(filtered_events.len(), 1);
    assert_eq!(filtered_events[0]["kind"], serde_json::json!("job.failed"));

    server.close().await;
}

/// `devtools/events/:id` drills into a single row; a bad/missing id is 404.
#[tokio::test]
async fn devtools_event_by_id_drills_in_and_404s() {
    let mut server = TestServer::boot().await;
    server
        .seed_event(input("http.request", None, Some(r#"{"path":"/x"}"#)), 1_000)
        .await;
    let token = server.login("user-inspector").await;

    let list = server
        .request(
            "GET",
            "/_frick/inspect/devtools/events",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    let id = list.json()["events"][0]["id"].as_i64().unwrap();

    let hit = server
        .request(
            "GET",
            &format!("/_frick/inspect/devtools/events/{id}"),
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(hit.status, 200, "body: {}", hit.body);
    assert_eq!(hit.json()["event"]["id"], serde_json::json!(id));
    assert_eq!(
        hit.json()["event"]["fields"]["path"],
        serde_json::json!("/x")
    );

    // Missing id → 404.
    let miss = server
        .request(
            "GET",
            "/_frick/inspect/devtools/events/999999",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(miss.status, 404, "body: {}", miss.body);

    server.close().await;
}

/// `devtools/summary` aggregates by kind over the rolling window.
#[tokio::test]
async fn devtools_summary_aggregates_by_kind() {
    let mut server = TestServer::boot().await;
    let now = current_ms();
    server
        .seed_event(input("http.request", None, None), now)
        .await;
    server
        .seed_event(input("http.request", None, None), now)
        .await;
    server
        .seed_event(input("job.failed", None, None), now)
        .await;
    let token = server.login("user-inspector").await;

    let response = server
        .request(
            "GET",
            "/_frick/inspect/devtools/summary?windowMs=3600000",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    let body = response.json();
    assert_eq!(body["windowMs"], serde_json::json!(3_600_000));
    assert_eq!(body["total"], serde_json::json!(3));
    assert_eq!(body["byKind"]["http.request"], serde_json::json!(2));
    assert_eq!(body["byKind"]["job.failed"], serde_json::json!(1));

    server.close().await;
}

/// `analytics/summary` returns a well-formed empty admin-scoped summary (the
/// read model is empty until the analytics worker lands).
#[tokio::test]
async fn analytics_summary_returns_empty_admin_summary() {
    let mut server = TestServer::boot().await;
    let token = server.login("user-inspector").await;

    let response = server
        .request(
            "GET",
            "/_frick/inspect/analytics/summary",
            &[("Authorization", &bearer(&token))],
            "",
        )
        .await;
    assert_eq!(response.status, 200, "body: {}", response.body);
    let body = response.json();
    assert_eq!(body["family"], serde_json::json!("analytics.user_event"));
    assert_eq!(body["scope"]["kind"], serde_json::json!("admin"));
    assert_eq!(body["totals"]["events"], serde_json::json!(0));
    assert!(body["topEvents"].is_array());
    assert!(body["recentEvents"].is_array());
    assert!(body["generatedAt"].is_string());
    assert!(body["since"].is_string());

    server.close().await;
}

/// The DevTools routes are gated by the inspect-tier auth like their siblings:
/// no bearer → 401.
#[tokio::test]
async fn devtools_routes_require_auth() {
    let mut server = TestServer::boot().await;
    for path in [
        "/_frick/inspect/devtools/events",
        "/_frick/inspect/devtools/summary",
        "/_frick/inspect/devtools/events/1",
        "/_frick/inspect/analytics/summary",
    ] {
        let unauth = server.request("GET", path, &[], "").await;
        assert_eq!(unauth.status, 401, "{path} body: {}", unauth.body);
    }
    server.close().await;
}

fn current_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
    {
        dur.as_millis() as i64
    }
}
